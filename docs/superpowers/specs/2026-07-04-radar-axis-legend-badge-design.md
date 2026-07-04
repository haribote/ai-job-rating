# レーダー軸凡例の番号バッジ化（#203 追補）

## 背景

#203（PR #214）で `RadarAxisLegend`（番号→カテゴリ名の凡例、ダッシュボード単位で1箇所のみ表示）を新規追加した。実機スクショ確認後、凡例欄の見た目にもう少しあしらいが欲しいという要望があり、GitHub の Issue/PR ラベルのような表現を検討した。

ブレインストーミングの結果、以下に決定した:

- 色は既存の `--chart-1..5`（`design-tokens.ts` の `chartColorMap`）を流用しない。これらは `primary`/`accent`/`danger`/`text-muted`/`border` という意味カラーの転用であり、`chart-3`（danger=赤系）を任意のカテゴリに割り当てると警告色に見えてしまうため、5色のカテゴリ識別パレットとしては不適切。新規パレットの追加はスコープ過大と判断し見送る。
- 形状（丸い pill）のみを取り入れ、色は単一の muted トーンで揃える。
- 番号（`CATEGORY_AXIS_NUMBERS`）のみを小さな円形バッジにし、カテゴリ名（`CATEGORY_LABELS`）は装飾なしのプレーンテキストのままにする。
- レーダーチャート本体（`ScoreRadar.tsx`）の SVG 軸ラベル（1〜5 の tick）は対象外。凡例欄のみのスタイル変更。
- 現在未 merge の PR #214（#203）へ追加コミットする（新規ファイルのため差分が小さく、レビュー往復を増やさないため）。

## スコープ

`src/client/components/RadarAxisLegend.tsx` の `<dt>` 要素のスタイルのみを変更する。

- 変更前: `className="font-semibold tabular-nums"`
- 変更後: `inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-foreground` 相当（丸バッジ）
- `<dd>`（カテゴリ名）・`role="term"`/`role="definition"`・`data-testid="radar-axis-legend"`・コンポーネントの props/構造は変更しない。

## 非スコープ（明示的に対象外）

- 新規カラーパレットの追加（`design-tokens.ts` への categorical palette 追加はしない）。
- `ScoreRadar.tsx` の SVG 軸ラベル（チャート内の 1〜5 tick）の見た目変更。
- ライト/ダークテーマ用の追加トークン定義（`bg-muted`/`text-foreground` は既存の CSS 変数で両テーマ対応済みのため不要）。

## テスト方針

見た目のみの変更で `dt`/`dd` の DOM 構造・ロール・テキスト内容は変わらないため、既存の `RadarAxisLegend.test.tsx`（`data-testid` 存在確認・`CATEGORY_KEYS` 順の番号↔カテゴリ名対応）は無修正のまま green を維持する。新規ユニットテストは追加しない（#203 でも `CARD_SIZE_STYLES` 等の Tailwind クラス自体はユニットテスト対象にしていない既存プラクティスを踏襲）。

`e2e/screenshots.spec.ts` の既存 `@screenshot` を再実行し、生成 PNG で丸バッジの見た目を目視確認する。

## 受け入れ条件

- `RadarAxisLegend` の番号が丸バッジとして表示される（ライト/ダーク両テーマで視認できる）。
- カテゴリ名はプレーンテキストのまま。
- 既存の `RadarAxisLegend.test.tsx`／`Dashboard.test.tsx` が無修正で green。
- `@screenshot` の生成 PNG で見た目を目視確認する。
- PR #214 への追加コミットとして反映する。
