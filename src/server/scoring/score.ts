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
import {
	type BenefitSignalKey,
	computeBenefitsCoverage,
} from "./benefits-coverage";
import { matchSkills } from "./skill-matcher";

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
	// 順序づけ tier 採点（任意・#104）。canonical カテゴリ → サブスコア(0..1)。指定時は preferred 集合
	// 一致率でなくこのマップで各カテゴリを採点し、順位差（例: フルリモート別格）を決定的に表現する。
	// preferred はハードフィルタ「該当」判定に引き続き使う（tier は soft スコアのみに効く）。
	readonly tierScores?: Readonly<Record<string, number>>;
}

// スキル適合項目の設定（#105）。求人スキル集合（categorical）× ユーザー keyword の決定的ヒット率を
// サブスコアにする。keyword は希望値（criteria_config の desired_value）由来でここに載る。
// keyword の変更で AI を再実行しない（§5.3）。必須/歓迎の区別はしない。
export interface KeywordMatchItemConfig {
	readonly weight: number;
	readonly kind: "keywordMatch";
	readonly keywords: readonly string[];
}

// 充足率項目の設定（benefitsCoverage 用・設計書 §5.2）。サブスコアは充足率 present/total。
// emphasis は重視する signal キー集合。指定されると当該 signal を重み付けして再採点する（AI 非再実行・#102）。
export interface CoverageItemConfig {
	readonly weight: number;
	readonly kind: "coverage";
	readonly emphasis?: readonly string[];
}

export type ScoringItemConfig =
	| NumericRangeItemConfig
	| CategoricalItemConfig
	| KeywordMatchItemConfig
	| CoverageItemConfig;

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

// カテゴリのサブスコア。カテゴリが空なら評価不能（null）= unknown 扱いで分母から外す。
// tierScores 指定時は順序づけ採点（各カテゴリの tier スコア平均）。canonical 外/未定義カテゴリは
// 0（記載はあるので中立=null ではない・#104）。未指定時は preferred 集合との一致割合。
function scoreCategorical(
	value: NormalizedFieldValue,
	config: CategoricalItemConfig,
): number | null {
	if (value.kind !== "categorical") return null;
	if (value.categories.length === 0) return null;
	if (config.tierScores !== undefined) {
		const tiers = config.tierScores;
		// own プロパティのみ参照する。canonical 外の生表記が "constructor"/"toString" 等の
		// プロトタイプ継承キーに一致しても関数値を拾って NaN 化させない（決定的・0 として扱う）。
		const sum = value.categories.reduce(
			(acc, c) => acc + (Object.hasOwn(tiers, c) ? tiers[c] : 0),
			0,
		);
		return clamp01(sum / value.categories.length);
	}
	const preferred = new Set(config.preferred);
	const matched = value.categories.filter((c) => preferred.has(c)).length;
	return clamp01(matched / value.categories.length);
}

// スキル適合のサブスコア（#105）。求人スキル集合（categorical）× keyword の決定的ヒット率を
// 0..1 へ正規化する。keyword 未指定（意見なし）・求人スキル不明はいずれも中立（null・分母から除外）。
function scoreKeywordMatch(
	value: NormalizedFieldValue,
	config: KeywordMatchItemConfig,
): number | null {
	if (value.kind !== "categorical") return null;
	if (value.categories.length === 0) return null; // 求人スキル不明（中立）
	// keyword 未指定・正規化後に空（意見なし）は matchSkills が null を返す（中立・分母から除外）。
	const hit = matchSkills(value.categories, config.keywords);
	return hit === null ? null : clamp01(hit / 100);
}

// 充足率のサブスコア（benefitsCoverage）。決定的。
// signals があれば canonical 閉集合での充足率（emphasis 重み込み）を 0..1 へ正規化する。
// signals が無い保存値（旧データ）は present/total で後方互換に算出する。total が 0 なら評価不能（null）。
function scoreCoverage(
	value: NormalizedFieldValue,
	config: CoverageItemConfig,
): number | null {
	if (value.kind !== "coverage") return null;
	if (value.signals !== undefined) {
		const present = new Set(value.signals) as ReadonlySet<BenefitSignalKey>;
		const emphasis = config.emphasis as readonly BenefitSignalKey[] | undefined;
		return clamp01(computeBenefitsCoverage(present, emphasis) / 100);
	}
	if (value.total <= 0) return null;
	return clamp01(value.present / value.total);
}

// 「有り明記だが定量なし」の減点値（§5.2 unknown 中立の意図的例外・設計 §5.2）。
// 「該当あり」と明記されているのに定量値が読めない＝リスクとして、中立（分母除外）にせず
// 最悪値 0 を分母へ算入して減点する。現状 overtime のみがこの値を生成する（抽出側で stated を立てる）。
const STATED_UNQUANTIFIED_PENALTY = 0;

// 1 項目のサブスコアを算出する（決定的）。算出不能（kind 不一致・空・unknown）は null。
function scoreItem(
	value: NormalizedFieldValue,
	config: ScoringItemConfig,
): number | null {
	// unknown は原則中立（§5.2）。ただし「有り明記だが定量なし」だけは意図的例外として減点する。
	// 記載なし（stated でない unknown）は従来通り中立（分母から外す）。
	if (isUnknown(value)) {
		return value.stated === true ? STATED_UNQUANTIFIED_PENALTY : null;
	}
	switch (config.kind) {
		case "numericRange":
			return scoreNumericRange(value, config);
		case "categorical":
			return scoreCategorical(value, config);
		case "keywordMatch":
			return scoreKeywordMatch(value, config);
		case "coverage":
			return scoreCoverage(value, config);
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

// リモート可否の canonical tier 別格スコア（設計書 §5.2 / #104）。
// なぜここで一元化するか: full を別格加点し partial/onsite と明確に差別化する順位は remoteWork の
// 採点意味そのもの（ユーザーが個別に調整する希望値ではない）。DEFAULT 設定と DB 設定（criteria-config）
// の双方がこの単一ソースを参照し、フルリモート別格を決定的に一致させる。
export const REMOTE_WORK_TIER_SCORES: Readonly<Record<string, number>> = {
	full: 1,
	partial: 0.5,
	onsite: 0,
};

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
		// 賞与: 年間支給回数が多いほど良い（#142）。年4回を満額の目安、年0回（賞与なし）を floor とする。
		bonus: {
			weight: 2,
			kind: "numericRange",
			direction: "higherBetter",
			desired: 4,
			floor: 0,
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
		// リモート可否は full/partial を歓迎し、フルリモートを別格加点する（tier 採点・#104）。
		// preferred はハードフィルタ「該当」判定に使う。soft スコアの順位差は tierScores が担う。
		remoteWork: {
			weight: 3,
			kind: "categorical",
			preferred: ["full", "partial"],
			tierScores: REMOTE_WORK_TIER_SCORES,
		},
		// フレックス・裁量労働は有を歓迎。
		flexWork: {
			weight: 1,
			kind: "categorical",
			preferred: ["yes", "flex", "discretionary"],
		},
		// スキル適合は求人スキル集合 × ユーザー keyword の決定的ヒット率（#105）。
		// 必須/歓迎の区別はしない。既定の keyword は空（意見なし=中立）でフォーク先・設定UIが埋める。
		skillMatch: { weight: 4, kind: "keywordMatch", keywords: [] },
	},
};
