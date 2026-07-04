import { describe, expect, it } from "vitest";
import { CATEGORY_KEYS } from "./categories";
import {
	aggregateCategoryScores,
	type CategoryBreakdownRow,
	type CategoryReputationContribution,
} from "./categoryScores";

// 評判寄与の最小ダミー。score / weight は試験ごとに上書きする。
function reputation(
	over: Partial<CategoryReputationContribution> = {},
): CategoryReputationContribution {
	return { score: 0.8, weight: 3, ...over };
}

// 内訳 1 行の最小ダミー。included/score/weight は試験ごとに上書きする。
function row(
	over: Partial<CategoryBreakdownRow> & Pick<CategoryBreakdownRow, "key">,
): CategoryBreakdownRow {
	return { weight: 1, score: 0.5, included: true, ...over };
}

describe("aggregateCategoryScores（軸集約・決定的純関数）", () => {
	it("5 軸すべてのキーを返す（値が無い軸は null）", () => {
		const result = aggregateCategoryScores([]);
		expect(Object.keys(result).sort()).toEqual([...CATEGORY_KEYS].sort());
		for (const key of CATEGORY_KEYS) {
			expect(result[key]).toBeNull();
		}
	});

	it("軸内は weight で加重平均する", () => {
		// compensation = annualSalary(w2,0.8) + bonus(w1,0.5) → (2*0.8 + 1*0.5)/3 = 0.7
		const result = aggregateCategoryScores([
			row({ key: "annualSalary", weight: 2, score: 0.8 }),
			row({ key: "bonus", weight: 1, score: 0.5 }),
		]);
		expect(result.compensation).toBeCloseTo(0.7, 10);
	});

	it("企業軸は companySize/capital を加重平均する", () => {
		// company = companySize(w2,0.9) + capital(w2,0.5) → (2*0.9 + 2*0.5)/4 = 0.7
		const result = aggregateCategoryScores([
			row({ key: "companySize", weight: 2, score: 0.9 }),
			row({ key: "capital", weight: 2, score: 0.5 }),
		]);
		expect(result.company).toBeCloseTo(0.7, 10);
	});

	it("unknown 中立（included=false）は分母から除外する", () => {
		// bonus を中立にすると compensation は annualSalary のみで決まる。
		const result = aggregateCategoryScores([
			row({ key: "annualSalary", weight: 2, score: 0.8 }),
			row({ key: "bonus", weight: 5, score: null, included: false }),
		]);
		expect(result.compensation).toBeCloseTo(0.8, 10);
	});

	it("軸内が全て unknown 中立なら null（0 点に潰さない）", () => {
		const result = aggregateCategoryScores([
			row({ key: "annualSalary", score: null, included: false }),
			row({ key: "bonus", score: null, included: false }),
		]);
		expect(result.compensation).toBeNull();
	});

	it("重み合計が 0 の軸は null（ゼロ除算を避ける）", () => {
		const result = aggregateCategoryScores([
			row({ key: "skillMatch", weight: 0, score: 0.9 }),
		]);
		expect(result.role).toBeNull();
	});
});

describe("aggregateCategoryScores（企業評判の company 軸合流・#117）", () => {
	it("評判は company 軸へ 1 項目として合流する（独立軸を作らない）", () => {
		// company = companySize(w1,0.4) + capital(w1,0.6) + 評判(w3,0.8) → (0.4+0.6+3*0.8)/(1+1+3)
		const result = aggregateCategoryScores(
			[
				row({ key: "companySize", weight: 1, score: 0.4 }),
				row({ key: "capital", weight: 1, score: 0.6 }),
			],
			reputation({ score: 0.8, weight: 3 }),
		);
		expect(result.company).toBeCloseTo((0.4 + 0.6 + 3 * 0.8) / 5, 10);
		// 5 軸のまま（評判専用の軸は増えない）。
		expect(Object.keys(result).sort()).toEqual([...CATEGORY_KEYS].sort());
	});

	it("評判 score=null（データなし/APIキー未設定）は分母から外し企業項目だけで成立する", () => {
		const result = aggregateCategoryScores(
			[
				row({ key: "companySize", weight: 1, score: 0.4 }),
				row({ key: "capital", weight: 1, score: 0.6 }),
			],
			reputation({ score: null }),
		);
		expect(result.company).toBeCloseTo((0.4 + 0.6) / 2, 10);
	});

	it("企業項目が全 unknown でも評判だけで company 軸が成立する", () => {
		const result = aggregateCategoryScores(
			[row({ key: "companySize", score: null, included: false })],
			reputation({ score: 0.7, weight: 3 }),
		);
		expect(result.company).toBeCloseTo(0.7, 10);
	});

	it("評判は company 軸のみに効き、他軸へ漏れない", () => {
		const result = aggregateCategoryScores(
			[row({ key: "annualSalary", weight: 1, score: 0.5 })],
			reputation({ score: 0.9, weight: 3 }),
		);
		expect(result.compensation).toBeCloseTo(0.5, 10);
		expect(result.company).toBeCloseTo(0.9, 10);
	});

	it("評判未指定（undefined）でも従来どおり集約する（後方互換）", () => {
		const withRep = aggregateCategoryScores([
			row({ key: "companySize", weight: 1, score: 0.4 }),
		]);
		expect(withRep.company).toBeCloseTo(0.4, 10);
	});

	it("件数の少ない高評価は company 軸を支配しない（評判 score がベイズ収縮済みである前提）", () => {
		// 少件数高評価は seam 側で 0.5 付近へ収縮した score として渡る。多件数中評価（0.69）を超えない。
		const fewHigh = aggregateCategoryScores(
			[row({ key: "companySize", weight: 1, score: 0.5 })],
			reputation({ score: 0.52, weight: 3 }),
		).company as number;
		const manyMid = aggregateCategoryScores(
			[row({ key: "companySize", weight: 1, score: 0.5 })],
			reputation({ score: 0.69, weight: 3 }),
		).company as number;
		expect(manyMid).toBeGreaterThan(fewHigh);
	});

	it("決定的（同一入力で同値）", () => {
		const rows = [row({ key: "companySize", weight: 1, score: 0.4 })];
		const rep = reputation({ score: 0.8, weight: 3 });
		expect(aggregateCategoryScores(rows, rep).company).toBe(
			aggregateCategoryScores(rows, rep).company,
		);
	});
});
