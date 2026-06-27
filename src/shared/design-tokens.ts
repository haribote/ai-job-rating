// デザインシステムの単一の真実 (single source of truth)。
//
// なぜこのモジュールが存在するか:
// - 要件 §11: デザイン値（カラー・タイポグラフィ・間隔等）を管理し、Tailwind theme と
//   shadcn の :root CSS 変数の両方をここから決定的に導出する（#97）。Claude Design は管理・可視化に
//   用いるが実行時依存にはしない。Claude Design 無しでもビルド・デプロイできる状態を保つ。
// - トークンはプレーンな TypeScript データとして持ち、変換は純粋関数（本ファイル下部）に閉じて
//   ユニットテスト（design-tokens.test.ts）で単一ソース性を担保する。値の二重定義を作らない。
// - フォーク容易性: アカウント固有値・秘匿情報を含めない。汎用のデザイン値のみを定義する。
// - UI（Wave 3 #108–#114）は Tailwind ユーティリティ（bg-primary 等）と shadcn コンポーネント経由で参照する。

// トークン名（フラットキー）→ デザイン値。下部の変換関数が Tailwind theme / CSS 変数へ供給する。
export type TokenMap = Record<string, string>;

// カラートークン。意味的な役割名で持ち、生の HEX は値側に閉じる（UI は役割名のみ参照する）。
export const colorTokens: TokenMap = {
	"color-bg": "#ffffff",
	"color-surface": "#f7f8fa",
	"color-border": "#d7dbe0",
	"color-text": "#1a1d21",
	"color-text-muted": "#5b6470",
	"color-primary": "#2557d6",
	"color-primary-text": "#ffffff",
	"color-accent": "#0a7d54",
	"color-danger": "#c0362c",
	"color-focus-ring": "#2557d6",
};

// タイポグラフィトークン。フォントは OS のシステムフォントに委ね、追加ロード（実行時依存）を避ける。
export const typographyTokens: TokenMap = {
	"font-sans":
		'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif',
	"font-mono":
		'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
	"font-size-sm": "0.875rem",
	"font-size-base": "1rem",
	"font-size-lg": "1.25rem",
	"font-size-xl": "1.75rem",
	"line-height-tight": "1.25",
	"line-height-base": "1.6",
	"font-weight-normal": "400",
	"font-weight-bold": "700",
};

// 間隔トークン。4px グリッドに沿った段階的スケール（rem 基準）。
export const spacingTokens: TokenMap = {
	"space-0": "0",
	"space-1": "0.25rem",
	"space-2": "0.5rem",
	"space-3": "0.75rem",
	"space-4": "1rem",
	"space-6": "1.5rem",
	"space-8": "2rem",
};

// 角丸・境界・影など、その他の視覚トークン。
export const surfaceTokens: TokenMap = {
	"radius-sm": "4px",
	"radius-md": "8px",
	"border-width": "1px",
	"shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.06)",
};

// レイアウトトークン。本文の最大幅など。
export const layoutTokens: TokenMap = {
	"layout-max-width": "72rem",
};

// ───────────────────────────────────────────────────────────────────────────
// Tailwind / shadcn への供給（#97）
//
// なぜここに置くか:
// - design-tokens.ts を唯一の真実とし、Tailwind theme と shadcn の CSS 変数の両方を
//   ここから決定的に導出する（値の二重定義を作らない）。tailwind.config.ts は本モジュールの
//   出力を読むだけの薄いラッパに留め、単一ソース性をユニットテストで担保する（§8）。
// - 色は RGB チャンネル文字列（"R G B"）で CSS 変数化し、Tailwind 側は
//   `rgb(var(--name) / <alpha-value>)` として参照する。これにより shadcn 既定の
//   opacity modifier（例: bg-primary/90）が機能し、将来のダークモード差し替え点も CSS 変数に閉じる。
// ───────────────────────────────────────────────────────────────────────────

// `#rrggbb` / `#rgb` を 10進 RGB チャンネル文字列（"R G B"）へ変換する。
// Tailwind の `<alpha-value>` 合成に使う決定的な純粋関数（§8）。
export function hexToRgbChannels(hex: string): string {
	const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) {
		throw new Error(`不正な hex カラー: ${hex}`);
	}
	let body = m[1];
	if (body.length === 3) {
		// 省略形 #rgb は各桁を 2 倍に展開する
		body = body
			.split("")
			.map((c) => c + c)
			.join("");
	}
	const r = Number.parseInt(body.slice(0, 2), 16);
	const g = Number.parseInt(body.slice(2, 4), 16);
	const b = Number.parseInt(body.slice(4, 6), 16);
	return `${r} ${g} ${b}`;
}

// shadcn の意味カラー名 → 由来する color トークンのキー。
// CSS 変数名と Tailwind theme の色名の対応を 1 箇所に集約し、両者の単一ソース性を保つ。
export const shadcnColorMap: Record<string, string> = {
	background: "color-bg",
	foreground: "color-text",
	card: "color-bg",
	"card-foreground": "color-text",
	popover: "color-bg",
	"popover-foreground": "color-text",
	primary: "color-primary",
	"primary-foreground": "color-primary-text",
	secondary: "color-surface",
	"secondary-foreground": "color-text",
	muted: "color-surface",
	"muted-foreground": "color-text-muted",
	accent: "color-surface",
	"accent-foreground": "color-text",
	destructive: "color-danger",
	"destructive-foreground": "color-primary-text",
	border: "color-border",
	input: "color-border",
	ring: "color-focus-ring",
};

// チャート系列色（Recharts / shadcn Chart, Wave 3 #110）。意味カラーとは別系統の単一アクセント群。
export const chartColorMap: Record<string, string> = {
	"chart-1": "color-primary",
	"chart-2": "color-accent",
	"chart-3": "color-danger",
	"chart-4": "color-text-muted",
	"chart-5": "color-border",
};

// 角丸の基準値（shadcn の --radius 規約）。md を基準に sm/lg を計算で導く。
const RADIUS_BASE_TOKEN = "radius-md";

// shadcn 名 → トークンキーの対応から RGB チャンネルを引く（未宣言キーは即エラーにしてタイポを検出）。
function channelsFor(colorMap: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, tokenKey] of Object.entries(colorMap)) {
		const value = colorTokens[tokenKey];
		if (value === undefined) {
			throw new Error(`未宣言の color トークン: ${tokenKey}（${name} が参照）`);
		}
		out[name] = hexToRgbChannels(value);
	}
	return out;
}

// :root に注入する CSS 変数（shadcn 意味カラー + チャート色 + --radius）。
// 値はすべてトークン由来。tailwind.config.ts の base プラグインから注入する。
export function toRootCssVars(): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const [name, channels] of Object.entries(channelsFor(shadcnColorMap))) {
		vars[`--${name}`] = channels;
	}
	for (const [name, channels] of Object.entries(channelsFor(chartColorMap))) {
		vars[`--${name}`] = channels;
	}
	vars["--radius"] = surfaceTokens[RADIUS_BASE_TOKEN];
	return vars;
}

// Tailwind theme の colors。各色は対応する CSS 変数を `<alpha-value>` 付きで参照する。
export function toThemeColors(): Record<string, string> {
	const colors: Record<string, string> = {};
	for (const name of Object.keys(shadcnColorMap)) {
		colors[name] = `rgb(var(--${name}) / <alpha-value>)`;
	}
	for (const name of Object.keys(chartColorMap)) {
		colors[name] = `rgb(var(--${name}) / <alpha-value>)`;
	}
	return colors;
}

// Tailwind の spacing キーはプレフィックス無し（p-4 等）。`space-4` → `4` に正規化する。
function toSpacingScale(): Record<string, string> {
	const scale: Record<string, string> = {};
	for (const [key, value] of Object.entries(spacingTokens)) {
		scale[key.replace(/^space-/, "")] = value;
	}
	return scale;
}

// tailwind.config.ts の `theme.extend` にそのまま渡せる形へトークンを供給する（単一ソース）。
export function toTailwindTheme() {
	return {
		colors: toThemeColors(),
		fontFamily: {
			sans: typographyTokens["font-sans"],
			mono: typographyTokens["font-mono"],
		},
		fontSize: {
			sm: typographyTokens["font-size-sm"],
			base: typographyTokens["font-size-base"],
			lg: typographyTokens["font-size-lg"],
			xl: typographyTokens["font-size-xl"],
		},
		fontWeight: {
			normal: typographyTokens["font-weight-normal"],
			bold: typographyTokens["font-weight-bold"],
		},
		lineHeight: {
			tight: typographyTokens["line-height-tight"],
			base: typographyTokens["line-height-base"],
		},
		spacing: toSpacingScale(),
		borderRadius: {
			sm: "calc(var(--radius) - 4px)",
			md: "calc(var(--radius) - 2px)",
			lg: "var(--radius)",
		},
		boxShadow: {
			sm: surfaceTokens["shadow-sm"],
		},
		borderWidth: {
			DEFAULT: surfaceTokens["border-width"],
		},
		maxWidth: {
			layout: layoutTokens["layout-max-width"],
		},
	};
}
