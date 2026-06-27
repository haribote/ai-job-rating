import { describe, expect, it } from "vitest";
import { normalizeLockfileIndent } from "./lockfile-indent";

describe("normalizeLockfileIndent", () => {
	it("行頭の tab を 2-space に変換する", () => {
		const input = '{\n\t"name": "x"\n}\n';
		expect(normalizeLockfileIndent(input)).toBe('{\n  "name": "x"\n}\n');
	});

	it("ネストした tab を深さ分の 2-space に変換する", () => {
		const input = '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n';
		expect(normalizeLockfileIndent(input)).toBe(
			'{\n  "a": {\n    "b": 1\n  }\n}\n',
		);
	});

	it("既に 2-space の内容は変更しない（no-op）", () => {
		const input = '{\n  "a": {\n    "b": 1\n  }\n}\n';
		expect(normalizeLockfileIndent(input)).toBe(input);
	});

	it("2 回適用しても結果が変わらない（冪等）", () => {
		const input = '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n';
		const once = normalizeLockfileIndent(input);
		expect(normalizeLockfileIndent(once)).toBe(once);
	});

	it("tab と space が混在する行頭を正規化する", () => {
		// 1 階層分の tab と 2 space が混在 → 4 space に揃う
		const input = '{\n\t  "a": 1\n}\n';
		expect(normalizeLockfileIndent(input)).toBe('{\n    "a": 1\n}\n');
	});

	it("行頭以外（値の中身）の文字は変更しない", () => {
		// 値の中の \\t はエスケープ列（2 文字）であり実 tab ではないため不変
		const input = '{\n\t"path": "a\\tb"\n}\n';
		expect(normalizeLockfileIndent(input)).toBe('{\n  "path": "a\\tb"\n}\n');
	});

	it("末尾改行の有無を保持する", () => {
		expect(normalizeLockfileIndent('{\n\t"a": 1\n}')).toBe('{\n  "a": 1\n}');
	});

	it("空文字列はそのまま返す", () => {
		expect(normalizeLockfileIndent("")).toBe("");
	});

	it("正規化前後で JSON として等価", () => {
		const tabbed = '{\n\t"name": "x",\n\t"deps": {\n\t\t"a": "1.0.0"\n\t}\n}\n';
		expect(JSON.parse(normalizeLockfileIndent(tabbed))).toEqual(
			JSON.parse(tabbed),
		);
	});
});
