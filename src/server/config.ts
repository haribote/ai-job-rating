// 評価条件（重み・希望値・ハードフィルタ）の取得・更新 API ロジック（#95 Task 2）。
//
// なぜこのモジュールが存在するか:
// - 旧 criteria-form の SSR フォームを撤去し、設定の入出力を JSON 契約へ縮約する（責務は設定 I/O のみ・§9）。
// - PUT は保存後に決定的な rescoreAll を呼んで全 job を即再ランキングする。AI は再実行しない
//   （抽出とスコアリングの分離 §5.3 / ガードレール）。
// - フォーム値ではなく構造化 JSON（items: CriteriaConfigInput[]）を受け、kind ごとの希望値の意味は
//   criteria-config.ts の NORMALIZED_KEY_KINDS を単一ソースとして解釈する（ラベル正規化 §5.2）。

import { NORMALIZED_KEYS, type NormalizedKey } from "../shared/job-schema";
import { NORMALIZED_KEY_KINDS } from "./scoring/criteria-config";
import { readCriteriaConfig, rescoreAll } from "./scoring/rescore";
import {
	type CriteriaConfigRow,
	type HardFilter,
	TABLE_NAMES,
} from "./storage/db-schema";

// ---------------------------------------------------------------------------
// 入出力の型（client が消費する JSON 契約）
// ---------------------------------------------------------------------------

const HARD_FILTERS: readonly HardFilter[] = ["none", "required", "exclude"];

// 設定 1 項目の更新入力。desired は kind 依存（numericRange/categorical/aiJudged）の構造化値。
export interface CriteriaConfigInput {
	criterion: string;
	weight: number;
	hardFilter: HardFilter;
	// numericRange: { desired:number, floor?|ceil? } / categorical: { preferred:string[] } /
	// aiJudged: { skills:string[] }。未指定・null は希望値なし（評価不能 = 中立 §5.2）。
	desired?: unknown;
}

// 設定 1 項目の取得出力。全正規キーぶん返す（未保存キーは既定 weight=1 / hardFilter=none）。
export interface CriteriaConfigItem {
	criterion: NormalizedKey;
	kind: "numericRange" | "categorical" | "aiJudged";
	weight: number;
	hardFilter: HardFilter;
	desired: unknown;
}

// ---------------------------------------------------------------------------
// 決定的バリデーション・変換（純関数・ユニットテスト対象）
// ---------------------------------------------------------------------------

// 重みの決定的バリデーション。非負の有限数のみ受理する（weight>=0 ガードレール §5.2）。
export function parseWeight(
	raw: unknown,
): { ok: true; value: number } | { ok: false } {
	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(value) || value < 0) return { ok: false };
	return { ok: true, value };
}

// numericRange の希望値を desired_value JSON へ詰める。direction に応じて反対端（floor|ceil）のみ採用する。
// desired 未入力・非数は評価不能とみなし null（unknown 中立 §5.2）。
function numericDesiredJson(
	desired: unknown,
	direction: "higherBetter" | "lowerBetter",
): string | null {
	if (typeof desired !== "object" || desired === null) return null;
	const o = desired as Record<string, unknown>;
	if (typeof o.desired !== "number" || !Number.isFinite(o.desired)) return null;
	const boundKey = direction === "higherBetter" ? "floor" : "ceil";
	const payload: Record<string, number> = { desired: o.desired };
	const bound = o[boundKey];
	if (typeof bound === "number" && Number.isFinite(bound)) {
		payload[boundKey] = bound;
	}
	return JSON.stringify(payload);
}

// categorical の希望集合を desired_value JSON へ詰める。空集合・非配列は null（中立）。
function categoricalDesiredJson(desired: unknown): string | null {
	if (typeof desired !== "object" || desired === null) return null;
	const preferred = (desired as Record<string, unknown>).preferred;
	if (!Array.isArray(preferred)) return null;
	const list = preferred
		.filter((p): p is string => typeof p === "string")
		.map((p) => p.trim())
		.filter((p) => p !== "");
	if (list.length === 0) return null;
	return JSON.stringify({ preferred: list });
}

// aiJudged の希望スキル集合を desired_value JSON へ詰める（#68 拡張点）。空集合・非配列は null。
function aiJudgedDesiredJson(desired: unknown): string | null {
	if (typeof desired !== "object" || desired === null) return null;
	const skills = (desired as Record<string, unknown>).skills;
	if (!Array.isArray(skills)) return null;
	const list = skills
		.filter((s): s is string => typeof s === "string")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (list.length === 0) return null;
	return JSON.stringify({ skills: list });
}

// 設定入力群を criteria_config 行へ変換する（決定的）。
// 不正な criterion / weight / hard_filter は全体を拒否し、保存・再スコアへ進ませない（AI/再スコアの前に弾く）。
export function inputsToConfigRows(
	items: readonly CriteriaConfigInput[],
):
	| { ok: true; rows: CriteriaConfigRow[] }
	| { ok: false; reason: "criterion" | "weight" | "hard_filter" } {
	const validKeys = new Set<string>(NORMALIZED_KEYS);
	const rows: CriteriaConfigRow[] = [];
	for (const item of items) {
		if (!validKeys.has(item.criterion))
			return { ok: false, reason: "criterion" };
		const key = item.criterion as NormalizedKey;

		const weight = parseWeight(item.weight);
		if (!weight.ok) return { ok: false, reason: "weight" };

		if (!(HARD_FILTERS as readonly string[]).includes(item.hardFilter)) {
			return { ok: false, reason: "hard_filter" };
		}

		const keyKind = NORMALIZED_KEY_KINDS[key];
		let desiredValue: string | null = null;
		switch (keyKind.kind) {
			case "numericRange":
				desiredValue = numericDesiredJson(item.desired, keyKind.direction);
				break;
			case "categorical":
				desiredValue = categoricalDesiredJson(item.desired);
				break;
			case "aiJudged":
				desiredValue = aiJudgedDesiredJson(item.desired);
				break;
		}

		rows.push({
			criterion: key,
			desired_value: desiredValue,
			weight: weight.value,
			hard_filter: item.hardFilter,
			// updated_at は DB 既定（unixepoch()）に委ねるため保存時は無視される。
			updated_at: 0,
		});
	}
	return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// 取得（GET /api/config）: 全正規キーぶんの現行設定を返す
// ---------------------------------------------------------------------------

// desired_value(JSON 文字列|null) を構造化値へ復元する（不正・null は null）。
function parseDesired(raw: string | null): unknown {
	if (raw == null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// 全正規キーの設定項目を返す。未保存キーは既定（weight=1 / hardFilter=none / desired=null）で埋める。
export async function readConfigItems(
	db: D1Database,
): Promise<CriteriaConfigItem[]> {
	const rows = await readCriteriaConfig(db);
	const byKey = new Map(rows.map((r) => [r.criterion, r]));
	return NORMALIZED_KEYS.map((key) => {
		const row = byKey.get(key);
		return {
			criterion: key,
			kind: NORMALIZED_KEY_KINDS[key].kind,
			weight: row?.weight ?? 1,
			hardFilter: row?.hard_filter ?? "none",
			desired: parseDesired(row?.desired_value ?? null),
		};
	});
}

// ---------------------------------------------------------------------------
// 更新（PUT /api/config）: 保存 → 即再スコア（AI 非再実行）
// ---------------------------------------------------------------------------

// criteria_config 行群を upsert する（criterion を PK に冪等上書き）。updated_at は DB 既定に委ねる。
export async function upsertConfigRows(
	db: D1Database,
	rows: readonly CriteriaConfigRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const stmt = db.prepare(
		`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES (?, ?, ?, ?)
		 ON CONFLICT(criterion) DO UPDATE SET
		   desired_value = excluded.desired_value,
		   weight = excluded.weight,
		   hard_filter = excluded.hard_filter,
		   updated_at = unixepoch()`,
	);
	await db.batch(
		rows.map((r) =>
			stmt.bind(r.criterion, r.desired_value, r.weight, r.hard_filter),
		),
	);
}

// 設定を保存し、保存済み抽出のまま全 job を即再スコアする（AI 非実行・§5.3）。再スコア件数を返す。
export async function saveConfigAndRescore(
	db: D1Database,
	rows: readonly CriteriaConfigRow[],
): Promise<number> {
	await upsertConfigRows(db, rows);
	// 設定変更のトリガで決定的に全 job を再スコアリングする（#20）。AI は呼ばない。
	const rescored = await rescoreAll(db);
	return rescored.length;
}
