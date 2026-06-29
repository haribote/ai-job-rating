// 企業の名寄せストレージ層（companies テーブルの CRUD と求人紐付け・要件 §6 / §7.2 / #32）。
//
// なぜこのモジュールが存在するか:
// - 決定的な名寄せキー（companyKey）で企業を一意化して D1 へ永続化し、後続 #33（reputation の
//   企業単位キャッシュ）が companies.id を企業キーとして消費できるようにする。
// - 名寄せ正規化（純関数）と法人番号 API（アダプタ）を結線し、求人 1 件を企業へ紐付ける高レベル
//   経路 resolveCompanyForJob を提供する。API 失敗・該当なしは中立（null/未紐付け）に倒し、
//   companyKey 無しで求人処理をブロックしない（unknown 中立 §5.2）。
// - 責務はストレージ往復＋名寄せ結線のみ。取得・抽出・スコアリングには踏み込まない（§9）。

import { isUnknownRaw } from "../../shared/job-schema";
import type { CorporateNumberClient } from "../companies/houjin-bangou";
import { companyKey, normalizeCompanyName } from "../companies/normalize";
import { type CompanyRow, TABLE_NAMES } from "./db-schema";

// 採番・時刻の注入点。ユニットテストを決定的にする（ingest.ts の流儀に倣う）。
export interface CompaniesStoreOptions {
	// 既定は crypto.randomUUID。companies.id の採番に使う。
	newId?: () => string;
	// 既定は現在 unix 秒。created_at / updated_at に使う。
	now?: () => number;
}

// upsertCompany の入力。houjinBangou は取得できた場合のみ（任意）。
export interface UpsertCompanyInput {
	name: string;
	houjinBangou?: string | null;
}

// 名寄せストレージ層の失敗分類（raw-html-store.ts の流儀に倣う）。
export type CompaniesStoreErrorKind = "not_found";

export class CompaniesStoreError extends Error {
	readonly kind: CompaniesStoreErrorKind;

	constructor(args: { kind: CompaniesStoreErrorKind; message: string }) {
		super(args.message);
		this.name = "CompaniesStoreError";
		this.kind = args.kind;
	}
}

function resolveDeps(opts: CompaniesStoreOptions = {}) {
	return {
		newId: opts.newId ?? (() => crypto.randomUUID()),
		now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
	};
}

// id で企業を引く。
export async function getCompanyById(
	db: D1Database,
	id: string,
): Promise<CompanyRow | null> {
	return (
		(await db
			.prepare(`SELECT * FROM ${TABLE_NAMES.companies} WHERE id = ?`)
			.bind(id)
			.first<CompanyRow>()) ?? null
	);
}

// 名寄せキーで企業を引く（非ユニーク。法人番号判明済み行も含むため決定的に 1 行へ畳む）。
// 主に検査・テスト用。upsert の未判明バケット照合は getCompanyByKeyUnidentified を使う。
export async function getCompanyByKey(
	db: D1Database,
	key: string,
): Promise<CompanyRow | null> {
	return (
		(await db
			.prepare(
				`SELECT * FROM ${TABLE_NAMES.companies}
				 WHERE company_key = ? ORDER BY created_at, id LIMIT 1`,
			)
			.bind(key)
			.first<CompanyRow>()) ?? null
	);
}

// 法人番号未判明（houjin_bangou IS NULL）の名寄せバケットを引く。同名別法人は法人番号判明時に
// 別行へ分かれるため、未判明同士のみここで一意化する（partial unique index と対応）。
async function getCompanyByKeyUnidentified(
	db: D1Database,
	key: string,
): Promise<CompanyRow | null> {
	return (
		(await db
			.prepare(
				`SELECT * FROM ${TABLE_NAMES.companies}
				 WHERE company_key = ? AND houjin_bangou IS NULL`,
			)
			.bind(key)
			.first<CompanyRow>()) ?? null
	);
}

// 法人番号で企業を引く（最強の一意化シグナル）。
async function getCompanyByHoujin(
	db: D1Database,
	houjinBangou: string,
): Promise<CompanyRow | null> {
	return (
		(await db
			.prepare(`SELECT * FROM ${TABLE_NAMES.companies} WHERE houjin_bangou = ?`)
			.bind(houjinBangou)
			.first<CompanyRow>()) ?? null
	);
}

// 企業を upsert する。一意化は法人番号を最強シグナルとする:
// - 法人番号判明時: 同番号があれば再利用。無ければ「未判明同名バケット」へバックフィル（=その企業の
//   法人番号を今知った）。それも無ければ新規。→ 同名でも法人番号が違えば別企業として別行になる。
// - 法人番号未判明時: 未判明同名バケットがあれば再利用、無ければ新規（判明済み同名行へは併合しない）。
export async function upsertCompany(
	db: D1Database,
	input: UpsertCompanyInput,
	opts: CompaniesStoreOptions = {},
): Promise<CompanyRow> {
	const { newId, now } = resolveDeps(opts);
	const name = normalizeCompanyName(input.name);
	const key = companyKey(input.name);
	const houjinBangou = input.houjinBangou ?? null;

	if (houjinBangou !== null) {
		// 1. 同一法人番号は表記が違っても同一企業。
		const byHoujin = await getCompanyByHoujin(db, houjinBangou);
		if (byHoujin !== null) {
			return byHoujin;
		}
		// 2. 未判明同名バケットがあれば、その企業の法人番号を今知ったとみなしバックフィルする。
		const unidentified = await getCompanyByKeyUnidentified(db, key);
		if (unidentified !== null) {
			const ts = now();
			await db
				.prepare(
					`UPDATE ${TABLE_NAMES.companies} SET houjin_bangou = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(houjinBangou, ts, unidentified.id)
				.run();
			return { ...unidentified, houjin_bangou: houjinBangou, updated_at: ts };
		}
	} else {
		// 1'. 法人番号未判明同士は名寄せキーで一意化する（判明済み同名行へは併合しない）。
		const unidentified = await getCompanyByKeyUnidentified(db, key);
		if (unidentified !== null) {
			return unidentified;
		}
	}

	// 3. 新規作成。
	const id = newId();
	const ts = now();
	await db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.companies}
			 (id, name, company_key, houjin_bangou, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, name, key, houjinBangou, ts, ts)
		.run();
	return {
		id,
		name,
		company_key: key,
		houjin_bangou: houjinBangou,
		created_at: ts,
		updated_at: ts,
	};
}

// 求人 1 件を企業へ紐付ける（jobs.company_id を更新）。
// 対象 job が無ければ not_found を投げ、0 行更新を黙認しない（raw-html-store.ts に倣う）。
export async function linkJobToCompany(
	db: D1Database,
	jobId: string,
	companyId: string,
): Promise<void> {
	const { meta } = await db
		.prepare(`UPDATE ${TABLE_NAMES.jobs} SET company_id = ? WHERE id = ?`)
		.bind(companyId, jobId)
		.run();
	if (meta.changes === 0) {
		throw new CompaniesStoreError({
			kind: "not_found",
			message: `job not found for company link: ${jobId}`,
		});
	}
}

// 求人の企業名を名寄せ→（任意で法人番号 enrich）→ upsert→ 求人紐付け まで結線する高レベル経路。
// 企業名が空・unknown 表記なら企業を作らず null（中立）を返す。法人番号 API は best-effort で、
// 名寄せキーが厳密一致する候補のみ採用する（name 検索の部分一致による誤紐付けを防ぐ）。
export async function resolveCompanyForJob(
	db: D1Database,
	jobId: string,
	rawName: string,
	client: CorporateNumberClient,
	opts: CompaniesStoreOptions = {},
): Promise<CompanyRow | null> {
	// 企業名が取れない求人は中立扱い（companyKey 無しでブロックしない・§5.2）。
	if (isUnknownRaw(rawName)) {
		return null;
	}
	const name = normalizeCompanyName(rawName);
	const key = companyKey(rawName);

	// 名寄せキー厳密一致の候補だけ法人番号を採用する（誤紐付け防止）。
	let houjinBangou: string | null = null;
	for (const candidate of await client.lookupByName(name)) {
		if (companyKey(candidate.name) === key) {
			houjinBangou = candidate.corporateNumber;
			break;
		}
	}

	const company = await upsertCompany(db, { name, houjinBangou }, opts);
	await linkJobToCompany(db, jobId, company.id);
	return company;
}
