# デザインシステム（#27）

要件 §11 の方針に基づく、リポジトリにコミット済みのデザイントークン／CSS。
Claude Design は管理・可視化に用いるが**実行時依存にはしない**。後続 UI（#18 ランキング一覧 / #19 設定UI）はここで確定したトークンを参照する。

## ファイル配置

| 役割 | パス |
|---|---|
| トークン定義（単一の真実） | `src/design-tokens.ts` |
| トークン → CSS 変換（決定的・テスト済み） | `src/design-tokens-css.ts` |
| 変換のユニットテスト | `src/design-tokens-css.test.ts` |
| ビルドスクリプト（CSS 生成 / 同期検査） | `scripts/build-css.mjs` |
| **生成済み CSS（配信物・コミット対象）** | `public/styles.css` |

`public/styles.css` は `src/design-tokens.ts` から決定的に生成される自動生成ファイル。**直接編集しない**。
トークンを変えたら `npm run build:css` で再生成してコミットする。`npm run build:css:check` で同期を検査できる（CI 向け）。

## UI からの参照方法

### 1. CSS 変数（推奨・SSR / 静的どちらでも）

各ページの `<head>` で `<link rel="stylesheet" href="/styles.css" />` を読み込むと、ベース要素スタイル（`body` / `main` / `h1` / `p` / `a` / `form` / `input` / `textarea` / `button` / `table` / `th` / `td` / `:focus-visible`）が自動で適用される。追加スタイルではトークンを CSS 変数で参照する:

```css
.score-badge {
  color: var(--ajr-color-primary);
  padding: var(--ajr-space-2) var(--ajr-space-3);
  border-radius: var(--ajr-radius-sm);
}
```

`/styles.css` は Worker の静的資産（`wrangler.jsonc` の `assets` バインディング, `./public`）として配信される。既存 SSR ページ（`url-input.ts` / `paste-input.ts` / `result-display.ts`）と `public/index.html` は読み込み済み。

### 2. TypeScript からの変数参照ヘルパ

`design-tokens-css.ts` の `tokenVar("color-primary")` が `var(--ajr-color-primary)` を返す。インライン style を組む際に変数名のハードコードを避けられる。

## トークン名一覧（接頭辞 `--ajr-`）

CSS 変数名は `--ajr-<キー>`。グループ／キーは `src/design-tokens.ts` の挿入順で決定的に出力される。

- **color**: `color-bg` `color-surface` `color-border` `color-text` `color-text-muted` `color-primary` `color-primary-text` `color-accent` `color-danger` `color-focus-ring`
- **typography**: `font-sans` `font-mono` `font-size-sm` `font-size-base` `font-size-lg` `font-size-xl` `line-height-tight` `line-height-base` `font-weight-normal` `font-weight-bold`
- **spacing**: `space-0` `space-1` `space-2` `space-3` `space-4` `space-6` `space-8`（4px グリッド）
- **surface**: `radius-sm` `radius-md` `border-width` `shadow-sm`
- **layout**: `layout-max-width`

## Claude Design 連携（要手動検証）

Claude Design 上でのデザインシステム管理・可視化（live 同期）は外部サービス連携のため、本リポジトリのビルド／デプロイの前提にはしない。トークンの整合は `src/design-tokens.ts` を真実とし、Claude Design 側はその反映先として人間が手動で同期・確認する。
