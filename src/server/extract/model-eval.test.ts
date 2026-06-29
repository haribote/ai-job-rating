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

	// #153 で flexWork recall を改善した候補が baseline を厳密支配した実例の固定。
	// 全フィールド非劣化かつ overall 改善なら strict gate を素直に通過する（選択肢(c) の正常系）。
	it("厳密支配する候補（全フィールド非劣化＋overall 改善）を採用する（#153 実例）", () => {
		const baseline = result("base", {
			flexWork: [2, 4],
			annualSalary: [8, 17],
			remoteWork: [6, 17],
		});
		// flexWork を 2→4 に改善し、他フィールドも一切劣化させず overall を大幅改善する。
		const dominant = result("dominant", {
			flexWork: [4, 4],
			annualSalary: [14, 17],
			remoteWork: [13, 17],
		});

		const sel = selectModel(baseline, [dominant]);

		expect(sel.selectedModel).toBe("dominant");
		expect(sel.changed).toBe(true);
	});

	// (c) で意図的に維持する挙動: overall が大幅改善でも単一フィールドが劣化する候補は veto し baseline 据置。
	// #141 の候補（overall +大幅だが flexWork 劣化）がこのゲートで弾かれた実例に対応する。
	// recall 改善（#153）で正攻法に解消したため、本 issue ではこの strict gate を変更しない（選択肢(c)）。
	it("overall 大幅改善でも単一フィールド劣化は veto し baseline を据え置く（#141・(c) で意図的に維持）", () => {
		const baseline = result("base", {
			flexWork: [4, 4],
			annualSalary: [8, 17],
			remoteWork: [9, 17],
		});
		// overall は 21→35 と大幅改善するが flexWork が 4→3 へ劣化する → 単一フィールド veto。
		const regressing = result("regressing", {
			flexWork: [3, 4],
			annualSalary: [16, 17],
			remoteWork: [16, 17],
		});

		const sel = selectModel(baseline, [regressing]);

		expect(sel.selectedModel).toBe("base");
		expect(sel.changed).toBe(false);
		const flex = sel.comparisons[0].perField.find((f) => f.key === "flexWork");
		expect(flex?.regressed).toBe(true);
	});

	// 同点・複数 acceptable 候補のタイブレークが決定的であること（同一入力で同一選定）。
	// 実装は overall correct を厳密に上回る（>）候補のみ採用するため、同点では配列順で先着が勝つ。
	it("同点で複数の acceptable 候補がある場合は配列順の先着を決定的に採用する", () => {
		const baseline = result("base", { annualSalary: [5, 10] });
		const first = result("first", { annualSalary: [8, 10] });
		const second = result("second", { annualSalary: [8, 10] });

		const sel = selectModel(baseline, [first, second]);

		// first が bestCorrect=8 を確定し、second は > 8 でないため採用されない。
		expect(sel.selectedModel).toBe("first");
		expect(sel.changed).toBe(true);
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

// 候補カタログ（#106・id の単一ソース）: eval コスト削減で本採用 gpt-oss-20b 1 件に絞り込み済み。
describe("EXTRACTION_MODEL_CANDIDATES", () => {
	it("全候補は Workers AI モデル ID（@cf/ 形式）で重複しない", () => {
		const ids = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		for (const id of ids) {
			expect(id.startsWith("@cf/")).toBe(true);
		}
		expect(new Set(ids).size).toBe(ids.length);
	});

	// #147 live 実証: gpt-oss は json-mode で動くが reasoning に budget を食うため、既定 max_tokens では
	// content 生成前に切れる。十分な maxTokens を持たせて救済する。
	it("本採用 gpt-oss-20b のみを保持し json-mode + maxTokens=16384 を持つ（#106）", () => {
		expect(EXTRACTION_MODEL_CANDIDATES).toHaveLength(1);
		const [c] = EXTRACTION_MODEL_CANDIDATES;
		expect(c.id).toBe("@cf/openai/gpt-oss-20b");
		expect(c.mechanism).toBe("json-mode");
		expect(c.maxTokens).toBe(16384);
	});
});
