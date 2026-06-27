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
// aiJudged 拡張点（#68 協調設計）:
// - スキル適合（requiredSkillsMatch / preferredSkillsMatch）は「求人側スキル集合 ×
//   希望集合 → 0..100」をスコアリング側で決定的に突合する方針（希望条件変更で AI 再実行＝
//   §5.3 違反を避けるため）。本モジュールは SkillMatcher 契約と適用点を定義し、
//   #68 が実 matcher を埋めるまでは aiJudged 値を unknown 中立のままにする（分母から除外）。

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
// aiJudged 拡張点（#68 が実値化する突合関数の入出力契約）
// ---------------------------------------------------------------------------

// スキル突合の決定的契約（#68 → #20）。
// - desired: 希望スキル集合の在り処。criteria_config 側の希望値（正規化済みスキル文字列集合）。
// - jobSkills: 求人側スキル集合の取得元。抽出済み NormalizedJob.techStack（categorical の
//   categories）など、保存済み抽出から決定的に得られる正規化済みスキル集合。
// - 戻り値: 0..1 に正規化したサブスコア（scoreJob の aiJudged は内部で 0..100→0..1 する
//   ため、突合関数は 0..1 を返し、本モジュールが AiJudgedValue.score へ ×100 して載せる）。
//   突合不能（双方空など）は null（= unknown 中立で分母から除外）。
// 決定的であること（同一 desired・同一 jobSkills → 同一値）が必須（§8）。
export interface SkillMatchInput {
	readonly criterion: NormalizedKey;
	readonly desired: readonly string[];
	readonly jobSkills: readonly string[];
}

export type SkillMatcher = (input: SkillMatchInput) => number | null;

// 再スコアリングの拡張点。matcher 未指定（#68 未実装）の間は aiJudged を中立のままにする。
export interface RescoreExtensions {
	readonly skillMatcher?: SkillMatcher;
}

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
		case "aiJudged":
			// aiJudged はハードフィルタ対象外（突合スコアは soft 評価のみ）。判定不能。
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
// aiJudged 突合の適用（#68 拡張点）
// ---------------------------------------------------------------------------

// aiJudged 項目に skillMatcher を適用し、突合結果を AiJudgedValue として job に載せた
// 新しい NormalizedJob を返す（決定的）。matcher 未指定・突合不能の項目は値を変えない
// （元が unknown なら unknown のまま = 中立で分母から除外）。
// 希望集合（desired）は config の categorical 希望値が無いため、当面は呼び出し側が渡す
// desiredSkills マップから引く。#68 はこの適用点に実 matcher と希望集合の在り処を差す。
export function applySkillMatch(
	job: NormalizedJob,
	config: ScoringConfig,
	desiredSkills: Partial<Record<NormalizedKey, readonly string[]>>,
	extensions: RescoreExtensions,
): NormalizedJob {
	const matcher = extensions.skillMatcher;
	if (matcher === undefined) return job;

	let next: Record<NormalizedKey, NormalizedFieldValue> | null = null;
	for (const key of Object.keys(config.items) as NormalizedKey[]) {
		const itemConfig = config.items[key];
		if (itemConfig?.kind !== "aiJudged") continue;
		const jobSkills = extractJobSkills(job[key]);
		const desired = desiredSkills[key] ?? [];
		const matched = matcher({ criterion: key, desired, jobSkills });
		if (matched === null) continue;
		if (next === null) next = { ...job };
		next[key] = { kind: "aiJudged", score: clamp01(matched) * 100 };
	}
	return (next ?? job) as NormalizedJob;
}

// aiJudged の対象値から求人側スキル集合を取り出す（決定的）。
// 抽出側は当面 categorical（categories）にスキルを載せる想定。それ以外は空集合。
function extractJobSkills(value: NormalizedFieldValue): readonly string[] {
	return value.kind === "categorical" ? value.categories : [];
}

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
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
// 手順: extraction_status 反映 → aiJudged 突合適用 → ハードフィルタ判定 → 加重平均。
// ハードフィルタで除外された求人も score は算出する（#18 が内訳表示できるように）。
export function rescoreJob(
	jobId: string,
	job: NormalizedJob,
	status: ExtractionStatus,
	config: ScoringConfig,
	hardFilters: HardFilterMap,
	desiredSkills: Partial<Record<NormalizedKey, readonly string[]>>,
	extensions: RescoreExtensions = {},
): RescoredJob {
	const statusApplied = applyExtractionStatus(job, status);
	const matched = applySkillMatch(
		statusApplied,
		config,
		desiredSkills,
		extensions,
	);
	const hardFilter = passesHardFilters(matched, config, hardFilters);
	const score = scoreJob(matched, config);
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
