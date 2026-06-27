// 固定設定での決定的スコアリング（要件 §5.2 スコア算出方式 / §5.3 抽出とスコアリングの分離 / §8 再現性）。
//
// なぜこのモジュールが存在するか:
// - 正規スキーマ NormalizedJob を入力に、コード/JSON 固定の評価項目・希望値・重みから
//   決定的に重み付き加重平均スコアを算出する。AI は呼ばない（§5.3）。
// - unknown は加点も減点もせず加重合計の分母から外す（§5.2 unknown 中立）。
// - スコアリングは正規キーのみ参照する（§5.2 ラベル正規化の責務は抽出側）。
// - 設定は型付き定数（DEFAULT_SCORING_CONFIG）で持ち、フォーク先が差し替えやすくする
//   （アカウント固有値・秘匿情報は含めない、フォーク容易性 §8）。
// - 決定的: Date/乱数/順序依存を持ち込まない。breakdown は設定順序で安定して返す。

import {
	isUnknown,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "../../shared/job-schema";

// ---------------------------------------------------------------------------
// スコアリング設定（固定・型付き）
// ---------------------------------------------------------------------------

// numericRange の評価方向。年収は higherBetter、残業は lowerBetter のように項目で異なる。
export type NumericDirection = "higherBetter" | "lowerBetter";

// 数値レンジ項目の設定。desired を満たせばサブスコア 1.0、反対端（floor/ceil）で 0.0。
// 間は線形補間する（決定的・境界含む）。
export interface NumericRangeItemConfig {
	readonly weight: number;
	readonly kind: "numericRange";
	readonly direction: NumericDirection;
	// 希望値。これを満たせば 1.0。
	readonly desired: number;
	// higherBetter のときの下限（これ以下で 0.0）。
	readonly floor?: number;
	// lowerBetter のときの上限（これ以上で 0.0）。
	readonly ceil?: number;
}

// カテゴリ項目の設定。preferred 集合との一致割合をサブスコアにする。
export interface CategoricalItemConfig {
	readonly weight: number;
	readonly kind: "categorical";
	readonly preferred: readonly string[];
}

// AI 判定項目の設定。抽出フェーズで得た 0..100 の score を 0..1 へ正規化する（§5.2 AI判定）。
export interface AiJudgedItemConfig {
	readonly weight: number;
	readonly kind: "aiJudged";
}

export type ScoringItemConfig =
	| NumericRangeItemConfig
	| CategoricalItemConfig
	| AiJudgedItemConfig;

// 評価項目ごとの設定。キーは正規キーのみ（スコアリングは正規キーのみ参照、§5.2）。
// 設定にない正規キーは評価対象外（breakdown にも total にも入らない）。
export interface ScoringConfig {
	readonly items: Partial<Record<NormalizedKey, ScoringItemConfig>>;
}

// ---------------------------------------------------------------------------
// スコア結果（#13 内訳表示への申し送り形）
// ---------------------------------------------------------------------------

// 項目別の内訳 1 行。included=false の項目は unknown 中立として分母から外したことを表す。
export interface ScoreBreakdownRow {
	readonly key: NormalizedKey;
	readonly kind: ScoringItemConfig["kind"];
	readonly weight: number;
	// 採用された項目のサブスコア（0..1）。除外項目は null。
	readonly score: number | null;
	readonly included: boolean;
}

// スコア結果。total は加重平均（0..1）。採用項目が無い（全 unknown）ときは分母 0 を表す null。
export interface ScoreResult {
	// null は「評価できる項目が無い（分母 0）」を 0 と区別して表す（§5.2 unknown 中立）。
	readonly total: number | null;
	readonly breakdown: readonly ScoreBreakdownRow[];
}

// ---------------------------------------------------------------------------
// 各 kind のサブスコア化（決定的・0..1）。算出不能なら null（=分母から除外）。
// ---------------------------------------------------------------------------

// 0..1 へクランプする（境界の安定化）。
function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

// 数値レンジのサブスコア。レンジは評価方向に有利な端（higher は max、lower は min）で評価する。
function scoreNumericRange(
	value: NormalizedFieldValue,
	config: NumericRangeItemConfig,
): number | null {
	if (value.kind !== "numericRange") return null;
	if (config.direction === "higherBetter") {
		const floor = config.floor ?? 0;
		// 高いほど良い → レンジ上限で評価（有利側）。
		const x = value.max;
		if (config.desired <= floor) return null; // 設定不正（補間幅 0）は評価不能
		if (x >= config.desired) return 1;
		if (x <= floor) return 0;
		return clamp01((x - floor) / (config.desired - floor));
	}
	// lowerBetter: 低いほど良い → レンジ下限で評価（有利側）。
	const ceil = config.ceil ?? Number.POSITIVE_INFINITY;
	const x = value.min;
	if (ceil <= config.desired) return null; // 設定不正（補間幅 0）は評価不能
	if (x <= config.desired) return 1;
	if (x >= ceil) return 0;
	return clamp01(1 - (x - config.desired) / (ceil - config.desired));
}

// カテゴリのサブスコア。preferred 集合との一致割合（一致数 / カテゴリ総数）。
// カテゴリが空なら評価不能（null）= unknown 扱いで分母から外す。
function scoreCategorical(
	value: NormalizedFieldValue,
	config: CategoricalItemConfig,
): number | null {
	if (value.kind !== "categorical") return null;
	if (value.categories.length === 0) return null;
	const preferred = new Set(config.preferred);
	const matched = value.categories.filter((c) => preferred.has(c)).length;
	return clamp01(matched / value.categories.length);
}

// AI 判定のサブスコア。0..100 を 0..1 へ正規化しクランプする。
function scoreAiJudged(value: NormalizedFieldValue): number | null {
	if (value.kind !== "aiJudged") return null;
	return clamp01(value.score / 100);
}

// 1 項目のサブスコアを算出する（決定的）。算出不能（kind 不一致・空・unknown）は null。
function scoreItem(
	value: NormalizedFieldValue,
	config: ScoringItemConfig,
): number | null {
	// unknown は無条件で中立（§5.2）。kind に依らず分母から外す。
	if (isUnknown(value)) return null;
	switch (config.kind) {
		case "numericRange":
			return scoreNumericRange(value, config);
		case "categorical":
			return scoreCategorical(value, config);
		case "aiJudged":
			return scoreAiJudged(value);
	}
}

// ---------------------------------------------------------------------------
// 総合スコア（正規化加重平均）
// ---------------------------------------------------------------------------

// NormalizedJob と固定設定から決定的にスコアを算出する（AI 非依存・§5.3）。
// 総合スコア = Σ(weightᵢ·scoreᵢ) / Σ(weightᵢ)（i は採用された項目のみ）。
// 採用項目が無いとき（全 unknown 等）は分母 0 を表す total=null を返す。
export function scoreJob(
	job: NormalizedJob,
	config: ScoringConfig,
): ScoreResult {
	const breakdown: ScoreBreakdownRow[] = [];
	let weightedSum = 0;
	let weightTotal = 0;

	// 設定の登録順で走査することで breakdown の順序を決定的にする。
	for (const key of Object.keys(config.items) as NormalizedKey[]) {
		const itemConfig = config.items[key];
		if (itemConfig === undefined) continue;
		const score = scoreItem(job[key], itemConfig);
		const included = score !== null;
		breakdown.push({
			key,
			kind: itemConfig.kind,
			weight: itemConfig.weight,
			score,
			included,
		});
		if (included) {
			weightedSum += itemConfig.weight * score;
			weightTotal += itemConfig.weight;
		}
	}

	const total = weightTotal === 0 ? null : weightedSum / weightTotal;
	return { total, breakdown };
}

// ---------------------------------------------------------------------------
// 固定設定（Phase 0）。フォーク先が希望値・重みを差し替えやすいよう型付き定数で持つ。
// ---------------------------------------------------------------------------

// Phase 0 の既定スコアリング設定。希望値・重みは一般的な技術職の優先度を仮置きした初期値で、
// フォーク先・後続フェーズ（#7 設定UI）で差し替える前提。アカウント固有値は含めない。
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
	items: {
		// 報酬: 年収は高いほど良い（万円表記の数値をそのまま比較、§extract parseNumbers と整合）。
		annualSalary: {
			weight: 5,
			kind: "numericRange",
			direction: "higherBetter",
			desired: 700,
			floor: 300,
		},
		// 働き方: 残業は少ないほど良い（時間）。
		overtime: {
			weight: 3,
			kind: "numericRange",
			direction: "lowerBetter",
			desired: 10,
			ceil: 45,
		},
		// 年間休日は多いほど良い（日）。
		annualHolidays: {
			weight: 2,
			kind: "numericRange",
			direction: "higherBetter",
			desired: 125,
			floor: 105,
		},
		// リモート可否は full/partial を歓迎。
		remoteWork: {
			weight: 3,
			kind: "categorical",
			preferred: ["full", "partial"],
		},
		// フレックス・裁量労働は有を歓迎。
		flexWork: {
			weight: 1,
			kind: "categorical",
			preferred: ["yes", "flex", "discretionary"],
		},
		// スキル適合は AI 判定（抽出フェーズの 0..100 を流用）。
		requiredSkillsMatch: { weight: 4, kind: "aiJudged" },
		preferredSkillsMatch: { weight: 2, kind: "aiJudged" },
	},
};
