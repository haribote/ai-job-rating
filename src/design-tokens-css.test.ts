import { describe, expect, it } from "vitest";
import { TOKEN_PREFIX, type TokenGroup, tokenGroups } from "./design-tokens";
import {
	renderStylesheet,
	renderTokensCss,
	tokenVar,
} from "./design-tokens-css";

// トークン名 → CSS 変数参照。UI から決定的に参照できる契約として担保する。
describe("tokenVar", () => {
	it("接頭辞付きの var() 参照を返す", () => {
		expect(tokenVar("color-primary")).toBe(
			`var(--${TOKEN_PREFIX}-color-primary)`,
		);
	});
});

// トークングループ → :root の custom properties。決定的（同一入力→同一出力）。
describe("renderTokensCss", () => {
	const sample: TokenGroup[] = [
		{ name: "color", tokens: { "color-bg": "#fff", "color-text": "#000" } },
		{ name: "spacing", tokens: { "space-1": "0.25rem" } },
	];

	it(":root ブロックで各トークンを --ajr-<キー> として宣言する", () => {
		const css = renderTokensCss(sample);
		expect(css).toContain(":root {");
		expect(css).toContain(`--${TOKEN_PREFIX}-color-bg: #fff;`);
		expect(css).toContain(`--${TOKEN_PREFIX}-color-text: #000;`);
		expect(css).toContain(`--${TOKEN_PREFIX}-space-1: 0.25rem;`);
	});

	it("グループ順・キー順を保持し決定的に出力する（同一入力→同一出力）", () => {
		expect(renderTokensCss(sample)).toBe(renderTokensCss(sample));
		const css = renderTokensCss(sample);
		// color グループが spacing グループより先に現れる
		expect(css.indexOf("color-bg")).toBeLessThan(css.indexOf("space-1"));
	});

	it("グループ名をコメントで区切る（可読性・由来の明示）", () => {
		const css = renderTokensCss(sample);
		expect(css).toContain("/* color */");
		expect(css).toContain("/* spacing */");
	});
});

// 完全なスタイルシート。:root トークン + ベース要素スタイルを連結する。
describe("renderStylesheet", () => {
	it("実トークンの :root と body のベーススタイルを含む", () => {
		const css = renderStylesheet(tokenGroups);
		expect(css).toContain(":root {");
		expect(css).toContain(`--${TOKEN_PREFIX}-color-primary:`);
		// ベース要素は CSS 変数を参照する（直書きしない）
		expect(css).toContain(`var(--${TOKEN_PREFIX}-color-text)`);
		expect(css).toContain("body {");
	});

	it("自動生成ファイルである旨のヘッダコメントを含む（手編集を防ぐ）", () => {
		const css = renderStylesheet(tokenGroups);
		expect(css.startsWith("/*")).toBe(true);
		expect(css).toContain("design-tokens");
	});

	it("決定的に出力する（同一入力→同一出力, §8）", () => {
		expect(renderStylesheet(tokenGroups)).toBe(renderStylesheet(tokenGroups));
	});

	it("SSR マークアップが使う要素のベーススタイルを網羅する", () => {
		const css = renderStylesheet(tokenGroups);
		// 既存 SSR ページ（main/h1/p/a/form/input/textarea/button/table）が素のままで整う最低限
		for (const selector of [
			"body {",
			"main {",
			"h1 {",
			"a {",
			"form {",
			"button {",
			"table {",
		]) {
			expect(css).toContain(selector);
		}
	});

	it("ベーススタイルが参照する var() は全て宣言済みトークンを指す（名前タイポ検出）", () => {
		const css = renderStylesheet(tokenGroups);
		const declared = new Set(tokenGroups.flatMap((g) => Object.keys(g.tokens)));
		// var(--ajr-<name>) を抽出し、未宣言の name が無いことを保証する
		const refPattern = new RegExp(`var\\(--${TOKEN_PREFIX}-([\\w-]+)\\)`, "g");
		const referenced = [...css.matchAll(refPattern)].map((m) => m[1]);
		expect(referenced.length).toBeGreaterThan(0);
		const undeclared = referenced.filter((name) => !declared.has(name));
		expect(undeclared).toEqual([]);
	});
});
