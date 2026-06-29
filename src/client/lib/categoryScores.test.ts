import { describe, expect, it } from "vitest";
import { CATEGORY_KEYS } from "../../shared/categories";
import { aggregateCategoryScores } from "./categoryScores";
import type { BreakdownRow } from "./jobDetail";

// 内訳 1 行の最小ダミー。included/score/weight は試験ごとに上書きする。
function row(
	over: Partial<BreakdownRow> & Pick<BreakdownRow, "key">,
): BreakdownRow {
	return {
		kind: "numericRange",
		weight: 1,
		score: 0.5,
		included: true,
		raw: "",
		hardFilter: "none",
		desired: null,
		...over,
	};
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
