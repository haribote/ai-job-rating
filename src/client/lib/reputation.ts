// 企業評判 取得元設定（reputation_sources）の client 契約と API 呼び出し（#34）。
//
// なぜ存在するか:
// - 取得元設定の CRUD（GET/PUT/DELETE /api/reputation/sources）を薄いラッパに閉じ、UI（ReputationSourcesForm）
//   から fetch の細部や契約のエラー形を切り離す（criteria.ts / api.ts の流儀に倣う・§9）。
// - 設計ガードレール（フォーク容易性・抽出↔スコア分離）は API 側の責務。本モジュールは契約を消費するだけで
//   再実装しない。設定変更は決定的・AI 非再実行（§5.3）。

import type { ApiClient } from "./api";
import { apiDelete, apiGet, apiPut } from "./api";

// 取得方式（§7.2・サーバ ReputationFetchMethod と整合）。server は別バンドルのため client 側で再定義する。
export type ReputationFetchMethod = "web_search" | "url_html" | "manual";

// GET /api/reputation/sources の 1 行（サーバ ReputationSourceRow と整合・snake_case）。
// enabled は SQLite に boolean 型が無いため 0/1 で返る。
export interface ReputationSource {
	readonly id: string;
	readonly name: string;
	readonly identifier: string | null;
	readonly fetch_method: ReputationFetchMethod;
	readonly priority: number;
	readonly enabled: 0 | 1;
	readonly created_at: number;
	readonly updated_at: number;
}

// PUT /api/reputation/sources の入力（camelCase・サーバ parseReputationSourceInput と整合）。
export interface ReputationSourceInput {
	readonly name: string;
	readonly identifier?: string | null;
	readonly fetchMethod: ReputationFetchMethod;
	readonly priority?: number;
	readonly enabled?: boolean;
}

// 取得方式の表示メタ（UI の select 用）。閉集合はサーバ REPUTATION_FETCH_METHODS が単一ソース。
export const FETCH_METHOD_OPTIONS: readonly {
	readonly value: ReputationFetchMethod;
	readonly label: string;
}[] = [
	{ value: "web_search", label: "Web 検索（主軸）" },
	{ value: "url_html", label: "URL/HTML 投入" },
	{ value: "manual", label: "手動入力" },
];

// ---------------------------------------------------------------------------
// API 呼び出し（薄いラッパ。fetch は api クライアント経由で注入可能）
// ---------------------------------------------------------------------------

interface SourcesResponse {
	readonly sources: ReputationSource[];
}

interface SourceResponse {
	readonly source: ReputationSource;
}

export async function fetchReputationSources(
	get: ApiClient["get"] = apiGet,
): Promise<ReputationSource[]> {
	const res = await get<SourcesResponse>("/reputation/sources");
	return res.sources;
}

// 取得元を upsert する（name 一意）。priority/enabled を含む。保存後の行を返す。
export async function saveReputationSource(
	input: ReputationSourceInput,
	put: ApiClient["put"] = apiPut,
): Promise<ReputationSource> {
	const res = await put<SourceResponse>("/reputation/sources", input);
	return res.source;
}

export async function deleteReputationSource(
	id: string,
	del: ApiClient["delete"] = apiDelete,
): Promise<void> {
	await del<{ status: string }>(`/reputation/sources/${id}`);
}
