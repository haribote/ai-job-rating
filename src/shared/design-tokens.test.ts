import { describe, expect, it } from "vitest";
import {
	chartColorMap,
	colorTokens,
	hexToRgbChannels,
	layoutTokens,
	medalColorMap,
	shadcnColorMap,
	spacingTokens,
	surfaceTokens,
	toRootCssVars,
	toTailwindTheme,
	toThemeColors,
	typographyTokens,
} from "./design-tokens";

// hex → RGB チャンネル。Tailwind の <alpha-value> 合成で使う決定的変換。
describe("hexToRgbChannels", () => {
	it("6桁 hex を 10進チャンネル文字列に変換する", () => {
		expect(hexToRgbChannels("#ffffff")).toBe("255 255 255");
		expect(hexToRgbChannels("#2557d6")).toBe("37 87 214");
		expect(hexToRgbChannels("#1a1d21")).toBe("26 29 33");
	});

	it("省略形 #rgb を展開する", () => {
		expect(hexToRgbChannels("#fff")).toBe("255 255 255");
		expect(hexToRgbChannels("#0a0")).toBe("0 170 0");
	});

	it("不正な hex は例外", () => {
		expect(() => hexToRgbChannels("#xyz")).toThrow();
		expect(() => hexToRgbChannels("2557d6zz")).toThrow();
	});
});

// 単一ソース性: shadcn の CSS 変数と Tailwind theme が design-tokens から一意に導出される。
describe("toRootCssVars", () => {
	it("各意味カラー変数は対応トークンの RGB チャンネルに一致する（二重定義を排除）", () => {
		const vars = toRootCssVars();
		for (const [name, tokenKey] of Object.entries(shadcnColorMap)) {
			expect(vars[`--${name}`]).toBe(hexToRgbChannels(colorTokens[tokenKey]));
		}
	});

	it("チャート色も同じくトークン由来で宣言される", () => {
		const vars = toRootCssVars();
		for (const [name, tokenKey] of Object.entries(chartColorMap)) {
			expect(vars[`--${name}`]).toBe(hexToRgbChannels(colorTokens[tokenKey]));
		}
	});

	// ベスト3強調（#109）の金銀銅枠色。順位差は枠色で表すため意味カラーとは別系統で持つ。
	it("メダル色（金銀銅）もトークン由来で宣言される", () => {
		const vars = toRootCssVars();
		expect(Object.keys(medalColorMap)).toEqual([
			"medal-gold",
			"medal-silver",
			"medal-bronze",
		]);
		for (const [name, tokenKey] of Object.entries(medalColorMap)) {
			expect(vars[`--${name}`]).toBe(hexToRgbChannels(colorTokens[tokenKey]));
		}
	});

	it("--radius は radius-md トークンを供給する", () => {
		expect(toRootCssVars()["--radius"]).toBe(surfaceTokens["radius-md"]);
	});

	it("決定的に出力する（同一入力→同一出力, §8）", () => {
		expect(toRootCssVars()).toEqual(toRootCssVars());
	});
});

describe("toThemeColors", () => {
	it("各色は対応する CSS 変数を <alpha-value> 付きで参照する", () => {
		const colors = toThemeColors();
		expect(colors.background).toBe("rgb(var(--background) / <alpha-value>)");
		expect(colors.primary).toBe("rgb(var(--primary) / <alpha-value>)");
		expect(colors["chart-1"]).toBe("rgb(var(--chart-1) / <alpha-value>)");
		expect(colors["medal-gold"]).toBe("rgb(var(--medal-gold) / <alpha-value>)");
	});

	it("参照する全変数が toRootCssVars に宣言済み（名前タイポ検出）", () => {
		const declared = new Set(Object.keys(toRootCssVars()));
		const referenced = Object.values(toThemeColors()).map(
			(v) => `--${/var\(--([\w-]+)/.exec(v)?.[1]}`,
		);
		const undeclared = referenced.filter((name) => !declared.has(name));
		expect(undeclared).toEqual([]);
	});

	it("意味カラー名はすべて宣言済みの color トークンを参照する", () => {
		for (const tokenKey of Object.values(shadcnColorMap)) {
			expect(colorTokens[tokenKey]).toBeDefined();
		}
	});
});

// Tailwind theme.extend がトークンを単一ソースとして供給することを担保する。
describe("toTailwindTheme", () => {
	const theme = toTailwindTheme();

	it("colors は toThemeColors と一致する", () => {
		expect(theme.colors).toEqual(toThemeColors());
	});

	it("フォントファミリ・サイズはタイポグラフィトークン由来", () => {
		expect(theme.fontFamily.sans).toBe(typographyTokens["font-sans"]);
		expect(theme.fontFamily.mono).toBe(typographyTokens["font-mono"]);
		expect(theme.fontSize.base).toBe(typographyTokens["font-size-base"]);
		expect(theme.fontSize.xl).toBe(typographyTokens["font-size-xl"]);
	});

	it("spacing はプレフィックス無しキーでトークン値を供給する", () => {
		expect(theme.spacing["4"]).toBe(spacingTokens["space-4"]);
		expect(theme.spacing["0"]).toBe(spacingTokens["space-0"]);
		expect(theme.spacing.space).toBeUndefined();
	});

	it("borderRadius は --radius を基準に導出する", () => {
		expect(theme.borderRadius.lg).toBe("var(--radius)");
		expect(theme.borderRadius.md).toContain("var(--radius)");
	});

	it("boxShadow・maxWidth もトークン由来", () => {
		expect(theme.boxShadow.sm).toBe(surfaceTokens["shadow-sm"]);
		expect(theme.maxWidth.layout).toBe(layoutTokens["layout-max-width"]);
	});

	it("決定的に出力する（同一入力→同一出力, §8）", () => {
		expect(toTailwindTheme()).toEqual(toTailwindTheme());
	});
});
