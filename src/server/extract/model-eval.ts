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

// 抽出機構（構造化出力の方式）。"json-mode" は Workers AI JSON Mode 公式対応、
// "function-calling" は FC（既定にするには extract.ts の出力機構を FC へアダプタ化する必要がある・#15 所見）。
export type ExtractionMechanism = "json-mode" | "function-calling";

// 評価候補モデル 1 件のメタ。一次ソースは各モデルの Cloudflare Workers AI docs
// （ID/価格/context/対応機構をそこで確認・記憶で書かない。出典 URL は docs/spikes/issue-106-model-reeval.md）。
export interface ModelCandidate {
	// Workers AI モデル ID（@cf/...）。live ドライバはこれを candidateModels として evaluateModels に渡す。
	readonly id: string;
	readonly mechanism: ExtractionMechanism;
	// ai.run の max_tokens 上限（#147）。未指定はモデル既定に委ねる。reasoning モデル（gpt-oss）は
	// 既定では reasoning で budget を使い切り content を生成できないため、十分な値を明示する。
	readonly maxTokens?: number;
	// context window（tokens）。モデルページ未確認は null（要確認）。
	readonly contextWindow: number | null;
	// 価格（USD / M tokens）。未掲載・未確認は null（要確認）。
	readonly inputUsdPerMTok: number | null;
	readonly outputUsdPerMTok: number | null;
	// 弱点・留意（日本語）。
	readonly note: string;
}

// 抽出モデルカタログ（id・機構・maxTokens の単一ソース）。本配列は二役を担う:
// (1) ランタイムの機構/maxTokens 解決源（mechanism.ts の resolveExtractionMechanism / resolveExtractionMaxTokens）。
// (2) live 横並び評価（#106）の候補種。live ドライバは EXTRACTION_MODEL_CANDIDATES.map((c) => c.id) を渡す。
// #106 系の再評価は完了し、本採用は @cf/openai/gpt-oss-20b（wrangler.jsonc vars.EXTRACTION_MODEL）。eval コスト
// 削減のため候補は採用済みモデル 1 件に絞る。評価済み 8 モデルの確定メタ・live 所見・最終結果は
// docs/spikes/issue-106-model-reeval.md に集約。将来モデルを評価するときは本配列へ追記して回す。
export const EXTRACTION_MODEL_CANDIDATES: readonly ModelCandidate[] = [
	{
		// https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/
		id: "@cf/openai/gpt-oss-20b",
		mechanism: "json-mode",
		// reasoning モデルは既定 max_tokens だと reasoning で budget を使い切り content 生成前に切れる（#147）。
		maxTokens: 16384,
		contextWindow: 128000,
		inputUsdPerMTok: 0.2,
		outputUsdPerMTok: 0.3,
		note: "reasoning・低レイテンシ版。#106 本採用。機構=json-mode（#145 parser で OpenAI choices 形を回収）。",
	},
];

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
	// 合格条件は strict gate のまま据え置く（#152 選択肢(c)）: 全体が現行以上 かつ どのフィールドも劣化なし。
	// #141 では overall 大幅優位でも単一フィールド（flexWork）劣化で候補が veto されたが、recall 改善（#153）で
	// 候補が baseline を厳密支配し正攻法に解消したため、許容劣化幅(a)/重み付き(b) は採らない。Refs #152 #153。
	// 留意: 合格は golden セット感度に依存し、別セットでは単一フィールド veto が再発しうる（将来 a/b 再検討の余地）。
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
