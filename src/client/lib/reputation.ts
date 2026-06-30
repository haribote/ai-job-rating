// 企業評判（Phase 2）の client 契約と API 呼び出し。設定 UI（#31 APIキー導線 / #34 取得元設定）が消費する。
//
// なぜ存在するか:
// - 取得元設定の CRUD（GET/PUT/DELETE /api/reputation/sources）と APIキー presence（GET /api/reputation/config）を
//   薄いラッパに閉じ、UI（ReputationSourcesForm / ReputationApiKeySection）から fetch 細部や契約のエラー形を
//   切り離す（criteria.ts / api.ts の流儀に倣う・§9）。
// - 設計ガードレール（フォーク容易性・抽出↔スコア分離・秘匿）は API 側の責務。本モジュールは契約を消費するだけで
//   再実装しない。設定変更は決定的・AI 非再実行（§5.3）。サーバは別バンドルのため型は client 側で定義する。

import type { ApiClient } from "./api";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

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

// GET /api/reputation/config の応答。評判検索（#30）の前提キーが注入済みかだけを表す（presence のみ・秘匿）。
export interface ReputationApiKeyConfig {
	readonly apiKeyConfigured: boolean;
}

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

// 評判 API キーの構成状態を取得する。get は注入可能（テストはフェイク、本番は global fetch）。
export async function fetchReputationApiKeyConfig(
	get: ApiClient["get"] = apiGet,
): Promise<ReputationApiKeyConfig> {
	return get<ReputationApiKeyConfig>("/reputation/config");
}

// ---------------------------------------------------------------------------
// 補助/フォールバック経路（#35）: 手入力上書き / URL・HTML 投入
// ---------------------------------------------------------------------------

// 保存された評判スナップショット 1 行（サーバ ReputationSnapshotRow と整合・snake_case）。
// overall_score / review_count / sub_scores_json は NULL 許容（unknown 中立・解釈は #36）。
export interface ReputationSnapshot {
	readonly id: string;
	readonly company_id: string;
	readonly source: string;
	readonly overall_score: number | null;
	readonly review_count: number | null;
	readonly sub_scores_json: string | null;
	readonly fetched_at: number;
	readonly created_at: number;
}

// 手入力上書きの入力（サーバ parseManualReputationInput と整合）。company は companyName で解決する。
// overall/count/sub のいずれか 1 つ以上を指定する（空の上書きはサーバが 400）。
export interface ManualReputationInput {
	readonly companyName: string;
	readonly source: string;
	readonly overallScore?: number | null;
	readonly reviewCount?: number | null;
	readonly subScores?: Record<string, number> | null;
}

// URL/HTML 投入の入力（サーバ parseUrlHtmlReputationInput と整合）。url と html は排他。
export interface UrlHtmlReputationInput {
	readonly companyName: string;
	readonly source: string;
	readonly url?: string;
	readonly html?: string;
}

interface SnapshotResponse {
	readonly snapshot: ReputationSnapshot;
}

// 手入力で評判スコアを上書きする（append-only で最新を積む）。保存後の snapshot を返す。
export async function overrideReputationManually(
	jobId: string,
	input: ManualReputationInput,
	put: ApiClient["put"] = apiPut,
): Promise<ReputationSnapshot> {
	const res = await put<SnapshotResponse>(
		`/jobs/${jobId}/reputation/manual`,
		input,
	);
	return res.snapshot;
}

// 評判ページの URL/HTML を投入し AI 抽出して保存する。保存後の snapshot を返す。
export async function ingestReputationFromUrlHtml(
	jobId: string,
	input: UrlHtmlReputationInput,
	post: ApiClient["post"] = apiPost,
): Promise<ReputationSnapshot> {
	const res = await post<SnapshotResponse>(
		`/jobs/${jobId}/reputation/url`,
		input,
	);
	return res.snapshot;
}
