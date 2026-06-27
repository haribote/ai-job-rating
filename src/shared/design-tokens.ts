// デザインシステムの単一の真実 (single source of truth)。
//
// なぜこのモジュールが存在するか:
// - 要件 §11: デザインシステム（カラー・タイポグラフィ・間隔等）を管理し、確定したトークンを
//   リポジトリ側（CSS）へ反映する。Claude Design は管理・可視化に用いるが実行時依存にはしない。
// - トークンはプレーンな TypeScript データとして持ち、ビルド時に CSS custom properties へ変換する
//   （design-tokens-css.ts）。これにより Claude Design 無しでもビルド・デプロイできる状態を保つ。
// - フォーク容易性: アカウント固有値・秘匿情報を含めない。汎用のデザイン値のみを定義する。
// - 後続 UI（#18 ランキング一覧 / #19 設定UI）はここで確定した CSS 変数名（--ajr-*）を参照する。

// トークン名（フラットキー）→ CSS 値。CSS では `--ajr-<キー>` の custom property になる。
export type TokenMap = Record<string, string>;

// 一貫した接頭辞。フォーク先での衝突を避け、由来を明示する（ai-job-rating）。
export const TOKEN_PREFIX = "ajr";

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

// 全トークンを 1 つの順序付きグループ配列に集約する。
// グループ順・グループ内のキー順を固定し、CSS 生成を決定的にする（同一入力→同一出力, §8）。
export interface TokenGroup {
	name: string;
	tokens: TokenMap;
}

export const tokenGroups: TokenGroup[] = [
	{ name: "color", tokens: colorTokens },
	{ name: "typography", tokens: typographyTokens },
	{ name: "spacing", tokens: spacingTokens },
	{ name: "surface", tokens: surfaceTokens },
	{ name: "layout", tokens: layoutTokens },
];
