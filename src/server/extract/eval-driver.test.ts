import { describe, expect, it } from "vitest";
import { formatModelSelection, selectGoldenFiles } from "./eval-driver";
import type { ModelComparison, ModelSelection } from "./model-eval";

// driver の純粋部分（ケース収集・整形）を決定的にユニットテストする。
// fetch する live 部分は .mjs（scripts/eval/eval-models.mjs）に薄く残し、本ロジックを共有する。

describe("selectGoldenFiles", () => {
	it("*.json（実体）と *.example.json（雛形）の双方を含め、非 JSON は除く", () => {
		const files = [
			"README.md",
			".gitignore",
			"sample-001.example.json",
			"acme-backend.json",
			"notes.txt",
		];
		expect(selectGoldenFiles(files)).toEqual([
			"acme-backend.json",
			"sample-001.example.json",
		]);
	});

	it("決定的に名前順へ整列する", () => {
		expect(selectGoldenFiles(["b.json", "a.json"])).toEqual([
			"a.json",
			"b.json",
		]);
	});
});

// テスト用の最小 ModelComparison を組み立てる。
function comparison(
	candidateModel: string,
	opts: {
		baselineCorrect: number;
		candidateCorrect: number;
		total: number;
		regressedKeys?: string[];
		acceptable: boolean;
	},
): ModelComparison {
	const baseline = {
		correct: opts.baselineCorrect,
		total: opts.total,
		accuracy: opts.total ? opts.baselineCorrect / opts.total : null,
	};
	const candidate = {
		correct: opts.candidateCorrect,
		total: opts.total,
		accuracy: opts.total ? opts.candidateCorrect / opts.total : null,
	};
	const delta =
		baseline.accuracy !== null && candidate.accuracy !== null
			? candidate.accuracy - baseline.accuracy
			: null;
	return {
		baselineModel: "base",
		candidateModel,
		overall: { baseline, candidate, delta, regressed: !opts.acceptable },
		// perField は regressed フィールドだけ表現できれば整形検証に十分。
		perField: (opts.regressedKeys ?? []).map((key) => ({
			key: key as ModelComparison["perField"][number]["key"],
			baseline,
			candidate,
			delta,
			regressed: true,
		})),
		acceptable: opts.acceptable,
	};
}

describe("formatModelSelection", () => {
	it("候補ごとに overall delta・regressed 一覧、末尾に selected/changed を出す", () => {
		const selection: ModelSelection = {
			baselineModel: "base",
			selectedModel: "winner",
			changed: true,
			comparisons: [
				comparison("winner", {
					baselineCorrect: 5,
					candidateCorrect: 8,
					total: 10,
					acceptable: true,
				}),
				comparison("loser", {
					baselineCorrect: 5,
					candidateCorrect: 2,
					total: 10,
					regressedKeys: ["annualSalary", "overtime"],
					acceptable: false,
				}),
			],
		};

		const out = formatModelSelection(selection);

		// baseline 行と各候補行、勝者行が含まれる。
		expect(out).toContain("baseline: base");
		expect(out).toContain("winner");
		expect(out).toContain("loser");
		// delta は符号付き％で出る。
		expect(out).toContain("+30.0%");
		// regressed フィールドが列挙される / 劣化なしは none。
		expect(out).toContain("annualSalary, overtime");
		expect(out).toContain("none");
		// 末尾に勝者と changed。
		expect(out).toContain("selected: winner");
		expect(out).toContain("changed: yes");
	});

	it("comparisons が空でも baseline と selected を出す（落ちない）", () => {
		const selection: ModelSelection = {
			baselineModel: "base",
			selectedModel: "base",
			changed: false,
			comparisons: [],
		};
		const out = formatModelSelection(selection);
		expect(out).toContain("baseline: base");
		expect(out).toContain("selected: base");
		expect(out).toContain("changed: no");
	});
});
