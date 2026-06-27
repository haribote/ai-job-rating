// 抽出モデルの横並び再評価ハーネス（#106 / 実装計画 Task 13）。
//
// なぜこのモジュールが存在するか:
// - 候補モデルを golden ゲート（#100 runGolden）でフィールド単位に横並び評価し、
//   「精度が現行以上・劣化なし」を合格条件に既定を差し替える判断を決定的に下す。
// - live 推論（account/secrets 依存）は extractor 生成の注入で driver 側へ分離し、
//   集計・比較・選定ロジックはオフラインでユニットテスト可能に保つ（§5.3 と同じ思想）。
// - 既定差し替え自体はアダプタ（extract.ts の resolveExtractionModel / wrangler.jsonc vars）で
//   行う。本モジュールは「どのモデルを既定にすべきか」を golden の事実から導くのみ。

import type { NormalizedKey } from "../../shared/job-schema";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type {
	FieldAccuracy,
	GoldenCase,
	GoldenExtractor,
	GoldenReport,
} from "./golden";
import { runGolden } from "./golden";

// 候補モデル 1 件の golden 評価結果。
export interface ModelGoldenResult {
	readonly model: string;
	readonly report: GoldenReport;
}

// 精度差（baseline=現行 vs candidate=候補）。
// 採点総数（total）は golden 期待値のみで決まりモデル非依存なので baseline/candidate で常に一致する。
// したがって劣化判定は correct 件数（同分母）で行い、浮動小数の誤差に依存させない。
export interface AccuracyDelta {
	readonly baseline: FieldAccuracy;
	readonly candidate: FieldAccuracy;
	// candidate.accuracy - baseline.accuracy（両者採点ありの時のみ。採点外は null）。表示用。
	readonly delta: number | null;
	// 候補が現行を下回るか（correct 件数で判定）。採点外（total=0）は false。
	readonly regressed: boolean;
}

// フィールド別の精度差（key 付き）。
export interface FieldComparison extends AccuracyDelta {
	readonly key: NormalizedKey;
}

// 1 候補 vs 現行の横並び比較。
export interface ModelComparison {
	readonly baselineModel: string;
	readonly candidateModel: string;
	readonly overall: AccuracyDelta;
	readonly perField: readonly FieldComparison[];
	// 既定差し替え合格条件: 全体が現行以上 かつ どのフィールドも劣化なし。
	readonly acceptable: boolean;
}

// モデル選定結果（既定をどれにするか）。
export interface ModelSelection {
	readonly baselineModel: string;
	// 既定に採用すべきモデル。合格候補が無ければ現行を維持する（差し戻し）。
	readonly selectedModel: string;
	readonly changed: boolean;
	readonly comparisons: readonly ModelComparison[];
}

// 2 つの FieldAccuracy を比較する。劣化判定は correct 件数（同分母前提）で行う。
function compareAccuracy(
	baseline: FieldAccuracy,
	candidate: FieldAccuracy,
): AccuracyDelta {
	const scored = baseline.total > 0 && candidate.total > 0;
	const delta =
		baseline.accuracy !== null && candidate.accuracy !== null
			? candidate.accuracy - baseline.accuracy
			: null;
	const regressed = scored && candidate.correct < baseline.correct;
	return { baseline, candidate, delta, regressed };
}

// 現行レポートと候補レポートを横並び比較し、合格可否を決める（決定的）。
export function compareModels(
	baseline: ModelGoldenResult,
	candidate: ModelGoldenResult,
): ModelComparison {
	const perField: FieldComparison[] = NORMALIZED_KEYS.map((key) => ({
		key,
		...compareAccuracy(
			baseline.report.perField[key],
			candidate.report.perField[key],
		),
	}));
	const overall = compareAccuracy(
		baseline.report.overall,
		candidate.report.overall,
	);
	const acceptable = !overall.regressed && perField.every((f) => !f.regressed);
	return {
		baselineModel: baseline.model,
		candidateModel: candidate.model,
		overall,
		perField,
		acceptable,
	};
}

// 候補群を現行と横並び評価し、既定に採用すべきモデルを選ぶ（決定的）。
// 合格（精度が現行以上・劣化なし）した候補のうち overall correct を厳密に上回る最良を採用。
// 同点・合格者なしは現行を維持する（無用な切替を避け、劣化なら差し戻す）。
export function selectModel(
	baseline: ModelGoldenResult,
	candidates: readonly ModelGoldenResult[],
): ModelSelection {
	const comparisons = candidates.map((c) => compareModels(baseline, c));
	let selectedModel = baseline.model;
	let bestCorrect = baseline.report.overall.correct;
	candidates.forEach((c, i) => {
		if (!comparisons[i].acceptable) return;
		if (c.report.overall.correct > bestCorrect) {
			selectedModel = c.model;
			bestCorrect = c.report.overall.correct;
		}
	});
	return {
		baselineModel: baseline.model,
		selectedModel,
		changed: selectedModel !== baseline.model,
		comparisons,
	};
}

// 候補モデル群を golden で横並び実行し、既定選定まで行う（extractor 生成を注入）。
// live ドライバは makeExtractor = (model) => (html) =>
//   extractJob(ai, trimHtml(html), { model }).then((r) => r.job) を渡す。
// テストは決定的な fake makeExtractor を渡し、live 推論に依存させない。
export async function evaluateModels(
	cases: readonly GoldenCase[],
	baselineModel: string,
	candidateModels: readonly string[],
	makeExtractor: (model: string) => GoldenExtractor,
): Promise<ModelSelection> {
	const baseline: ModelGoldenResult = {
		model: baselineModel,
		report: await runGolden(cases, makeExtractor(baselineModel)),
	};
	const candidates: ModelGoldenResult[] = [];
	for (const model of candidateModels) {
		candidates.push({
			model,
			report: await runGolden(cases, makeExtractor(model)),
		});
	}
	return selectModel(baseline, candidates);
}
