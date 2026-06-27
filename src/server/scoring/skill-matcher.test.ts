import { describe, expect, it } from "vitest";
import { defaultSkillMatcher } from "./skill-matcher";

// 求人スキル集合 × 希望集合の決定的突合（#68・統合 skillMatch は #101）。
// 突合は純粋関数（同一入力→同一値）・正規化（大小/全半角/装飾記号無視）・unknown 中立。
describe("defaultSkillMatcher（求人スキル × 希望集合の決定的突合）", () => {
	it("求人スキルが空なら突合不能 = null（unknown 中立）", () => {
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: ["go"],
				jobSkills: [],
			}),
		).toBeNull();
	});

	it("希望集合が空なら意見なし = null（中立・加点も減点もしない）", () => {
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: [],
				jobSkills: ["go", "ts"],
			}),
		).toBeNull();
	});

	it("大小文字・全半角・装飾記号を無視して突合する（ラベル正規化）", () => {
		// 希望 "Go" と求人 "ＧＯ"（全角）は正規化後一致する
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: ["Go"],
				jobSkills: ["ＧＯ"],
			}),
		).toBe(1);
	});

	it("同一入力なら同一値を返す（決定的・§8）", () => {
		const input = {
			criterion: "skillMatch" as const,
			desired: ["go", "ts"],
			jobSkills: ["go", "rust"],
		};
		expect(defaultSkillMatcher(input)).toBe(defaultSkillMatcher(input));
	});

	it("求人側スキルの重複は正規化後に一意化して分母に数えない", () => {
		// 求人 [go, Go] は正規化後 [go] の1件。希望 [go] と一致割合 1.0。
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: ["go"],
				jobSkills: ["go", "Go"],
			}),
		).toBe(1);
	});

	it("一致割合（matched / 求人スキル数）を返す", () => {
		// 求人 [go, ts, rust] のうち希望 [go, ts] が一致するのは 2/3
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: ["go", "ts"],
				jobSkills: ["go", "ts", "rust"],
			}),
		).toBeCloseTo(2 / 3);
	});

	it("求人スキルを全て希望していれば 1.0", () => {
		expect(
			defaultSkillMatcher({
				criterion: "skillMatch",
				desired: ["go", "ts", "extra"],
				jobSkills: ["go", "ts"],
			}),
		).toBe(1);
	});
});
