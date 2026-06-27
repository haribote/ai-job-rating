# デザインシステム（#27 / #97）

要件 §11 の方針に基づくデザイントークン管理。`src/shared/design-tokens.ts` を**単一の真実**とし、
そこから Tailwind theme と shadcn/ui の :root CSS 変数を決定的に導出する（#97 で `public/styles.css` 直生成から移行）。
Claude Design は管理・可視化に用いるが**実行時依存にはしない**。

## ファイル配置

| 役割 | パス |
|---|---|
| トークン定義（単一の真実） | `src/shared/design-tokens.ts` |
| トークン → Tailwind theme / CSS 変数の変換（決定的・テスト済み） | `src/shared/design-tokens.ts`（`toTailwindTheme` / `toRootCssVars` 等） |
| 変換のユニットテスト（単一ソース性） | `src/shared/design-tokens.test.ts` |
| Tailwind 設定（トークンを theme/:root へ供給する薄いラッパ） | `tailwind.config.ts` |
| PostCSS 設定（Tailwind / autoprefixer） | `postcss.config.js` |
| スタイルエントリ（Tailwind ディレクティブ＋ shadcn base） | `src/client/styles/globals.css` |
| shadcn 設定 | `components.json` |
| shadcn UI プリミティブ | `src/client/components/ui/*` |

スタイルは `src/client/main.tsx` が `globals.css` を import し、Vite が PostCSS/Tailwind 経由でバンドルして
`public/assets/` へ出力する（Worker の `assets` バインディングで配信）。生成物は `.gitignore` 済みで、
トークンを変えたら `design-tokens.ts` のみ修正すれば theme・CSS 変数・全 UI に波及する（再生成スクリプトは不要）。

## UI からの参照方法

### 1. Tailwind ユーティリティ（推奨）

shadcn 意味カラーは Tailwind ユーティリティとして使う。値は `design-tokens.ts` 由来の CSS 変数を
`rgb(var(--name) / <alpha-value>)` で参照するため、opacity modifier（例: `bg-primary/90`）も機能する。

```tsx
<div className="bg-card text-card-foreground border-border rounded-lg p-4">
  <span className="text-primary">…</span>
</div>
```

主な色名: `background` / `foreground` / `card` / `popover` / `primary` / `secondary` / `muted` /
`accent` / `destructive` / `border` / `input` / `ring`（各 `*-foreground` あり）。
チャート色は `chart-1`..`chart-5`（`fill-chart-1` 等）。

### 2. shadcn コンポーネント

`@/components/ui/*`（`@` = `src/client`）から import する。クラス結合は `@/lib/utils` の `cn()`。
導入済み: `button` / `card` / `sheet` / `dialog` / `badge` / `skeleton` / `table` / `chart`（Recharts）。
アイコンは `lucide-react`。

## トークン定義

`design-tokens.ts` の `colorTokens` / `typographyTokens` / `spacingTokens` / `surfaceTokens` /
`layoutTokens` が値を持ち、以下の純粋関数が Tailwind / shadcn へ供給する:

- `hexToRgbChannels(hex)` — hex → `"R G B"`（`<alpha-value>` 合成用）
- `shadcnColorMap` / `chartColorMap` — 意味カラー名・チャート色名 → トークンキーの対応
- `toRootCssVars()` — `:root` に注入する CSS 変数（`--primary` 等＋`--radius`）。`tailwind.config.ts` の base プラグインが注入
- `toThemeColors()` / `toTailwindTheme()` — Tailwind の `theme.extend`（colors / fontFamily / fontSize / spacing / borderRadius 等）

## Claude Design 連携（要手動検証）

Claude Design 上でのデザインシステム管理・可視化（live 同期）は外部サービス連携のため、本リポジトリの
ビルド／デプロイの前提にはしない。トークンの整合は `src/shared/design-tokens.ts` を真実とし、Claude Design
側はその反映先として人間が手動で同期・確認する。
