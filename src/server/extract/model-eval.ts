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
	// context window（tokens）。モデルページ未確認は null（要確認）。
	readonly contextWindow: number | null;
	// 価格（USD / M tokens）。未掲載・未確認は null（要確認）。
	readonly inputUsdPerMTok: number | null;
	readonly outputUsdPerMTok: number | null;
	// 弱点・留意（日本語）。
	readonly note: string;
}

// 抽出モデル再評価の候補カタログ（#106・id の単一ソース）。現行既定（EXTRACTION_MODEL）は baseline
// として別に与えるため本配列には含めない。live ドライバは EXTRACTION_MODEL_CANDIDATES.map((c) => c.id) を
// candidateModels に渡す。
// 機構の注意: JSON Mode 公式対応は現行 Llama 3.x 系のみ。下記 FC 系を既定化するには機構アダプタ拡張が要る。
export const EXTRACTION_MODEL_CANDIDATES: readonly ModelCandidate[] = [
	{
		id: "@cf/meta/llama-3.1-8b-instruct-fast",
		mechanism: "json-mode",
		contextWindow: null,
		inputUsdPerMTok: null,
		outputUsdPerMTok: null,
		note: "JSON Mode 公式対応・高速安価。context/価格はモデルページで要確認（fp8-fast 変種は $0.045/$0.384）。",
	},
	{
		id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
		mechanism: "function-calling",
		contextWindow: 128000,
		inputUsdPerMTok: 0.351,
		outputUsdPerMTok: null,
		note: "広 context・多言語。出力価格は pricing 表 truncated で要確認。機構=FC。",
	},
	{
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
		mechanism: "function-calling",
		contextWindow: null,
		inputUsdPerMTok: null,
		outputUsdPerMTok: null,
		note: "広 context・高速（MoE 17B active）。#15 で JSON Mode 取りこぼし（required 未指定）。要 FC+検証。",
	},
	{
		id: "@cf/zai/glm-4.7-flash",
		mechanism: "function-calling",
		contextWindow: 131072,
		inputUsdPerMTok: null,
		outputUsdPerMTok: null,
		note: "131,072 context・高速・多言語100+。@cf 正式 ID と価格はモデルページで要確認。機構=FC。",
	},
	{
		id: "@cf/qwen/qwen3-30b-a3b-fp8",
		mechanism: "function-calling",
		contextWindow: null,
		inputUsdPerMTok: null,
		outputUsdPerMTok: null,
		note: "MoE（3B active=高速）・多言語・reasoning。context/価格は要確認。機構=FC。",
	},
	// --- ユーザー指示で追加（#138・各モデルページで一次確認済み 2026-06-27） ---
	{
		// https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/
		id: "@cf/openai/gpt-oss-120b",
		mechanism: "function-calling",
		contextWindow: 128000,
		inputUsdPerMTok: 0.35,
		outputUsdPerMTok: 0.75,
		note: "FC+reasoning。#15 実測で JSON Mode 非遵守（content=null/reasoning_content）。FC/Responses 経路前提。health 用既定でもある。",
	},
	{
		// https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/
		id: "@cf/openai/gpt-oss-20b",
		mechanism: "function-calling",
		contextWindow: 128000,
		inputUsdPerMTok: 0.2,
		outputUsdPerMTok: 0.3,
		note: "FC+reasoning・低レイテンシ版。gpt-oss 系は JSON Mode 非遵守（#15）。FC 経路前提。",
	},
	{
		// https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
		id: "@cf/google/gemma-4-26b-a4b-it",
		mechanism: "function-calling",
		contextWindow: 256000,
		inputUsdPerMTok: 0.1,
		outputUsdPerMTok: 0.3,
		note: "256k context・FC・reasoning・vision。広 context 最有力。JSON Mode 一覧外のため機構=FC。",
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
