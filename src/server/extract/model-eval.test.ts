import { describe, expect, it } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import { rawFieldsToNormalizedJob } from "./extract";
import type {
	FieldAccuracy,
	GoldenCase,
	GoldenExtractor,
	GoldenReport,
} from "./golden";
import {
	compareModels,
	EXTRACTION_MODEL_CANDIDATES,
	evaluateModels,
	type ModelGoldenResult,
	selectModel,
} from "./model-eval";

// テスト用に GoldenReport を組み立てる。指定キーのみ correct/total を与え、残りは {0,0,null}（採点外）。
// overall は与えたフィールドの合算。total はモデル非依存（golden 期待値で決まる）なので
// baseline/candidate で同分母に揃えて比較する前提を満たす。
function makeReport(
	fields: Partial<Record<string, [correct: number, total: number]>>,
): GoldenReport {
	const accuracyOf = (c: number, t: number): number | null =>
		t === 0 ? null : c / t;
	let overallCorrect = 0;
	let overallTotal = 0;
	const perFieldEntries = NORMALIZED_KEYS.map((key) => {
		const [correct, total] = fields[key] ?? [0, 0];
		overallCorrect += correct;
		overallTotal += total;
		const acc: FieldAccuracy = {
			correct,
			total,
			accuracy: accuracyOf(correct, total),
		};
		return [key, acc] as const;
	});
	return {
		perField: Object.fromEntries(perFieldEntries) as GoldenReport["perField"],
		overall: {
			correct: overallCorrect,
			total: overallTotal,
			accuracy: accuracyOf(overallCorrect, overallTotal),
		},
		perCase: [],
	};
}

const result = (
	model: string,
	fields: Partial<Record<string, [number, number]>>,
): ModelGoldenResult => ({ model, report: makeReport(fields) });

// 横並び比較（決定的）: 現行 vs 候補のフィールド別・全体の精度差と合格可否。
describe("compareModels", () => {
	it("候補が全体・全フィールドで上回れば acceptable（精度が現行以上・劣化なし）", () => {
		const baseline = result("base", {
			annualSalary: [5, 10],
			remoteWork: [5, 10],
		});
		const candidate = result("cand", {
			annualSalary: [8, 10],
			remoteWork: [9, 10],
		});

		const cmp = compareModels(baseline, candidate);

		expect(cmp.acceptable).toBe(true);
		expect(cmp.overall.regressed).toBe(false);
		const salary = cmp.perField.find((f) => f.key === "annualSalary");
		expect(salary?.delta).toBeCloseTo(0.3);
		expect(salary?.regressed).toBe(false);
	});

	it("全体が上回ってもフィールド単位で劣化があれば不合格（劣化なら差し戻し）", () => {
		const baseline = result("base", {
			annualSalary: [5, 10],
			remoteWork: [8, 10],
		});
		// 全体 correct は 14 > 13 だが remoteWork が 8→6 へ劣化する。
		const candidate = result("cand", {
			annualSalary: [8, 10],
			remoteWork: [6, 10],
		});

		const cmp = compareModels(baseline, candidate);

		expect(cmp.acceptable).toBe(false);
		const remote = cmp.perField.find((f) => f.key === "remoteWork");
		expect(remote?.regressed).toBe(true);
	});

	it("全フィールド同等なら acceptable（現行以上に等号を含む）", () => {
		const baseline = result("base", { annualSalary: [5, 10] });
		const candidate = result("cand", { annualSalary: [5, 10] });

		expect(compareModels(baseline, candidate).acceptable).toBe(true);
	});

	it("採点外フィールド（total=0）は delta=null・劣化扱いしない", () => {
		const baseline = result("base", { annualSalary: [5, 10] });
		const candidate = result("cand", { annualSalary: [5, 10] });

		const cmp = compareModels(baseline, candidate);
		const bonus = cmp.perField.find((f) => f.key === "bonus");
		expect(bonus?.delta).toBeNull();
		expect(bonus?.regressed).toBe(false);
	});
});

// モデル選定（決定的）: 合格候補のうち最良を採用。同点・合格者なしは現行維持（差し戻し）。
describe("selectModel", () => {
	it("合格候補のうち overall correct 最良を採用する", () => {
		const baseline = result("base", { annualSalary: [5, 10] });
		const better = result("better", { annualSalary: [7, 10] });
		const best = result("best", { annualSalary: [9, 10] });

		const sel = selectModel(baseline, [better, best]);

		expect(sel.selectedModel).toBe("best");
		expect(sel.changed).toBe(true);
	});

	it("合格候補が無ければ現行を維持する（劣化は差し戻し）", () => {
		const baseline = result("base", { annualSalary: [8, 10] });
		const worse = result("worse", { annualSalary: [4, 10] });

		const sel = selectModel(baseline, [worse]);

		expect(sel.selectedModel).toBe("base");
		expect(sel.changed).toBe(false);
	});

	it("候補が現行と同点なら切替コストを避け現行を維持する", () => {
		const baseline = result("base", { annualSalary: [5, 10] });
		const tie = result("tie", { annualSalary: [5, 10] });

		const sel = selectModel(baseline, [tie]);

		expect(sel.selectedModel).toBe("base");
		expect(sel.changed).toBe(false);
	});
});

// 横断 golden 実行 + 選定（extractor 生成を注入して live 推論に依存させない）。
describe("evaluateModels", () => {
	it("候補ごとに golden を実行し、現行を上回る候補を既定に選ぶ", async () => {
		const matching = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		const wrong = rawFieldsToNormalizedJob({ annualSalary: "100万" });
		const cases: GoldenCase[] = [
			{
				name: "c1",
				html: "x",
				expected: { annualSalary: matching.annualSalary },
			},
		];
		// good は期待値に一致、bad は外す決定的 fake。
		const makeExtractor =
			(model: string): GoldenExtractor =>
			async () =>
				model === "good" ? matching : wrong;

		const sel = await evaluateModels(cases, "bad", ["good"], makeExtractor);

		expect(sel.baselineModel).toBe("bad");
		expect(sel.selectedModel).toBe("good");
		expect(sel.changed).toBe(true);
	});
});

// 候補カタログ（#106・id の単一ソース）: 一次ソース確認した候補が整合した形で載っている。
describe("EXTRACTION_MODEL_CANDIDATES", () => {
	it("全候補は Workers AI モデル ID（@cf/ 形式）で重複しない", () => {
		const ids = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		for (const id of ids) {
			expect(id.startsWith("@cf/")).toBe(true);
		}
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("ユーザー指示の追加 3 モデルを含む（gpt-oss-120b/20b・gemma-4-26b）", () => {
		const ids = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		expect(ids).toContain("@cf/openai/gpt-oss-120b");
		expect(ids).toContain("@cf/openai/gpt-oss-20b");
		expect(ids).toContain("@cf/google/gemma-4-26b-a4b-it");
	});

	// #147 live 実証: gpt-oss は json-mode で動くが reasoning に budget を食うため、既定 max_tokens では
	// content 生成前に切れる。十分な maxTokens を持たせて救済する（FC は 3043 で非成立）。
	it("gpt-oss 系は json-mode かつ reasoning 分の maxTokens を持つ（#147）", () => {
		const gptOss = EXTRACTION_MODEL_CANDIDATES.filter((c) =>
			c.id.startsWith("@cf/openai/gpt-oss"),
		);
		expect(gptOss).toHaveLength(2);
		for (const c of gptOss) {
			expect(c.mechanism).toBe("json-mode");
			expect(c.maxTokens).toBe(16384);
		}
	});

	it("現行既定（baseline）は候補に含めない（baseline は別途与える）", () => {
		const ids = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		expect(ids).not.toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	});

	// #146: live で旧 ID は `5007 No such model`、正式 ID は wrangler ai models に存在（org prefix は zai-org）。
	it("GLM は正式 ID（@cf/zai-org/...）で、不正な @cf/zai/... を含まない", () => {
		const ids = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		expect(ids).toContain("@cf/zai-org/glm-4.7-flash");
		expect(ids).not.toContain("@cf/zai/glm-4.7-flash");
	});
});
