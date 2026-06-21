// 日本語求人抽出のモデル比較ハーネス（スパイク #15）。
//
// なぜこのモジュールが存在するか:
// - デフォルト抽出モデルを「複数求人 × 複数モデルの抽出結果を並べて」決めるため（#15 DoD）。
// - AI 出力そのものの良し悪し（精度）は非決定的で人間が rubric で判定する。一方、
//   抽出結果（NormalizedJob）の集計・モデル間 diff は決定的にでき、ユニットテストで担保する。
// - 実推論は account/binding 依存でオフライン不可。AI は AiRunner として注入し、
//   live 実行は人間が wrangler 経由で行う（docs/spikes 参照）。本モジュールは「整形・比較」を担う。
//
// 設計の分担:
// - summarizeExtraction / diffJobs: 決定的・純関数（テスト対象）。
// - compareModels: extractJob を回す薄いオーケストレータ（AI 注入・テストは fake で検証）。

import type { AiRunner } from "./ai";
import { extractJob } from "./extract";
import {
	isUnknown,
	NORMALIZED_KEYS,
	type NormalizedJob,
	type NormalizedKey,
} from "./job-schema";

// 比較候補モデルのメタ。id は一次ソース（Cloudflare Workers AI Models）掲載の表記をそのまま使う。
// jsonModeListed は「JSON Mode 機能ページの対応モデル一覧」に載るか（2026-06-21 時点・要再確認）。
// note は extractJob の現行経路（response_format=json_schema）での扱いに関する一次ソース所見。
export interface CandidateModel {
	readonly id: string;
	// JSON Mode 機能ページの「対応モデル一覧」掲載有無（一次ソース確認結果）。
	readonly jsonModeListed: boolean;
	// 役割（baseline=現行デフォルト / candidate=#15 の比較対象）。
	readonly role: "baseline" | "candidate";
	readonly note: string;
}

// 一次ソース確認結果（2026-06-21）:
// - JSON Mode 機能ページ /workers-ai/features/json-mode/ の "models that now support JSON Mode"
//   一覧（7 件）に gpt-oss-120b と llama-4-scout は不在。llama-3.3-70b-fp8-fast は掲載。
// - 各モデルの sync-input.json（API スキーマ）は両候補とも response_format を受理する。
//   ただし機能ページの保証対象外であり、実機での JSON 妥当性は要手動検証。
// - gpt-oss-120b は OpenAI 互換 Responses API（/ai/v1/responses）系。env.AI.run の
//   response_format 経路での JSON Mode は機能ページ未掲載のため確証なし（要手動検証）。
// 詳細は docs/spikes/2026-06-21-model-comparison.md。
export const CANDIDATE_MODELS: readonly CandidateModel[] = [
	{
		id: "@cf/openai/gpt-oss-120b",
		jsonModeListed: false,
		role: "candidate",
		note: "JSON Mode 一覧に未掲載。response_format はスキーマ上受理するが要手動検証。reasoning 系。",
	},
	{
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
		jsonModeListed: false,
		role: "candidate",
		note: "JSON Mode 一覧に未掲載。response_format と guided_json をスキーマ上受理。要手動検証。",
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		jsonModeListed: true,
		role: "baseline",
		note: "JSON Mode 一覧に掲載。現行デフォルト（EXTRACTION_MODEL）。比較の基準。",
	},
];

// 抽出結果の決定的サマリ。present（値あり）/ unknown（中立）を数え、比較の母数にする。
export interface ExtractionSummary {
	readonly valueCount: number;
	readonly unknownCount: number;
	// 値が取れたキー（present）。NORMALIZED_KEYS の順序を保つ。
	readonly presentKeys: readonly NormalizedKey[];
}

// NormalizedJob を present/unknown に集計する（決定的）。
// なぜ: 抽出率（どれだけ拾えたか）はモデル比較の一次指標で、決定的に出せる。
export function summarizeExtraction(job: NormalizedJob): ExtractionSummary {
	const presentKeys = NORMALIZED_KEYS.filter((key) => !isUnknown(job[key]));
	return {
		valueCount: presentKeys.length,
		unknownCount: NORMALIZED_KEYS.length - presentKeys.length,
		presentKeys,
	};
}

// 2モデルの抽出結果をキー単位で比較した分類（網羅・排他）。
// agree/disagree は「両側 present」での raw 一致/不一致、onlyA/onlyB は片側のみ present、
// bothUnknown は両側 unknown。各キーはちょうど 1 分類に属する。
export interface JobDiff {
	readonly agree: readonly NormalizedKey[];
	readonly disagree: readonly NormalizedKey[];
	readonly onlyA: readonly NormalizedKey[];
	readonly onlyB: readonly NormalizedKey[];
	readonly bothUnknown: readonly NormalizedKey[];
}

// 値の素テキストを取り出す（present 同士の一致判定に使う）。
// kind 別に raw を持つため、raw を一致のキーとする（正規化前の原文一致を見る）。
function rawOf(job: NormalizedJob, key: NormalizedKey): string | undefined {
	return job[key].raw;
}

// 2モデルの NormalizedJob をキー単位で diff する（決定的）。
export function diffJobs(a: NormalizedJob, b: NormalizedJob): JobDiff {
	const agree: NormalizedKey[] = [];
	const disagree: NormalizedKey[] = [];
	const onlyA: NormalizedKey[] = [];
	const onlyB: NormalizedKey[] = [];
	const bothUnknown: NormalizedKey[] = [];

	for (const key of NORMALIZED_KEYS) {
		const aPresent = !isUnknown(a[key]);
		const bPresent = !isUnknown(b[key]);
		if (aPresent && bPresent) {
			(rawOf(a, key) === rawOf(b, key) ? agree : disagree).push(key);
		} else if (aPresent) {
			onlyA.push(key);
		} else if (bPresent) {
			onlyB.push(key);
		} else {
			bothUnknown.push(key);
		}
	}
	return { agree, disagree, onlyA, onlyB, bothUnknown };
}

// 比較用 fixture（求人本文）。実ページは直コミットせず合成 fixture か手元 HTML を使う（#9 踏襲）。
export interface JobFixture {
	readonly name: string;
	readonly body: string;
}

// 1モデル分の抽出結果（fixture 単位の行に並べる）。
export interface ModelExtraction {
	readonly model: string;
	readonly job: NormalizedJob;
	readonly summary: ExtractionSummary;
}

// fixture 1件についての全モデル横並び結果。
export interface FixtureComparison {
	readonly fixture: string;
	readonly results: readonly ModelExtraction[];
}

// モデル × fixture で extractJob を回し、横並び比較レポートを返す（AI 注入）。
// live 推論は人間が binding 経由で行う前提。本関数はオーケストレーションと集計のみ。
export async function compareModels(
	ai: AiRunner,
	fixtures: readonly JobFixture[],
	models: readonly string[],
): Promise<FixtureComparison[]> {
	const report: FixtureComparison[] = [];
	for (const fixture of fixtures) {
		const results: ModelExtraction[] = [];
		for (const model of models) {
			const { job } = await extractJob(ai, fixture.body, model);
			results.push({ model, job, summary: summarizeExtraction(job) });
		}
		report.push({ fixture: fixture.name, results });
	}
	return report;
}
