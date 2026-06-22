import { describe, expect, it } from "vitest";
import { defaultSkillMatcher } from "./skill-matcher";

// 求人スキル集合 × 希望集合の決定的突合（#68）。
// 突合は純粋関数（同一入力→同一値）・正規化（大小/全半角/装飾記号無視）・unknown 中立。
describe("defaultSkillMatcher（求人スキル × 希望集合の決定的突合）", () => {
	describe("共通の前処理（正規化・unknown 中立）", () => {
		it("求人スキルが空なら突合不能 = null（unknown 中立）", () => {
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: ["go"],
					jobSkills: [],
				}),
			).toBeNull();
		});

		it("大小文字・全半角・装飾記号を無視して突合する（ラベル正規化）", () => {
			// 希望 "Go" と求人 "ＧＯ"（全角）は正規化後一致する
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: ["Go"],
					jobSkills: ["ＧＯ"],
				}),
			).toBe(1);
		});

		it("同一入力なら同一値を返す（決定的・§8）", () => {
			const input = {
				criterion: "requiredSkillsMatch" as const,
				desired: ["go", "ts"],
				jobSkills: ["go", "rust"],
			};
			expect(defaultSkillMatcher(input)).toBe(defaultSkillMatcher(input));
		});

		it("求人側スキルの重複は正規化後に一意化して分母に数えない", () => {
			// 求人 [go, Go] は正規化後 [go] の1件。希望 [go] と一致割合 1.0。
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: ["go"],
					jobSkills: ["go", "Go"],
				}),
			).toBe(1);
		});
	});

	describe("requiredSkillsMatch（必須充足）", () => {
		// 必須は求人の must-have を希望集合がどれだけ満たすか（分母 = 求人スキル数）。
		it("求人の必須スキルを全て満たせば 1.0（全充足）", () => {
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: ["go", "ts", "extra"],
					jobSkills: ["go", "ts"],
				}),
			).toBe(1);
		});

		it("一部しか満たさなければ充足割合（matched / 求人スキル数）", () => {
			// 求人 [go, ts, rust] のうち希望 [go, ts] が満たすのは 2/3
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: ["go", "ts"],
					jobSkills: ["go", "ts", "rust"],
				}),
			).toBeCloseTo(2 / 3);
		});

		it("希望集合が空でも求人に必須がある以上 0.0（必須を満たさない）", () => {
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: [],
					jobSkills: ["go", "ts"],
				}),
			).toBe(0);
		});
	});

	describe("preferredSkillsMatch（任意加点）", () => {
		// 歓迎は加点。希望が無ければ意見なし = null（中立）。あれば加点割合。
		it("希望集合が空なら意見なし = null（中立・加点も減点もしない）", () => {
			expect(
				defaultSkillMatcher({
					criterion: "preferredSkillsMatch",
					desired: [],
					jobSkills: ["go", "ts"],
				}),
			).toBeNull();
		});

		it("希望と歓迎スキルの一致割合で加点する（matched / 求人スキル数）", () => {
			// 求人歓迎 [go, ts] のうち希望 [go] が一致 1/2 = 0.5
			expect(
				defaultSkillMatcher({
					criterion: "preferredSkillsMatch",
					desired: ["go"],
					jobSkills: ["go", "ts"],
				}),
			).toBe(0.5);
		});

		it("歓迎スキルを全て希望していれば 1.0", () => {
			expect(
				defaultSkillMatcher({
					criterion: "preferredSkillsMatch",
					desired: ["go", "ts"],
					jobSkills: ["go", "ts"],
				}),
			).toBe(1);
		});
	});

	describe("required と preferred の意味差", () => {
		it("希望空のとき required=0.0（必須未充足）/ preferred=null（中立）で挙動が分かれる", () => {
			const jobSkills = ["go", "ts"];
			expect(
				defaultSkillMatcher({
					criterion: "requiredSkillsMatch",
					desired: [],
					jobSkills,
				}),
			).toBe(0);
			expect(
				defaultSkillMatcher({
					criterion: "preferredSkillsMatch",
					desired: [],
					jobSkills,
				}),
			).toBeNull();
		});
	});
});
