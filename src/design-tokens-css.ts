// デザイントークン → CSS 変換（決定的な純関数）。
//
// なぜこのモジュールが存在するか:
// - design-tokens.ts のデータを CSS custom properties（:root の --ajr-*）へ落とし込む。
//   この出力をビルド時に public/styles.css へ書き出し、リポジトリへコミットして実行時依存をなくす。
// - 変換は純関数・決定的（同一入力→同一出力）。ユニットテストで担保する（§8）。
// - ベース要素スタイルはトークン変数のみを参照し、生の値を直書きしない（トークンが単一の真実）。

import { TOKEN_PREFIX, type TokenGroup } from "./design-tokens";

// CSS 変数宣言名（`--ajr-<name>`）を組み立てる。宣言側と参照側で接頭辞規則を一元化する。
function varName(name: string): string {
	return `--${TOKEN_PREFIX}-${name}`;
}

// トークン名 → CSS 変数参照。UI コードはこれを介してトークンを参照する。
export function tokenVar(name: string): string {
	return `var(${varName(name)})`;
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
	// トークン参照を短く綴るためのローカル別名（dense な宣言群の可読性のため）。
	const ref = tokenVar;
	return [
		"*, *::before, *::after {",
		"\tbox-sizing: border-box;",
		"}",
		"",
		"body {",
		"\tmargin: 0;",
		`\tfont-family: ${ref("font-sans")};`,
		`\tfont-size: ${ref("font-size-base")};`,
		`\tline-height: ${ref("line-height-base")};`,
		`\tcolor: ${ref("color-text")};`,
		`\tbackground: ${ref("color-bg")};`,
		"}",
		"",
		"main {",
		`\tmax-width: ${ref("layout-max-width")};`,
		`\tmargin: 0 auto;`,
		`\tpadding: ${ref("space-8")} ${ref("space-4")};`,
		"}",
		"",
		"h1 {",
		`\tfont-size: ${ref("font-size-xl")};`,
		`\tline-height: ${ref("line-height-tight")};`,
		`\tfont-weight: ${ref("font-weight-bold")};`,
		`\tmargin: 0 0 ${ref("space-6")};`,
		"}",
		"",
		"p {",
		`\tmargin: 0 0 ${ref("space-4")};`,
		"}",
		"",
		"a {",
		`\tcolor: ${ref("color-primary")};`,
		"}",
		"",
		"strong {",
		`\tfont-weight: ${ref("font-weight-bold")};`,
		"}",
		"",
		"label {",
		"\tdisplay: block;",
		`\tmargin-bottom: ${ref("space-1")};`,
		`\tcolor: ${ref("color-text-muted")};`,
		`\tfont-size: ${ref("font-size-sm")};`,
		"}",
		"",
		"input, textarea, select, button {",
		"\tfont: inherit;",
		`\tcolor: ${ref("color-text")};`,
		"}",
		"",
		"input, textarea, select {",
		`\tpadding: ${ref("space-2")} ${ref("space-3")};`,
		`\tborder: ${ref("border-width")} solid ${ref("color-border")};`,
		`\tborder-radius: ${ref("radius-sm")};`,
		`\tbackground: ${ref("color-bg")};`,
		"\tmax-width: 100%;",
		"}",
		"",
		"textarea {",
		"\twidth: 100%;",
		`\tfont-family: ${ref("font-mono")};`,
		"}",
		"",
		"button {",
		`\tpadding: ${ref("space-2")} ${ref("space-6")};`,
		`\tborder: ${ref("border-width")} solid transparent;`,
		`\tborder-radius: ${ref("radius-sm")};`,
		`\tbackground: ${ref("color-primary")};`,
		`\tcolor: ${ref("color-primary-text")};`,
		`\tfont-weight: ${ref("font-weight-bold")};`,
		"\tcursor: pointer;",
		"}",
		"",
		":focus-visible {",
		`\toutline: 2px solid ${ref("color-focus-ring")};`,
		"\toutline-offset: 2px;",
		"}",
		"",
		"form {",
		`\tmargin: 0 0 ${ref("space-4")};`,
		"\tdisplay: flex;",
		`\tgap: ${ref("space-3")};`,
		"\tflex-wrap: wrap;",
		"\talign-items: flex-start;",
		"}",
		"",
		"table {",
		"\twidth: 100%;",
		"\tborder-collapse: collapse;",
		`\tmargin: 0 0 ${ref("space-6")};`,
		`\tfont-size: ${ref("font-size-sm")};`,
		"}",
		"",
		"th, td {",
		`\tpadding: ${ref("space-2")} ${ref("space-3")};`,
		`\tborder-bottom: ${ref("border-width")} solid ${ref("color-border")};`,
		"\ttext-align: left;",
		"}",
		"",
		"th {",
		`\tbackground: ${ref("color-surface")};`,
		`\tcolor: ${ref("color-text-muted")};`,
		`\tfont-weight: ${ref("font-weight-bold")};`,
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
