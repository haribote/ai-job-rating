// D1 スキーマ（jobs / extractions / scores / criteria_config）の TypeScript 型と定数（要件 §6 / §5.2 / §5.3）。
//
// なぜこのモジュールが存在するか:
// - マイグレーション SQL（migrations/0001_init_phase1.sql）が定義する行構造を型として一元化し、
//   後続の取得(#17)・スコアリング(#20)・UI(#18/#19) が同じ行型を import して参照できるようにする。
// - structured_json は src/job-schema.ts の NormalizedJob と整合させる（抽出結果の保存形）。
// - 本モジュールは型・定数のみを担い、DB アクセス（クエリ）やスコア計算は行わない（責務分離 §9）。

import type { NormalizedJob } from "../../shared/job-schema";

// マイグレーションが定義するスキーマ版。structured_json の互換管理に用いる（extractions.schema_version 既定値と一致）。
export const SCHEMA_VERSION = 1;

// テーブル名の単一ソース。クエリ層・テストが文字列直書きせず参照する。
export const TABLE_NAMES = {
	jobs: "jobs",
	extractions: "extractions",
	scores: "scores",
	criteriaConfig: "criteria_config",
} as const;

// scores の総合スコア行を表す予約 criterion 値（正規キーと衝突しない番兵）。
export const TOTAL_SCORE_CRITERION = "__total__";

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

// 取得経路（§6）。detail=詳細 / listing=一覧 / paste=本文貼り付け。
export type JobSourceType = "detail" | "listing" | "paste";

// パイプライン状態（§6）。fetched→extracted→scored の単調進行、失敗は failed。
export type JobStatus = "fetched" | "extracted" | "scored" | "failed";

// jobs 行。raw_html_r2_key は生 HTML(R2) への参照キー（#16→#17）。
export interface JobRow {
	readonly id: string;
	readonly source_url: string;
	readonly source_type: JobSourceType;
	readonly status: JobStatus;
	readonly raw_html_r2_key: string | null;
	readonly company_id: string | null;
	readonly fetched_at: number;
	readonly created_at: number;
}

// ---------------------------------------------------------------------------
// extractions
// ---------------------------------------------------------------------------

// 構造化機構（#65）。差し替え可能なアダプタを識別する。フォーク先で増やせるよう緩い型にする。
export type ExtractionMechanism = string;

// 抽出の結果状態（#65 必須）。failed/partial を unknown 中立と区別する（#20 が参照）。
export type ExtractionStatus = "ok" | "partial" | "failed";

// extractions 行。structured_json は JSON 文字列として保持し、parse 後 NormalizedJob 構造になる。
export interface ExtractionRow {
	readonly id: string;
	readonly job_id: string;
	readonly structured_json: string;
	readonly model: string;
	readonly mechanism: ExtractionMechanism;
	readonly extraction_status: ExtractionStatus;
	readonly raw_fields: string | null;
	// SQLite には boolean 型が無いため 0/1 で保持する。
	readonly repaired: 0 | 1;
	readonly schema_version: number;
	readonly extracted_at: number;
}

// structured_json を parse した結果の意図する形（NormalizedJob と整合）。保存前の検証点。
export type ExtractionStructuredJson = NormalizedJob;

// ---------------------------------------------------------------------------
// criteria_config
// ---------------------------------------------------------------------------

// ハードフィルタ（§6）。required=必須 / exclude=除外 / none=スコアのみ。
export type HardFilter = "none" | "required" | "exclude";

// criteria_config 行。desired_value は kind 依存のため JSON 文字列で保持する（#16→#20）。
export interface CriteriaConfigRow {
	readonly criterion: string;
	readonly desired_value: string | null;
	readonly weight: number;
	readonly hard_filter: HardFilter;
	readonly updated_at: number;
}

// ---------------------------------------------------------------------------
// scores
// ---------------------------------------------------------------------------

// scores 行。criterion=TOTAL_SCORE_CRITERION の行が総合スコア、それ以外は正規キーのサブスコア。
// included=0 / sub_score=null は unknown 中立で分母から外れた項目（§5.2）。
export interface ScoreRow {
	readonly job_id: string;
	readonly criterion: string;
	readonly sub_score: number | null;
	// SQLite には boolean 型が無いため 0/1 で保持する。
	readonly included: 0 | 1;
	readonly weight: number | null;
	readonly scored_at: number;
}
