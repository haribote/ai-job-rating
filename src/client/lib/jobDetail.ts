import type { NormalizedJob, NormalizedKey } from "../../shared/job-schema";
import { apiGet, apiPost } from "./api";

// 求人詳細（GET /api/jobs/:id・#95 契約）と再抽出（POST /api/jobs/:id/reextract）の
// クライアント側型・取得関数。
//
// なぜ client 側で型を再定義するか:
// - server は別バンドルで import できないため、契約型は client に複製して一貫消費する（#95 申し送り）。
// - 正規キーだけは唯一の真実 src/shared/job-schema の NormalizedKey を type-only import して揺れを防ぐ。
// - 本モジュールは契約を消費するだけ。抽出↔スコア分離・unknown 中立・正規化は API 側の責務（再実装しない）。

// 内訳行の正規化類型（サーバ NormalizationKind と同値）。
export type BreakdownKind = "numericRange" | "categorical" | "coverage";

// ハードフィルタ種別（criteria_config 由来）。
export type HardFilterMode = "none" | "required" | "exclude";

// 内訳 1 行（フラット）。項目・抽出値(raw)・希望値(desired)・サブスコア(score)・重み(weight)。
// score===null かつ included===false は unknown 中立（加重合計の分母から除外）。
export interface BreakdownRow {
	readonly key: NormalizedKey;
	readonly kind: BreakdownKind;
	readonly weight: number;
	readonly score: number | null;
	readonly included: boolean;
	readonly raw: string;
	readonly hardFilter: HardFilterMode;
	// criteria_config の希望値（JSON 由来の任意形・number/{min,max}/string[] 等）。
	readonly desired: unknown;
}

// 抽出メタ（契約。サーバ ExtractionStatus と同値）。
export type DetailExtractionStatus = "ok" | "partial" | "failed";

export interface JobDetailExtraction {
	readonly status: DetailExtractionStatus;
	readonly model: string;
	readonly mechanism: string;
	readonly extractedAt: number;
	// 正規化済み求人。benefitsCoverage の signal 内訳展開に使う（§5.2）。
	readonly structured: NormalizedJob;
}

export interface JobDetailMeta {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly sourceType: string;
	readonly status: string;
	readonly fetchedAt: number;
}

// 企業評判寄与の信頼度（サーバ ReputationConfidence と同値・#37）。
export type ReputationConfidence = "none" | "low" | "ok";

// 企業評判の取得元 1 件ぶんの出所（UI 明示用・#117）。overall_score / review_count は取得元ネイティブ
// スケールのまま。未取得値は null（中立）。
export interface ReputationSourceRef {
	readonly source: string;
	readonly overallScore: number | null;
	readonly reviewCount: number | null;
}

// 企業評判の company 軸への寄与（契約。サーバ JobReputation と同値・#117）。
// score は件数で信頼度重み付けした 0..1（中立は null＝company 軸の分母から除外）。weight は合流時の重み。
export interface JobReputation {
	readonly score: number | null;
	readonly weight: number;
	readonly confidence: ReputationConfidence;
	readonly sources: readonly ReputationSourceRef[];
}

// GET /api/jobs/:id の応答。
export interface JobDetailResponse {
	readonly job: JobDetailMeta;
	readonly extraction: JobDetailExtraction;
	readonly total: number | null;
	readonly breakdown: readonly BreakdownRow[];
	// 企業評判寄与（#117）。旧 API 応答との後方互換のため optional（無ければ中立扱い）。
	readonly reputation?: JobReputation;
}

// POST /api/jobs/:id/reextract の応答（202）。
export interface ReextractResult {
	readonly status: DetailExtractionStatus;
}

// 詳細取得関数（テストはフェイクを注入する）。
export type JobDetailFetcher = (jobId: string) => Promise<JobDetailResponse>;

// 再抽出関数（テストはフェイクを注入する）。
export type ReextractAction = (jobId: string) => Promise<ReextractResult>;

export const fetchJobDetail: JobDetailFetcher = (jobId) =>
	apiGet<JobDetailResponse>(`/jobs/${encodeURIComponent(jobId)}`);

export const reextractJob: ReextractAction = (jobId) =>
	apiPost<ReextractResult>(`/jobs/${encodeURIComponent(jobId)}/reextract`);
