# 1位カードのカテゴリ別スコアテーブル（#203 方針転換）

## 背景

#203（PR #214）で採用したダッシュボード単位の独立凡例（`RadarAxisLegend` を `Dashboard.tsx` に1箇所だけ表示）を見送り、別案を採用する。

ブレインストーミングの結果、以下に決定した:

- 独立した凡例欄は設けない。`Dashboard.tsx` から `RadarAxisLegend` の描画を削除する。
- 1位カード（`RankingCard` の `size==="hero"`）にだけ、総合スコアの下に「番号・カテゴリ名・スコア」のミニマルなテーブルを表示する。番号列を残すことで、2位以下のカードが引き続き番号（1〜5）のみの軸ラベルを使っていても、1位カードのテーブルが番号→カテゴリ名の対応表を兼ねる。
- スコアは `categoryScores`（0〜1）を ×100 し、既存の `formatScore`（`RankingCard.tsx`、null→「—」・`toFixed(2)`）で表示する。総合スコアとスケール・精度を統一するため。
- `JobDetailSheet.tsx`（詳細ドロワー）は対象外。単一求人を見る画面で「1位カード」という概念が存在せず、既に `RadarAxisLegend` を表示済みのため現状維持。

`RadarAxisLegend` コンポーネント自体は削除しない（`JobDetailSheet.tsx` が使い続けるため）。前タスクで追加した番号バッジ化（`docs/superpowers/specs/2026-07-04-radar-axis-legend-badge-design.md`）もそちらで有効なまま残る。

## スコープ

### 新規: `src/client/components/CategoryScoreTable.tsx`

- Props: `{ scores: Record<CategoryKey, number | null>; className?: string }`。
- `CATEGORY_KEYS` 順に5行、列は「番号（`CATEGORY_AXIS_NUMBERS`）・カテゴリ名（`CATEGORY_LABELS`）・スコア」。
- shadcn `Table`/`TableBody`/`TableRow`/`TableCell`（`@/components/ui/table`、`BreakdownTable.tsx` と同じプリミティブ）を使う。ヘッダ行は「ミニマル」の方針に沿い省略可（実装時に見た目を見て判断してよい）。
- スコア表示は `RankingCard.tsx` の `formatScore`（export 済み）を再利用: `formatScore(score === null ? null : score * 100)`。null は「—」（既存の中立表示規約を踏襲、行自体は消さない）。

### 変更: `src/client/components/RankingCard.tsx`

- `size === "hero"` のときだけ、スコアラッパー内（`score-unavailable-note` の下）に `<CategoryScoreTable scores={item.categoryScores} />` を追加する。
- `podium`/`default` サイズには表示しない。

### 変更: `src/client/routes/Dashboard.tsx`

- `RadarAxisLegend` の import、`hasAnyRadarCard` 判定とそのコメント（136-139行目）、`{hasAnyRadarCard && <RadarAxisLegend className="mb-3" />}`（144行目）を削除する。
- `rankedCount`（135行目）は投入中カードの順位計算（220行目 `rank={rankedCount + index + 1}`）で使い続けるため残す。

### 変更なし

- `JobDetailSheet.tsx`（`RadarAxisLegend` を継続使用）。
- `RadarAxisLegend.tsx` 本体（番号バッジ化を含め、コンポーネントは変更しない）。
- `ScoreRadar.tsx`（SVG 軸ラベルの番号表示は変更しない）。
- `e2e/fixtures/mockRanking.ts`（hero/podium/default に `categoryScores` が既に付与済みのため変更不要）。

## テスト方針

- 新規 `src/client/components/CategoryScoreTable.test.tsx`: `CATEGORY_KEYS` 順で5行・番号/カテゴリ名/スコアの対応を検証（ハードコードしない）。unknown（null）行が「—」で表示され、行自体は省略されないことを検証。
- `src/client/components/RankingCard.test.tsx`: `size==="hero"` のときのみ `CategoryScoreTable` が出現し、`podium`/`default` では出現しないことを検証。
- `src/client/routes/Dashboard.test.tsx`: 296〜349行目の「軸凡例（RadarAxisLegend）の表示条件（#203）」`describe` ブロックを削除し、代わりに「Dashboard はどの状態（ローディング／エラー／0件／投入中含む）でも `radar-axis-legend` を描画しない」というシンプルな回帰テストを1つ追加する。
- e2e: 既存 `@screenshot`（fixture 変更不要）を再実行し、1位カードのテーブル表示・2位以下カードの番号のみ軸ラベルを目視確認する。

## 受け入れ条件

- ダッシュボードに独立した凡例欄が表示されない（`Dashboard.tsx` はどの状態でも `radar-axis-legend` を描画しない）。
- 1位カードにのみ、総合スコア直下に番号・カテゴリ名・スコアの3列テーブルが表示される。
- 2/3位・4位以下のカードにはテーブルが表示されない。
- テーブルのスコアは総合スコアと同じ 0〜100 スケール・`toFixed(2)` 精度で表示される。unknown は「—」。
- `JobDetailSheet.tsx` の表示（`RadarAxisLegend` 継続使用）に変更がない。
- 既存の単体テストで新規・変更点を過不足なくカバーし、`@screenshot` で目視確認する。
