// デザイントークン → CSS 変換（決定的な純関数）。
//
// なぜこのモジュールが存在するか:
// - design-tokens.ts のデータを CSS custom properties（:root の --ajr-*）へ落とし込む。
//   この出力をビルド時に public/styles.css へ書き出し、リポジトリへコミットして実行時依存をなくす。
// - 変換は純関数・決定的（同一入力→同一出力）。ユニットテストで担保する（§8）。
// - ベース要素スタイルはトークン変数のみを参照し、生の値を直書きしない（トークンが単一の真実）。

import { TOKEN_PREFIX, type TokenGroup } from "./design-tokens";

// トークン名 → CSS 変数参照。UI コードはこれを介してトークンを参照する。
export function tokenVar(name: string): string {
	return `var(--${TOKEN_PREFIX}-${name})`;
}

// CSS 変数宣言名（`--ajr-<name>`）を組み立てる。
function varName(name: string): string {
	return `--${TOKEN_PREFIX}-${name}`;
}

// トークングループ群を :root の custom properties ブロックへ変換する。
// グループ順・グループ内のキー挿入順を保持し、決定的に出力する。
export function renderTokensCss(groups: TokenGroup[]): string {
	const lines: string[] = [":root {"];
	for (const group of groups) {
		lines.push(`\t/* ${group.name} */`);
		for (const [name, value] of Object.entries(group.tokens)) {
			lines.push(`\t${varName(name)}: ${value};`);
		}
	}
	lines.push("}");
	return lines.join("\n");
}

// ベース要素スタイル。トークン変数のみを参照する最小のリセット＋共通スタイル。
// SSR 各ページが共有する素朴なマークアップ（main / h1 / p / a / form / input / table 等）を整える。
function baseStyles(): string {
	const v = tokenVar;
	return [
		"*, *::before, *::after {",
		"\tbox-sizing: border-box;",
		"}",
		"",
		"body {",
		"\tmargin: 0;",
		`\tfont-family: ${v("font-sans")};`,
		`\tfont-size: ${v("font-size-base")};`,
		`\tline-height: ${v("line-height-base")};`,
		`\tcolor: ${v("color-text")};`,
		`\tbackground: ${v("color-bg")};`,
		"}",
		"",
		"main {",
		`\tmax-width: ${v("layout-max-width")};`,
		`\tmargin: 0 auto;`,
		`\tpadding: ${v("space-8")} ${v("space-4")};`,
		"}",
		"",
		"h1 {",
		`\tfont-size: ${v("font-size-xl")};`,
		`\tline-height: ${v("line-height-tight")};`,
		`\tfont-weight: ${v("font-weight-bold")};`,
		`\tmargin: 0 0 ${v("space-6")};`,
		"}",
		"",
		"p {",
		`\tmargin: 0 0 ${v("space-4")};`,
		"}",
		"",
		"a {",
		`\tcolor: ${v("color-primary")};`,
		"}",
		"",
		"strong {",
		`\tfont-weight: ${v("font-weight-bold")};`,
		"}",
		"",
		"label {",
		"\tdisplay: block;",
		`\tmargin-bottom: ${v("space-1")};`,
		`\tcolor: ${v("color-text-muted")};`,
		`\tfont-size: ${v("font-size-sm")};`,
		"}",
		"",
		"input, textarea, select, button {",
		"\tfont: inherit;",
		`\tcolor: ${v("color-text")};`,
		"}",
		"",
		"input, textarea, select {",
		`\tpadding: ${v("space-2")} ${v("space-3")};`,
		`\tborder: ${v("border-width")} solid ${v("color-border")};`,
		`\tborder-radius: ${v("radius-sm")};`,
		`\tbackground: ${v("color-bg")};`,
		"\tmax-width: 100%;",
		"}",
		"",
		"textarea {",
		"\twidth: 100%;",
		`\tfont-family: ${v("font-mono")};`,
		"}",
		"",
		"button {",
		`\tpadding: ${v("space-2")} ${v("space-6")};`,
		`\tborder: ${v("border-width")} solid transparent;`,
		`\tborder-radius: ${v("radius-sm")};`,
		`\tbackground: ${v("color-primary")};`,
		`\tcolor: ${v("color-primary-text")};`,
		`\tfont-weight: ${v("font-weight-bold")};`,
		"\tcursor: pointer;",
		"}",
		"",
		":focus-visible {",
		`\toutline: 2px solid ${v("color-focus-ring")};`,
		"\toutline-offset: 2px;",
		"}",
		"",
		"form {",
		`\tmargin: 0 0 ${v("space-4")};`,
		"\tdisplay: flex;",
		`\tgap: ${v("space-3")};`,
		"\tflex-wrap: wrap;",
		"\talign-items: flex-start;",
		"}",
		"",
		"table {",
		"\twidth: 100%;",
		"\tborder-collapse: collapse;",
		`\tmargin: 0 0 ${v("space-6")};`,
		`\tfont-size: ${v("font-size-sm")};`,
		"}",
		"",
		"th, td {",
		`\tpadding: ${v("space-2")} ${v("space-3")};`,
		`\tborder-bottom: ${v("border-width")} solid ${v("color-border")};`,
		"\ttext-align: left;",
		"}",
		"",
		"th {",
		`\tbackground: ${v("color-surface")};`,
		`\tcolor: ${v("color-text-muted")};`,
		`\tfont-weight: ${v("font-weight-bold")};`,
		"}",
	].join("\n");
}

// 完全なスタイルシート文字列。自動生成ヘッダ + :root トークン + ベーススタイルを連結する。
export function renderStylesheet(groups: TokenGroup[]): string {
	const header = [
		"/*",
		" * 自動生成ファイル — 直接編集しない。",
		" * 生成元: src/design-tokens.ts（トークン）+ src/design-tokens-css.ts（変換）。",
		" * 再生成: npm run build:css",
		" */",
	].join("\n");
	return `${header}\n\n${renderTokensCss(groups)}\n\n${baseStyles()}\n`;
}
