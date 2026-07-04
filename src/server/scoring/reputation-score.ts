// 企業評判の信頼度重み付けと company 軸への合流（決定的・AI 非依存・要件 §5.2 / §7.2 / #36）。
//
// なぜこのモジュールが存在するか:
// - reputation_snapshots（企業単位キャッシュ・#33）の overall_score / review_count を、件数による
//   信頼度重み付け（ベイズ平均）で割り引いてから 5 軸の「company」軸へ合流させる（#117/spec の確定設計）。
//   独立カテゴリ（空軸）は作らず、companySize / capital と並ぶ company 軸内の 1 項目として加重平均に載せる。
// - overall_score は取得元ネイティブスケール（既定 0–5・web-search.ts）のまま保存される。0..1 への正規化は
//   本層の責務（軸スコアは 0..1 想定・#110）。
// - 件数の少ない高評価が支配しないこと（Phase 2 DoD）を、ベイズ収縮で決定的に担保する。
// - unknown 中立（§5.2）: overall_score / review_count が NULL の行・取得行なしは加重合計の分母に入れない。
//   「未取得（行なし）」と「取得したが該当なし（NULL）」はどちらも company 軸への寄与を持たない（中立）。
// - 抽出↔スコアリング分離（§5.3）: スナップショットは引数で受け取り、DB アクセス・AI 呼び出しは持たない。
//   求人→企業名の供給（resolveCompanyForJob の ingest 配線）は #117 capstone に委ね、本層は snapshots を
//   引数で受ける純関数の seam に留める。

import type { ReputationSnapshotRow } from "../storage/db-schema";

// 信頼度重み付けの設定。フォーク先・設定 UI（#37）が差し替え可能。アカウント固有値・秘匿情報は含めない。
export interface ReputationWeightConfig {
	// 取得元ネイティブスケールの上限。既定プロンプト（web-search.ts）は 0–5 を要求する。
	readonly nativeMax: number;
	// ベイズ平均の擬似件数 C（事前分布の強さ）。件数がこの規模に達するまで中立 prior へ寄せる。
	readonly priorStrength: number;
	// 中立 prior m（0..1）。証拠（件数）が乏しいときの収束先。0.5＝中立。
	readonly priorMean: number;
	// company 軸内での評判ウェイト（companySize / capital と並ぶ 1 項目分の重み）。
	readonly weight: number;
}

// 既定の信頼度重み付け設定。priorStrength=10 は「10 件程度の口コミが集まって初めて素の評価を信用する」目安。
export const DEFAULT_REPUTATION_WEIGHT_CONFIG: ReputationWeightConfig = {
	nativeMax: 5,
	priorStrength: 10,
	priorMean: 0.5,
	weight: 3,
};

// 0..1 へのクランプ（score.ts の同名ヘルパと同義・本モジュールを自己完結させるため再定義）。
function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ネイティブスケール（0..nativeMax）を 0..1 へ線形正規化する（決定的）。範囲外は 0..1 へクランプする。
// 取得元が上限超過・負値を返しても軸スコアの 0..1 不変条件を保つ（#110）。
export function normalizeReputationScore(
	overallScore: number,
	nativeMax: number,
): number {
	if (!(nativeMax > 0)) return 0;
	return clamp01(overallScore / nativeMax);
}

// 採用行（unknown 中立を除いた有効スナップショット）の集計結果。
// computeReputationScore（スコア）と classifyReputationConfidence（低信頼判定）が同一の採用規則を
// 共有するため切り出す（採用規則が 2 箇所でずれないことを単一ソースで保証する）。
interface UsableEvidence {
	readonly evidenceSum: number; // Σ nᵢ·xᵢ
	readonly countSum: number; // Σ nᵢ（証拠の総量）
	readonly usable: number; // 採用行数
}

// unknown 中立（§5.2）の採用規則でスナップショットを畳み込む（決定的）。
// NULL・非有限・負件数の行は分母（証拠）から除外する。
function reduceUsableEvidence(
	snapshots: readonly ReputationSnapshotRow[],
	config: ReputationWeightConfig,
): UsableEvidence {
	let evidenceSum = 0;
	let countSum = 0;
	let usable = 0;
	for (const s of snapshots) {
		// NULL は「取得したが該当なし」＝中立。件数で重み付けできないため分母に入れない。
		if (s.overall_score === null || s.review_count === null) continue;
		// 取得層は範囲クランプしないため、ここで有限・非負の防御を行う（決定性・堅牢性）。
		if (!Number.isFinite(s.overall_score) || !Number.isFinite(s.review_count)) {
			continue;
		}
		if (s.review_count < 0) continue;
		const x = normalizeReputationScore(s.overall_score, config.nativeMax);
		evidenceSum += s.review_count * x;
		countSum += s.review_count;
		usable += 1;
	}
	return { evidenceSum, countSum, usable };
}

// 1 企業の全取得元スナップショットから company 軸への評判寄与（0..1）を算出する（決定的）。
//
// 件数による信頼度重み付け＝ベイズ平均でプールする:
//   reputation = (C·m + Σ nᵢ·xᵢ) / (C + Σ nᵢ)
//   xᵢ = normalizeReputationScore(overall_scoreᵢ), nᵢ = review_countᵢ
// 件数の少ない高評価は Σnᵢ が小さく中立 prior(m) へ強く収縮するため、件数の多い中評価を支配しない（DoD）。
//
// unknown 中立（§5.2）: overall_score か review_count が NULL の行は分母（証拠）から除外する。
// 採用行が 0（未取得・全 NULL）なら null を返し、呼び出し側（company 軸集約）の分母からも外す。
export function computeReputationScore(
	snapshots: readonly ReputationSnapshotRow[],
	config: ReputationWeightConfig = DEFAULT_REPUTATION_WEIGHT_CONFIG,
): number | null {
	const { evidenceSum, countSum, usable } = reduceUsableEvidence(
		snapshots,
		config,
	);
	if (usable === 0) return null;
	const { priorStrength, priorMean } = config;
	// 分母が 0（フォークが priorStrength=0 にし、かつ全行 review_count=0 で countSum=0）のときは
	// 証拠も事前分布も無く定義不能。NaN を company 軸へ漏らさず中立（null＝分母除外）へ倒す。
	const denominator = priorStrength + countSum;
	if (denominator <= 0) return null;
	return clamp01((priorStrength * priorMean + evidenceSum) / denominator);
}

// 評判寄与の信頼度（#37 の低信頼フラグ UI が消費する 3 値）。
// - none: 採用行なし・全 NULL・評価不能（データなし＝中立）。
// - low: 証拠（Σnᵢ）が事前分布 C 未満で、中立 prior が過半を占める（低信頼）。
// - ok: 証拠が C 以上で素の評価を信頼できる。
export type ReputationConfidence = "none" | "low" | "ok";

// スナップショット群の評判寄与の信頼度を判定する（決定的・§5.2）。
//
// なぜ閾値が Σnᵢ < priorStrength(C) か:
// - ベイズ平均 rep=(C·m+Σnx)/(C+Σn) の事前分布の重みは C/(C+Σn)。Σn<C のとき過半（>0.5）を中立 prior が
//   占めるため、件数が C 未満なら「素の評価より中立に寄った低信頼な値」とみなす。
// - usable=0 / 分母 0 は computeReputationScore が null を返すケースと一致させ none（中立）に倒す。
export function classifyReputationConfidence(
	snapshots: readonly ReputationSnapshotRow[],
	config: ReputationWeightConfig = DEFAULT_REPUTATION_WEIGHT_CONFIG,
): ReputationConfidence {
	const { countSum, usable } = reduceUsableEvidence(snapshots, config);
	if (usable === 0) return "none";
	if (config.priorStrength + countSum <= 0) return "none";
	return countSum < config.priorStrength ? "low" : "ok";
}

// 評判の company 軸への寄与（スコア＋信頼度）。UI（#37）とスコア合流（#117）の共有契約。
export interface ReputationContribution {
	readonly score: number | null;
	readonly confidence: ReputationConfidence;
}

// ANTHROPIC_API_KEY の構成状態を踏まえた評判寄与を解決する（決定的・§5.2 unknown 中立）。
//
// なぜキー未設定で中立除外か:
// - 評判検索（#30）は Claude API キーを必須とする。未設定では評判を取得できないため、寄与を null（中立）に倒し
//   company 軸の分母から外す。他項目（companySize / capital 等）のスコアリングは成立させる（受け入れ条件）。
// - score=null（データなし・評価不能）のとき confidence は必ず none に揃え、computeReputationScore と整合させる。
//
// seam（#117 へ委譲）: apiKeyConfigured / snapshots の供給（env presence・求人→企業名 ingest 配線）は本層では
// 行わない。呼び出し側がこの寄与を WeightedTerm として company 軸へ載せる。
export function resolveReputationContribution(
	apiKeyConfigured: boolean,
	snapshots: readonly ReputationSnapshotRow[],
	config: ReputationWeightConfig = DEFAULT_REPUTATION_WEIGHT_CONFIG,
): ReputationContribution {
	if (!apiKeyConfigured) return { score: null, confidence: "none" };
	const score = computeReputationScore(snapshots, config);
	if (score === null) return { score: null, confidence: "none" };
	return { score, confidence: classifyReputationConfidence(snapshots, config) };
}

// company 軸の 1 項目分の重み付き値。companySize / capital のサブスコアや評判寄与を表す。
// score=null は unknown 中立として分母から除外する（scoreJob と同じ流儀）。
export interface WeightedTerm {
	readonly score: number | null;
	readonly weight: number;
}

// 正規化加重平均（null 項目は分母から除外）。採用項目ゼロなら null を返す（§5.2 unknown 中立）。
// scoreJob の総合スコア（Σwᵢsᵢ / Σwᵢ）と同じ集約則を company 軸内の項目集約へ適用する。
export function weightedAverageExcludingUnknown(
	terms: readonly WeightedTerm[],
): number | null {
	let weightedSum = 0;
	let weightTotal = 0;
	for (const t of terms) {
		if (t.score === null) continue;
		weightedSum += t.weight * t.score;
		weightTotal += t.weight;
	}
	return weightTotal === 0 ? null : weightedSum / weightTotal;
}

// company 軸の集約値（0..1 | null）を算出する（評判を合流・新軸は作らない）。
//
// - itemTerms: companySize / capital 等 company 軸項目のサブスコア（scoreJob breakdown 由来）と重み。
// - snapshots: 当該企業の取得元別最新スナップショット（listLatestReputationSnapshots 由来）。
// 評判は config.weight の 1 項目として加重平均へ合流する。評判データ無し（computeReputationScore→null）の
// ときは評判項目を分母から外し、企業項目だけで集約する（unknown 中立）。全項目 null なら company 軸は null。
//
// seam（#117 へ委譲）: companyId / snapshots の供給（求人→企業名の解決・ingest 配線）は本層では行わない。
// 呼び出し側が company 軸の項目サブスコアと当該企業の snapshots を渡すことで、評判が company 軸へ合流する。
export function foldReputationIntoCompanyAxis(
	itemTerms: readonly WeightedTerm[],
	snapshots: readonly ReputationSnapshotRow[],
	config: ReputationWeightConfig = DEFAULT_REPUTATION_WEIGHT_CONFIG,
): number | null {
	const reputation = computeReputationScore(snapshots, config);
	const reputationTerm: WeightedTerm = {
		score: reputation,
		weight: config.weight,
	};
	return weightedAverageExcludingUnknown([...itemTerms, reputationTerm]);
}

// 総合スコアへ企業評判を read-time で畳み込む（#181）。
//
// なぜ再スコアリングしないか:
// - 評判は動的（取得タイミング・キャッシュ鮮度で変わる）で AI 非再実行（§5.3）。永続 __total__ は config 項目
//   のみで確定させ、評判は詳細/一覧を読む時点でのみ重ねる。これで「重み変更で AI 再実行しない」ガードレールを
//   崩さずに評判を total・順位へ効かせられる（抽出↔スコアリング分離 §5.3）。
//
// なぜ厳密一致するか:
// - persistedTotal は Σwᵢsᵢ/Σwᵢ（included 項目のみ）。これを「重み Σwᵢ の 1 項目」として評判項目と再度
//   加重平均すると combined = (Σwᵢsᵢ + wr·sr)/(Σwᵢ + wr) となり、評判を含めて 1 回で加重平均した値に一致する。
// - includedWeightTotal は scoreJob の分母（included かつ score!=null の項目重み合計）。呼び出し側が breakdown から
//   sumIncludedWeights で算出する。評判 score=null（未取得・キー未設定・低信頼）は分母から外す（unknown 中立）。
export function combineTotalWithReputation(
	persistedTotal: number | null,
	includedWeightTotal: number,
	reputation: WeightedTerm,
): number | null {
	return weightedAverageExcludingUnknown([
		{ score: persistedTotal, weight: includedWeightTotal },
		reputation,
	]);
}

// scoreJob の分母（included かつ score!=null の項目重み合計）を breakdown から復元する。
// combineTotalWithReputation に渡す persistedTotal の重みに使う。永続 total と同じ集約則で一致させる。
export function sumIncludedWeights(
	breakdown: readonly {
		readonly weight: number;
		readonly score: number | null;
		readonly included: boolean;
	}[],
): number {
	let total = 0;
	for (const row of breakdown) {
		if (row.included && row.score !== null) total += row.weight;
	}
	return total;
}

// sub_scores_json（観点別スコアの JSON 文字列）を安全に解釈する（決定的）。
// 取得層（web-search.ts / manual.ts）は string→有限非負数の record を保存するが、JSON は外部由来のため
// 防御的に parse する。非オブジェクト・不正 JSON・非有限値は中立扱いで落とす。有効値が 1 つも無ければ null。
//
// 観点別スコアの 5 軸への割り当て（例: 給与→compensation）は開集合・プロンプト依存のため本層では行わない。
// company 軸合流は overall_score を用いる。sub-score の UI 表示・軸マッピングは #37 / #117 に委ねる。
export function parseReputationSubScores(
	subScoresJson: string | null,
): Record<string, number> | null {
	if (subScoresJson === null || subScoresJson === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(subScoresJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			out[key] = value;
		}
	}
	return Object.keys(out).length === 0 ? null : out;
}
