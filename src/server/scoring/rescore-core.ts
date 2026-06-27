// 設定変更時の再スコアリング（決定的・AI 非依存）の純粋コア（#20）。
//
// なぜこのモジュールが存在するか:
// - criteria_config（重み・希望値・ハードフィルタ）と保存済み抽出（再実行しない）だけから
//   決定的に総合スコア・項目別内訳・ハードフィルタ判定を算出する（§5.2 / §5.3 / §8）。
// - DB アクセス・AI 呼び出しは持たない（責務分離 §9）。永続化は rescore.ts が担う。
//
// 抽出失敗（extraction_status）と unknown 中立の区別（#65→#20 の肝）:
// - failed: 抽出全体が信頼できない → 全項目を unknown 相当（中立）で分母から外す。
//   「値が取れた」と「抽出が壊れた」を混同しない（unknown 中立とは別軸）。
// - partial/ok: NormalizedJob の各値をそのまま採用する。取れなかった項目は値自体が
//   unknown なので scoreJob が中立に扱う（partial を一律 unknown にはしない）。
//
// スキル適合（skillMatch）は「求人側スキル集合 × ユーザー keyword → 0..100」を score.ts が
// 決定的に採点する（keyword は criteria_config の desired_value 由来で config に載る・#105）。
// keyword 変更で AI を再実行しない（§5.3）。本モジュールは前処理・ハードフィルタ・順位付けのみ担う。

import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "../../shared/job-schema";
import type { ExtractionStatus } from "../storage/db-schema";
import type { HardFilterMap } from "./criteria-config";
import { type ScoreResult, type ScoringConfig, scoreJob } from "./score";

// ---------------------------------------------------------------------------
// extraction_status による値の前処理（failed/partial と unknown 中立の区別）
// ---------------------------------------------------------------------------

// 抽出が failed のときに採点へ渡す求人を作る（全項目 unknown）。
// なぜ: failed は抽出全体が壊れており、保存済みの値も信頼できない。値が取れなかった
// （= unknown 中立）のとは別軸なので、明示的に全項目中立化して誤採点を防ぐ。
function allUnknownJob(): NormalizedJob {
	const job = {} as Record<NormalizedKey, NormalizedFieldValue>;
	for (const key of NORMALIZED_KEYS) {
		job[key] = { kind: "unknown" };
	}
	return job as NormalizedJob;
}

// extraction_status を反映した採点対象の NormalizedJob を返す（決定的）。
// failed → 全項目中立 / partial・ok → そのまま（取れない項目は値が unknown のまま）。
export function applyExtractionStatus(
	job: NormalizedJob,
	status: ExtractionStatus,
): NormalizedJob {
	return status === "failed" ? allUnknownJob() : job;
}

// ---------------------------------------------------------------------------
// ハードフィルタ判定（required / exclude）
// ---------------------------------------------------------------------------

// ハードフィルタ判定の結果。除外された場合は理由（criterion と種別）を残す（#18 UI 表示用）。
export interface HardFilterResult {
	readonly passed: boolean;
	// 除外を引き起こした criterion とフィルタ種別（passed=true なら null）。
	readonly rejectedBy: {
		readonly criterion: NormalizedKey;
		readonly filter: "required" | "exclude";
	} | null;
}

// 1 項目が「該当する（カテゴリ一致 / 数値が希望を満たす）」かを決定的に判定する。
// unknown は「該当する」とも「しない」とも判定できない → null（判定不能）。
// ハードフィルタは required: 該当しないと除外 / exclude: 該当すると除外。
function matchesFilter(
	value: NormalizedFieldValue,
	config: ScoringConfig["items"][NormalizedKey],
): boolean | null {
	if (config === undefined) return null;
	if (value.kind === "unknown") return null;
	switch (config.kind) {
		case "categorical": {
			if (value.kind !== "categorical") return null;
			if (value.categories.length === 0) return null;
			const preferred = new Set(config.preferred);
			// 1 つでも希望カテゴリに一致すれば「該当」とみなす。
			return value.categories.some((c) => preferred.has(c));
		}
		case "numericRange": {
			if (value.kind !== "numericRange") return null;
			// 希望値を満たすか（higherBetter: desired 以上 / lowerBetter: desired 以下）。
			return config.direction === "higherBetter"
				? value.max >= config.desired
				: value.min <= config.desired;
		}
		case "keywordMatch":
			// skillMatch はハードフィルタ対象外（keyword ヒットは soft 評価のみ）。判定不能。
			return null;
		case "coverage":
			// coverage（充足率）はハードフィルタ対象外（soft 評価のみ）。判定不能。
			return null;
	}
}

// 求人がハードフィルタを通過するか判定する（決定的・§5.2）。
// required: 該当しない（または判定不能=unknown）なら除外。unknown を「満たした」とは扱わない。
// exclude: 該当するなら除外。判定不能（unknown）は除外しない（中立）。
export function passesHardFilters(
	job: NormalizedJob,
	config: ScoringConfig,
	hardFilters: HardFilterMap,
): HardFilterResult {
	// criterion 昇順で走査して、複数フィルタが効く場合の rejectedBy を決定的にする。
	const keys = (Object.keys(hardFilters) as NormalizedKey[]).sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	for (const key of keys) {
		const filter = hardFilters[key];
		if (filter === undefined || filter === "none") continue;
		const matched = matchesFilter(job[key], config.items[key]);
		if (filter === "required" && matched !== true) {
			return {
				passed: false,
				rejectedBy: { criterion: key, filter: "required" },
			};
		}
		if (filter === "exclude" && matched === true) {
			return {
				passed: false,
				rejectedBy: { criterion: key, filter: "exclude" },
			};
		}
	}
	return { passed: true, rejectedBy: null };
}

// ---------------------------------------------------------------------------
// 1 求人の再スコアリング（決定的）
// ---------------------------------------------------------------------------

// 再スコアリング 1 件の結果。永続化（scores 行）・ランキングはこれを使う。
export interface RescoredJob {
	readonly jobId: string;
	readonly score: ScoreResult;
	readonly hardFilter: HardFilterResult;
}

// 1 求人を再スコアリングする（決定的・AI 非依存）。
// 手順: extraction_status 反映 → ハードフィルタ判定 → 加重平均（skillMatch の keyword 突合は scoreJob 内）。
// ハードフィルタで除外された求人も score は算出する（#18 が内訳表示できるように）。
export function rescoreJob(
	jobId: string,
	job: NormalizedJob,
	status: ExtractionStatus,
	config: ScoringConfig,
	hardFilters: HardFilterMap,
): RescoredJob {
	const statusApplied = applyExtractionStatus(job, status);
	const hardFilter = passesHardFilters(statusApplied, config, hardFilters);
	const score = scoreJob(statusApplied, config);
	return { jobId, score, hardFilter };
}

// ---------------------------------------------------------------------------
// ランキング（決定的な並べ替え）
// ---------------------------------------------------------------------------

// ハードフィルタを通過した求人をスコア降順に並べる（決定的・§8）。
// 除外された求人はランキングから外す（§5.2 ハードフィルタ）。total=null（全 unknown）は
// 末尾に置く。同点・同 null は jobId 昇順で安定化する（順序依存を持ち込まない）。
export function rankJobs(jobs: readonly RescoredJob[]): readonly RescoredJob[] {
	return [...jobs]
		.filter((j) => j.hardFilter.passed)
		.sort((a, b) => {
			const sa = a.score.total;
			const sb = b.score.total;
			if (sa === null && sb === null) return a.jobId < b.jobId ? -1 : 1;
			if (sa === null) return 1;
			if (sb === null) return -1;
			if (sb !== sa) return sb - sa; // スコア降順
			return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0; // 同点は jobId 昇順
		});
}
