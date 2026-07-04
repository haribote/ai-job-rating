// 投入済み求人のスコア順ビュー組み立て＋ランキング JSON シリアライズ（#18 / #95 Task 2）。
//
// なぜこのモジュールが存在するか:
// - 並び順は #20 の rankJobs に委ねる（決定的・§8）。本モジュールは渡された順序のまま順位を保ち、
//   AI も再スコアリングも実行しない（§5.3 抽出とスコアリングの分離）。
// - scores（#16 確定スキーマ）由来の RescoredJob と raw 値を忠実に構造化する。included=false は
//   「情報なし・分母除外」として表現し unknown 中立を見える化する（§5.2）。
// - 表示用 HTML は持たない（JSON 契約・#95）。整形・ラベル付与は client 側の責務。

import type { CategoryKey } from "../shared/categories";
import {
	aggregateCategoryScores,
	type CategoryReputationContribution,
} from "../shared/categoryScores";
import type { NormalizedJob, NormalizedKey } from "../shared/job-schema";
import type { HardFilterResult, RescoredJob } from "./scoring/rescore-core";
import type { ScoreResult } from "./scoring/score";
import type { ExtractionStatus } from "./storage/db-schema";

// 一覧 1 行の項目別内訳。score/included/weight は scores 由来、raw は抽出値（表示用）。
export interface RankedBreakdownRow {
	readonly key: NormalizedKey;
	readonly kind: ScoreResult["breakdown"][number]["kind"];
	readonly weight: number;
	readonly score: number | null;
	readonly included: boolean;
	readonly raw: string;
}

// ランキング一覧の 1 求人ビュー。並び順は呼び出し側（rankJobs）が確定済み。
export interface RankedJobView {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly status: ExtractionStatus;
	readonly total: number | null;
	readonly breakdown: readonly RankedBreakdownRow[];
	// ハードフィルタ除外の理由（通過した求人は null）。
	readonly rejectedBy: HardFilterResult["rejectedBy"];
	// 会社名・職種タイトル（表示専用・#200）。抽出できなければ null（NormalizedJob 非経由）。
	readonly companyName: string | null;
	readonly jobTitle: string | null;
	// 企業評判の company 軸への寄与（#181）。company 未紐付け・評判未取得・キー未設定は null（中立除外）。
	// total は rescored.score.total に read-time で合流済み（呼び出し側 readRanking が担う）。radar 集約にはここを渡す。
	readonly reputation: CategoryReputationContribution | null;
}

// 正規キーの値から表示用の生表記を取り出す。raw が無ければ空文字。
function rawOf(job: NormalizedJob, key: NormalizedKey): string {
	const value = job[key];
	return "raw" in value && typeof value.raw === "string" ? value.raw : "";
}

// RescoredJob（#20）+ 取得元 URL + 抽出済み求人 + 抽出状態 + 会社名/職種タイトル（#200） → 表示ビュー。
// score/included/weight は RescoredJob 由来（= 永続 scores と同値・決定的）、raw は抽出値。
// companyName/jobTitle は extractions の並列カラム由来でスコアリングに影響しない（そのまま透過する）。
export function rescoredToView(
	rescored: RescoredJob,
	sourceUrl: string,
	job: NormalizedJob,
	status: ExtractionStatus,
	companyName: string | null,
	jobTitle: string | null,
	reputation: CategoryReputationContribution | null = null,
): RankedJobView {
	return {
		jobId: rescored.jobId,
		sourceUrl,
		status,
		total: rescored.score.total,
		breakdown: rescored.score.breakdown.map((row) => ({
			key: row.key,
			kind: row.kind,
			weight: row.weight,
			score: row.score,
			included: row.included,
			raw: rawOf(job, row.key),
		})),
		rejectedBy: rescored.hardFilter.rejectedBy,
		companyName,
		jobTitle,
		reputation,
	};
}

// ランキング一覧 1 行の JSON 契約（client が消費）。一覧は軽量に保ち、項目別内訳は詳細 API に委ねる。
// company/title は AI 抽出の自由記述（#200）。抽出できなければ null（client は sourceUrl へフォールバック）。
export interface RankingItem {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly company: string | null;
	readonly title: string | null;
	readonly total: number | null;
	readonly status: ExtractionStatus;
	readonly rejectedBy: HardFilterResult["rejectedBy"];
	// レーダー表示用の軸別スコア（#202）。breakdown から集約するため一覧行の追加 DB I/O は不要。
	readonly categoryScores: Record<CategoryKey, number | null>;
}

// 表示ビュー → ランキング JSON 行へ縮約する（決定的・純関数）。
export function toRankingItem(view: RankedJobView): RankingItem {
	return {
		jobId: view.jobId,
		sourceUrl: view.sourceUrl,
		company: view.companyName,
		title: view.jobTitle,
		total: view.total,
		status: view.status,
		rejectedBy: view.rejectedBy,
		// company 軸 radar に企業評判を合流する（#181）。reputation=null（未紐付け・未取得）は中立除外。
		categoryScores: aggregateCategoryScores(view.breakdown, view.reputation),
	};
}
