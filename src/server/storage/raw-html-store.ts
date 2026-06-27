// 生 HTML 等を R2 に保存し jobs.raw_html_r2_key で抽出結果に紐付ける保存層（要件 §6 / #16→#17）。
//
// 責務はストレージ往復のみ: R2 への put/get・キー生成・jobs 行への紐付け・エラー分類に限定し、
// 取得（#21）・トリミング（#9）・抽出（#11）・スコアリング（#20）には踏み込まない（責務分離 §9）。
// R2 binding・D1 binding は引数注入し、ローカル R2（miniflare）でユニットテスト可能にする。

import { TABLE_NAMES } from "./db-schema";

// R2Bucket の最小契約。テストで差し替えられるよう put/get のみに依存する（env.RAW_HTML は構造的に適合する）。
export interface RawHtmlBucket {
	put(
		key: string,
		value: string,
		options?: R2PutOptions,
	): Promise<R2Object | null>;
	get(key: string): Promise<R2ObjectBody | null>;
}

// jobs.raw_html_r2_key を更新できる D1 の最小契約。テストで差し替え可能にする（env.DB が適合する）。
export interface RawHtmlDb {
	prepare(query: string): D1PreparedStatement;
}

// put 時に併せて残すメタデータ。キーから求人を追跡できるよう取得元 URL を customMetadata に置く。
export interface PutRawHtmlMetadata {
	sourceUrl?: string;
}

// 生 HTML の MIME。後段（再取得・デバッグ）が誤判定しないよう保存時に固定する。
const RAW_HTML_CONTENT_TYPE = "text/html; charset=utf-8";

// 保存層の失敗分類。呼び出し側が分岐できるよう種別を型で表現する（fetch-html.ts の流儀に倣う）。
export type RawHtmlStoreErrorKind = "validation" | "put_failed" | "not_found";

// 保存層の失敗を表す例外。種別とキー（あれば）を保持する。
export class RawHtmlStoreError extends Error {
	readonly kind: RawHtmlStoreErrorKind;
	readonly key?: string;

	constructor(args: {
		kind: RawHtmlStoreErrorKind;
		message: string;
		key?: string;
		cause?: unknown;
	}) {
		super(args.message, { cause: args.cause });
		this.name = "RawHtmlStoreError";
		this.kind = args.kind;
		this.key = args.key;
	}
}

// job id から R2 オブジェクトキーを決定的に導く。
// 形式 jobs/{id}/raw.html: id を含むため衝突せず追跡可能で、拡張子で種別を示す。
// 同一 id なら同一キー（決定的）を保証し、再 put が同じオブジェクトを上書きするようにする。
export function rawHtmlKey(jobId: string): string {
	if (jobId.trim() === "") {
		throw new RawHtmlStoreError({
			kind: "validation",
			message: "jobId must not be empty",
		});
	}
	return `${TABLE_NAMES.jobs}/${jobId}/raw.html`;
}

// 保存結果。返したキーが jobs 紐付け（linkRawHtmlToJob）の入力になる。
export interface PutRawHtmlResult {
	key: string;
	size: number;
}

// 生 HTML を R2 へ保存し、決定的キーとサイズを返す。
// 取得元 URL は customMetadata に残し、MIME を text/html に固定する。
export async function putRawHtml(
	bucket: RawHtmlBucket,
	jobId: string,
	html: string,
	metadata: PutRawHtmlMetadata = {},
): Promise<PutRawHtmlResult> {
	const key = rawHtmlKey(jobId);
	const object = await bucket.put(key, html, {
		httpMetadata: { contentType: RAW_HTML_CONTENT_TYPE },
		// undefined を customMetadata に混ぜないよう sourceUrl がある時だけ載せる。
		customMetadata: metadata.sourceUrl
			? { sourceUrl: metadata.sourceUrl }
			: undefined,
	});
	// put(onlyIf 無し) は通常 R2Object を返す。null は保存が成立しなかった異常系として扱う。
	if (object === null) {
		throw new RawHtmlStoreError({
			kind: "put_failed",
			message: `R2 put returned null for key: ${key}`,
			key,
		});
	}
	return { key, size: object.size };
}

// キーから生 HTML を読み戻す。未保存は例外でなく null（不在）で表す。
export async function getRawHtml(
	bucket: RawHtmlBucket,
	key: string,
): Promise<string | null> {
	const object = await bucket.get(key);
	if (object === null) {
		return null;
	}
	return object.text();
}

// 保存済みキーを jobs.raw_html_r2_key へ書き込み、抽出結果と紐付ける（#16→#17）。
// 対象 job が存在しなければ not_found を投げ、0 行更新を黙認しない。
export async function linkRawHtmlToJob(
	db: RawHtmlDb,
	jobId: string,
	key: string,
): Promise<void> {
	const { meta } = await db
		.prepare(`UPDATE ${TABLE_NAMES.jobs} SET raw_html_r2_key = ? WHERE id = ?`)
		.bind(key, jobId)
		.run();
	if (meta.changes === 0) {
		throw new RawHtmlStoreError({
			kind: "not_found",
			message: `job not found for raw_html link: ${jobId}`,
			key,
		});
	}
}
