import { describe, expect, it } from "vitest";
import { matchSkills } from "./skill-matcher";

// 求人スキル集合 × ユーザー keyword の決定的ヒット採点（#105）。
// 純粋関数（同一入力→同一値）・正規化（大小/全半角/装飾記号無視）・ヒット率は keyword 基準。
describe("matchSkills（求人スキル × keyword の決定的ヒット率・0..100）", () => {
	it("keyword のうち求人に出現した割合を返す（matched / keyword 数）", () => {
		// keyword [go, ts] のうち求人 [go, ts, rust] に出現するのは 2/2 = 100
		expect(matchSkills(["go", "ts", "rust"], ["go", "ts"])).toBe(100);
	});

	it("一部のみヒットなら割合（keyword 基準）", () => {
		// keyword [go, python] のうち求人 [go, ts] に出現するのは go のみ 1/2 = 50
		expect(matchSkills(["go", "ts"], ["go", "python"])).toBe(50);
	});

	it("求人が多くのスキルを列挙しても keyword を満たせば不利にならない", () => {
		// keyword [go, ts] を両方満たす → 求人の列挙数（5件）に関わらず 100
		expect(
			matchSkills(["go", "ts", "react", "aws", "docker"], ["go", "ts"]),
		).toBe(100);
	});

	it("keyword が空なら null（意見なし＝中立・ゼロ除算防御）", () => {
		expect(matchSkills(["go", "ts"], [])).toBeNull();
	});

	it("正規化後に全て空へ潰れる keyword は null（装飾記号のみ等・減点でなく中立）", () => {
		// "・" や "/" は canonicalizeLabel で空になり有効 keyword が 0 → null
		expect(matchSkills(["go"], ["・", "/"])).toBeNull();
	});

	it("求人スキルが空なら 0（keyword はあるがどれも満たさない＝中立でなく不一致）", () => {
		expect(matchSkills([], ["go"])).toBe(0);
	});

	it("大小文字・全半角・装飾記号を無視して突合する（ラベル正規化）", () => {
		// keyword "Go" と求人 "ＧＯ"（全角）は正規化後一致する
		expect(matchSkills(["ＧＯ"], ["Go"])).toBe(100);
	});

	it("keyword の重複は正規化後に一意化して分母に数えない", () => {
		// keyword [go, Go] は正規化後 [go] の1件。求人 [go] と 1/1 = 100
		expect(matchSkills(["go"], ["go", "Go"])).toBe(100);
	});

	it("同一入力なら同一値を返す（決定的・§8）", () => {
		expect(matchSkills(["go", "rust"], ["go", "ts"])).toBe(
			matchSkills(["go", "rust"], ["go", "ts"]),
		);
	});
});
