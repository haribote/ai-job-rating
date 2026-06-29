// 企業評判のストレージ層（reputation_snapshots / reputation_sources の read/write・要件 §6 / §7.2 / #33）。
//
// なぜこのモジュールが存在するか:
// - 評判は求人単位でなく企業単位の属性（§7.2）。companies.id（#32）をキーに評判スナップショットを
//   企業単位でキャッシュし、同一企業の全求人で再利用できるようにする。
// - スナップショットは append-only（extractions の流儀）。「企業（＋取得元）ごとの最新」を fetched_at で
//   引く読み出し経路を提供し、過去スナップショットは破壊しない（監査・再現性 §8）。
// - unknown 中立（§5.2）: 値が取れない項目を NULL で保持し、行が無い「未取得」と区別する。分母除外の判断は
//   スコア層（#36）に委ねる。鮮度判定（キャッシュヒット可否）の純関数だけここに置く。
// - 責務はストレージ往復のみ。評判の取得（#30）・スコア合算（#36）・設定 UI（#34）には踏み込まない（§9）。

import {
	type ReputationFetchMethod,
	type ReputationSnapshotRow,
	type ReputationSourceRow,
	TABLE_NAMES,
} from "./db-schema";

// 採番・時刻の注入点。ユニットテストを決定的にする（companies-store.ts の流儀に倣う）。
export interface ReputationStoreOptions {
	// 既定は crypto.randomUUID。各行の id 採番に使う。
	newId?: () => string;
	// 既定は現在 unix 秒。fetched_at / created_at / updated_at に使う。
	now?: () => number;
}

// 評判ストレージ層の失敗分類（raw-html-store.ts / companies-store.ts の流儀に倣う）。
export type ReputationStoreErrorKind = "not_found";

export class ReputationStoreError extends Error {
	readonly kind: ReputationStoreErrorKind;

	constructor(args: { kind: ReputationStoreErrorKind; message: string }) {
		super(args.message);
		this.name = "ReputationStoreError";
		this.kind = args.kind;
	}
}

function resolveDeps(opts: ReputationStoreOptions = {}) {
	return {
		newId: opts.newId ?? (() => crypto.randomUUID()),
		now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
	};
}

// ---------------------------------------------------------------------------
// reputation_snapshots（企業単位キャッシュ）
// ---------------------------------------------------------------------------

// スナップショット保存の入力。スコア・件数・サブ項目は取得できなければ NULL（unknown 中立・§5.2）。
// subScores はオブジェクトで受け、JSON 文字列へ直列化して保存する（解釈はスコア層 #36）。
export interface SaveReputationSnapshotInput {
	companyId: string;
	source: string;
	overallScore?: number | null;
	reviewCount?: number | null;
	subScores?: unknown;
}

// 企業の評判スナップショットを 1 件追記する（append-only）。
// FK の不整合をランタイムエラーでなく明示的な not_found で返すため、企業の存在を先に確認する。
export async function saveReputationSnapshot(
	db: D1Database,
	input: SaveReputationSnapshotInput,
	opts: ReputationStoreOptions = {},
): Promise<ReputationSnapshotRow> {
	const { newId, now } = resolveDeps(opts);
	await assertCompanyExists(db, input.companyId);

	const id = newId();
	const ts = now();
	const overallScore = input.overallScore ?? null;
	const reviewCount = input.reviewCount ?? null;
	// undefined は「サブ項目を持たない」を意味し NULL を保存する（空オブジェクト等は呼び出し側の意図として直列化）。
	const subScoresJson =
		input.subScores === undefined || input.subScores === null
			? null
			: JSON.stringify(input.subScores);

	await db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.reputationSnapshots}
			 (id, company_id, source, overall_score, review_count, sub_scores_json, fetched_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.companyId,
			input.source,
			overallScore,
			reviewCount,
			subScoresJson,
			ts,
			ts,
		)
		.run();

	return {
		id,
		company_id: input.companyId,
		source: input.source,
		overall_score: overallScore,
		review_count: reviewCount,
		sub_scores_json: subScoresJson,
		fetched_at: ts,
		created_at: ts,
	};
}

// 企業（任意で取得元を指定）の最新スナップショットを引く。企業単位キャッシュの主たる読み出し経路。
// fetched_at 降順・同時刻は id 降順で決定的に 1 行へ畳む。未取得なら null。
export async function getLatestReputationSnapshot(
	db: D1Database,
	companyId: string,
	source?: string,
): Promise<ReputationSnapshotRow | null> {
	const sourceFilter = source === undefined ? "" : "AND source = ?";
	const stmt = db.prepare(
		`SELECT * FROM ${TABLE_NAMES.reputationSnapshots}
		 WHERE company_id = ? ${sourceFilter}
		 ORDER BY fetched_at DESC, id DESC LIMIT 1`,
	);
	const bound =
		source === undefined ? stmt.bind(companyId) : stmt.bind(companyId, source);
	return (await bound.first<ReputationSnapshotRow>()) ?? null;
}

// 企業の取得元ごとの最新スナップショットを一覧する（スコア層 #36 が全取得元を合算するための読み出し経路）。
// ROW_NUMBER で取得元ごとに最新 1 件へ畳み、source 昇順で決定的に返す。
export async function listLatestReputationSnapshots(
	db: D1Database,
	companyId: string,
): Promise<ReputationSnapshotRow[]> {
	const { results } = await db
		.prepare(
			`SELECT id, company_id, source, overall_score, review_count, sub_scores_json, fetched_at, created_at
			 FROM (
			   SELECT *, ROW_NUMBER() OVER (
			     PARTITION BY source ORDER BY fetched_at DESC, id DESC
			   ) AS rn
			   FROM ${TABLE_NAMES.reputationSnapshots}
			   WHERE company_id = ?
			 )
			 WHERE rn = 1
			 ORDER BY source`,
		)
		.bind(companyId)
		.all<ReputationSnapshotRow>();
	return results;
}

// スナップショットがキャッシュとして新鮮かを判定する純関数（決定的）。
// fetched_at から maxAgeSeconds 以内なら有効（キャッシュヒット）。取得側（#30）が再問い合わせ要否に使う。
export function isReputationSnapshotFresh(
	snapshot: Pick<ReputationSnapshotRow, "fetched_at">,
	maxAgeSeconds: number,
	now: number,
): boolean {
	return now - snapshot.fetched_at <= maxAgeSeconds;
}

// ---------------------------------------------------------------------------
// reputation_sources（取得元設定）
// ---------------------------------------------------------------------------

// 取得元設定の upsert 入力。name を一意キーに更新/新規する。
export interface UpsertReputationSourceInput {
	name: string;
	identifier?: string | null;
	fetchMethod: ReputationFetchMethod;
	priority?: number;
	enabled?: boolean;
}

// 取得元設定を upsert する（name で一意化）。既存があればフィールドを更新し、無ければ新規作成する。
export async function upsertReputationSource(
	db: D1Database,
	input: UpsertReputationSourceInput,
	opts: ReputationStoreOptions = {},
): Promise<ReputationSourceRow> {
	const { newId, now } = resolveDeps(opts);
	const identifier = input.identifier ?? null;
	const priority = input.priority ?? 0;
	const enabled: 0 | 1 = (input.enabled ?? true) ? 1 : 0;

	const existing = await getReputationSourceByName(db, input.name);
	const ts = now();
	if (existing !== null) {
		await db
			.prepare(
				`UPDATE ${TABLE_NAMES.reputationSources}
				 SET identifier = ?, fetch_method = ?, priority = ?, enabled = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.bind(identifier, input.fetchMethod, priority, enabled, ts, existing.id)
			.run();
		return {
			...existing,
			identifier,
			fetch_method: input.fetchMethod,
			priority,
			enabled,
			updated_at: ts,
		};
	}

	const id = newId();
	await db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.reputationSources}
			 (id, name, identifier, fetch_method, priority, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.name,
			identifier,
			input.fetchMethod,
			priority,
			enabled,
			ts,
			ts,
		)
		.run();
	return {
		id,
		name: input.name,
		identifier,
		fetch_method: input.fetchMethod,
		priority,
		enabled,
		created_at: ts,
		updated_at: ts,
	};
}

// id で取得元設定を引く。
export async function getReputationSourceById(
	db: D1Database,
	id: string,
): Promise<ReputationSourceRow | null> {
	return (
		(await db
			.prepare(`SELECT * FROM ${TABLE_NAMES.reputationSources} WHERE id = ?`)
			.bind(id)
			.first<ReputationSourceRow>()) ?? null
	);
}

// name で取得元設定を引く（一意・upsert の照合に使う）。
export async function getReputationSourceByName(
	db: D1Database,
	name: string,
): Promise<ReputationSourceRow | null> {
	return (
		(await db
			.prepare(`SELECT * FROM ${TABLE_NAMES.reputationSources} WHERE name = ?`)
			.bind(name)
			.first<ReputationSourceRow>()) ?? null
	);
}

// 取得元設定を優先順位順に一覧する（priority 昇順・同値は name 昇順で決定的）。
// enabledOnly=true で有効な取得元のみ（#30 の取得対象）。既定は全件（#34 の設定画面）。
export async function listReputationSources(
	db: D1Database,
	opts: { enabledOnly?: boolean } = {},
): Promise<ReputationSourceRow[]> {
	const where = opts.enabledOnly ? "WHERE enabled = 1" : "";
	const { results } = await db
		.prepare(
			`SELECT * FROM ${TABLE_NAMES.reputationSources}
			 ${where}
			 ORDER BY priority, name`,
		)
		.all<ReputationSourceRow>();
	return results;
}

// 取得元設定を削除する。対象が無ければ not_found を投げ、0 行削除を黙認しない（companies-store.ts に倣う）。
export async function deleteReputationSource(
	db: D1Database,
	id: string,
): Promise<void> {
	const { meta } = await db
		.prepare(`DELETE FROM ${TABLE_NAMES.reputationSources} WHERE id = ?`)
		.bind(id)
		.run();
	if (meta.changes === 0) {
		throw new ReputationStoreError({
			kind: "not_found",
			message: `reputation source not found: ${id}`,
		});
	}
}

// 企業の存在を確認する。スナップショットの FK 不整合を明示的な not_found に変換するための内部ヘルパ。
async function assertCompanyExists(
	db: D1Database,
	companyId: string,
): Promise<void> {
	const row = await db
		.prepare(`SELECT id FROM ${TABLE_NAMES.companies} WHERE id = ?`)
		.bind(companyId)
		.first<{ id: string }>();
	if (row === null) {
		throw new ReputationStoreError({
			kind: "not_found",
			message: `company not found for reputation snapshot: ${companyId}`,
		});
	}
}
