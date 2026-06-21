# スパイク: 日本語求人抽出のデフォルトモデル選定（#15）

親 Issue: #44（Phase 0 トラッキング）。
目的: `@cf/openai/gpt-oss-120b` と `@cf/meta/llama-4-scout-17b-16e-instruct` の日本語求人抽出精度を複数求人で比較・記録し、デフォルト抽出モデル（`EXTRACTION_MODEL`）を確定する。

> **状態: 準備完了・live 比較は要手動検証。** 実 Workers AI 推論は Cloudflare アカウント認証/binding が要りオフライン不可。本ドキュメントは比較ハーネス・ルーブリック・記録欄・実行手順を提供する。実機比較とデフォルト決定は人間が行う。

---

## 1. 候補モデルと JSON Mode 対応状況（一次ソース確認: 2026-06-21）

`src/extract.ts` の `extractJob` は現状 OpenAI 互換の `response_format: { type: "json_schema", json_schema }` 経路で JSON Mode を使う。各候補がこの経路で使えるかを一次ソースで確認した。

| モデル ID | 役割 | JSON Mode 機能ページの対応一覧 | `response_format`（入力スキーマ） | 備考 |
| --- | --- | --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | baseline（現行デフォルト） | **掲載あり** | 受理 | 比較の基準。context window 24,000 tokens / $0.29 in・$2.25 out（per M tokens） |
| `@cf/openai/gpt-oss-120b` | candidate | **未掲載** | 受理（json_object / json_schema） | OpenAI 互換 Responses API 系。context 128,000 / $0.35 in・$0.75 out。**要手動検証** |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | candidate | **未掲載** | 受理（+ `guided_json`） | context 131,000 / $0.27 in・$0.85 out。**要手動検証** |

### 一次ソース

- JSON Mode 機能ページ（"This is the list of models that now support JSON Mode" の一覧）:
  https://developers.cloudflare.com/workers-ai/features/json-mode/
  - 掲載 7 モデル: `@cf/meta/llama-3.1-8b-instruct-fast` / `@cf/meta/llama-3.1-70b-instruct` / `@cf/meta/llama-3.3-70b-instruct-fp8-fast` / `@cf/meta/llama-3-8b-instruct` / `@cf/meta/llama-3.1-8b-instruct` / `@cf/meta/llama-3.2-11b-vision-instruct` / `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`。
  - **両候補（gpt-oss-120b / llama-4-scout）は不在。**
- 各モデルの入力スキーマ（API 一次ソース、`sync-input.json`）:
  - gpt-oss-120b: https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/ — top-level に `response_format`（json_object / json_schema）あり、`guided_json` なし。
  - llama-4-scout: https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/ — top-level に `response_format` と `guided_json` の両方あり。
  - llama-3.3-70b-fp8-fast: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/ — `response_format` あり。

### この食い違いの含意（重要）

機能ページの「対応一覧」と各モデルの入力スキーマに食い違いがある。入力スキーマ上は両候補とも `response_format` を受理するが、**JSON Mode（妥当な JSON を保証する機能）の正式サポート対象として明記されているのは baseline の llama-3.3 のみ**。したがって:

1. live 比較では、各候補が `response_format=json_schema` で**実際に妥当な JSON を返すか**を最優先で確認する（スキーマ受理 ≠ 出力保証）。
2. もし候補が JSON Mode を満たさない（`extractJob` が全 unknown に畳む）場合、その事実を記録し、**JSON Mode 対応一覧掲載モデル**（例: llama-3.3-70b 系）の中から日本語精度で選ぶ方針に切り替える。`src/ai.ts` のコメント「gpt-oss-120b は JSON Mode 非対応」は、機能ページ一覧に照らすと**整合的**（一覧未掲載）。

> モデル ID・価格・context は上記一次ソースの 2026-06-21 時点の値。live 実行時に再確認すること。

---

## 2. 比較ハーネス（`src/model-comparison.ts`）

実 AI 呼び出しは `AiRunner` として注入する。決定的な整形・集計はユニットテスト済み（`src/model-comparison.test.ts`）。

- `CANDIDATE_MODELS`: 上表のモデル ID と JSON Mode 対応メタ（一次ソース確認結果）。
- `summarizeExtraction(job)`: present（値あり）/ unknown（中立）数を数える。**抽出率**の一次指標。
- `diffJobs(a, b)`: 2 モデルの結果をキー単位で `agree` / `disagree` / `onlyA` / `onlyB` / `bothUnknown` に分類（網羅・排他）。**モデル間の食い違い**を機械的に可視化。
- `compareModels(ai, fixtures, models)`: モデル × fixture で `extractJob` を回し横並びレポートを返す薄いオーケストレータ。

`extractJob(ai, body, model?)` に後方互換で `model` 引数を追加済み（省略時は `EXTRACTION_MODEL`）。結果の `model` は実際に使ったモデルを指す。

---

## 3. 精度評価ルーブリック（日本語求人抽出）

決定的に測れる指標（ハーネスが自動算出）と、人間が原文照合で判定する観点を分ける。

### 3.1 自動算出（決定的・ハーネス出力）

| 指標 | 定義 | 出所 |
| --- | --- | --- |
| 抽出率（valueCount） | present キー数 / 全正規キー数（21） | `summarizeExtraction` |
| baseline との一致 | baseline と `agree` のキー数 | `diffJobs(baseline, candidate)` |
| baseline との相違 | `disagree` キー数（両者 present だが raw 不一致） | 同上 |
| 候補のみ拾い | `onlyB`（candidate だけ present） | 同上 |
| 候補の取りこぼし | `onlyA`（baseline だけ present） | 同上 |

### 3.2 人間判定（原文照合・rubric）

各 fixture の原文（`docs/spikes/fixtures/job-fixtures.json`）と抽出結果を突き合わせ、キー単位で 3 値判定する。

| 判定 | 意味 |
| --- | --- |
| ✅ 正 | 原文に記載があり、正規キーへ正しく・原文表記で拾えている |
| ❌ 誤/創作 | 原文に**ない**情報を出した（hallucination）、または別キーへ誤って割当 |
| ⬜ 取りこぼし | 原文に記載があるのに unknown にした |

判定の優先度（高い順）:

1. **誤抽出・創作がない**（❌ ゼロが最優先。求人スコアリングは事実に依存するため、創作は抽出率より致命的）。
2. **JSON Mode が安定して満たされる**（全 fixture で妥当 JSON。畳み込み全 unknown が頻発しないこと）。
3. **取りこぼしが少ない**（⬜ が少ない＝抽出率が高い）。
4. **baseline と同等以上**（baseline で拾えるものを落とさない）。
5. コスト・レイテンシ（同等精度なら安い/速い方）。

> スコア化の例: fixture ごとに `正の数 − 誤の数×2`（創作にペナルティ2倍）。全 fixture 合計で順位付け。最終判断は上記優先度を人間が総合する。

---

## 4. live 比較の実行手順（人間が回す）

### 4.1 前提

- Cloudflare アカウントにログイン済み（`wrangler login`）。Workers AI 課金が発生しうる。
- `.dev.vars` 等の秘匿配置はこの比較には不要（AI binding のみ使用）。worktree で動かす場合は `wrangler.jsonc` の `ai` binding が有効なこと。

### 4.2 比較ルートを一時的に配線

`src/model-comparison-route.ts` の `modelComparison` を `src/app.ts` へ一時 route する（**比較が終わったら戻す**。スパイク用途のため本番配線しない）:

```ts
// src/app.ts に一時追加
import { modelComparison } from "./model-comparison-route";
app.route("/", modelComparison); // 静的フォールスルー app.get("*") より前
```

### 4.3 dev 起動と curl

```sh
npm run dev   # wrangler dev。AI binding は remote リソースに到達（課金注意）

# fixtures をそのまま投げる（全候補モデルで横並び抽出）
curl -sS http://localhost:8787/compare \
  -H 'content-type: application/json' \
  --data-binary @docs/spikes/fixtures/job-fixtures.json \
  | jq .
```

- `models` を指定しなければ `CANDIDATE_MODELS` 全件を回す。特定モデルだけ見たい場合は body に `"models": ["@cf/meta/llama-4-scout-17b-16e-instruct"]` を足す。
- レスポンスは `{ models, report: [{ fixture, results: [{ model, job, summary }] }] }`。`summary.valueCount` が抽出率、`job` が正規スキーマ抽出結果。

### 4.4 手元の実ページで比較する場合

実求人ページの HTML は直コミットしない（#9 方針）。手元で HTML を `trimHtml`（`src/trim-html.ts`）相当に通したプレーンテキストを `body` にして `fixtures` 配列へ足す。最小には、ブラウザで保存した HTML を `node` 等で `trimHtml` に通して本文化し、その文字列を JSON の `body` に入れる。

### 4.5 記録

各候補について 3.1 の自動指標を控え、3.2 の原文照合判定を §5 の表に記入する。

---

## 5. 結果記入表（live 実行で埋める）

> 以下は **未記入のテンプレ**。実機比較後に値を入れる。

### 5.1 JSON Mode 充足チェック（最優先）

| モデル | fixture 全件で妥当 JSON を返したか | 全 unknown 畳み込みの発生 | 所見 |
| --- | --- | --- | --- |
| `@cf/openai/gpt-oss-120b` | （要記入） | （要記入） | |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | （要記入） | （要記入） | |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（baseline） | （要記入） | （要記入） | |

### 5.2 自動指標（fixture ごと・全候補）

| fixture | モデル | valueCount / 21 | baseline と agree | disagree | onlyA(baseline) | onlyB(候補) |
| --- | --- | --- | --- | --- | --- | --- |
| fullstack-startup | gpt-oss-120b | | | | | |
| fullstack-startup | llama-4-scout | | | | | |
| sre-megacorp | gpt-oss-120b | | | | | |
| sre-megacorp | llama-4-scout | | | | | |
| sparse-listing | gpt-oss-120b | | | | | |
| sparse-listing | llama-4-scout | | | | | |

### 5.3 原文照合判定（人間・3.2 ルーブリック）

| fixture | モデル | 正 ✅ | 誤/創作 ❌ | 取りこぼし ⬜ | スコア(正−誤×2) | メモ |
| --- | --- | --- | --- | --- | --- | --- |
| fullstack-startup | gpt-oss-120b | | | | | |
| fullstack-startup | llama-4-scout | | | | | |
| sre-megacorp | gpt-oss-120b | | | | | |
| sre-megacorp | llama-4-scout | | | | | |
| sparse-listing | gpt-oss-120b | | | | | |
| sparse-listing | llama-4-scout | | | | | |

---

## 6. デフォルト決定（結論欄・live 後に記入）

- **選定モデル**: （要記入）
- **根拠**: （§3 優先度に沿って。誤抽出有無 → JSON Mode 安定性 → 取りこぼし → コストの順で）
- **JSON Mode の前提**: 選定モデルが JSON Mode 機能ページ未掲載の場合、`response_format` での妥当 JSON が安定する根拠（live 実測）を明記。安定しない場合は掲載モデル（llama-3.3 系等）から選ぶ。

### 反映手順（決定後）

1. `src/extract.ts` の `EXTRACTION_MODEL` を選定モデル ID に更新（一次ソース掲載の表記をそのまま）。
2. 選定モデルが JSON Mode 機能ページ未掲載なら、`extractJob` の JSON Mode 前提に関するコメント（§7.1 参照箇所）に live 実測の根拠と日付を残す。
3. `src/ai.ts` の health 用モデルは抽出デフォルトと独立（変更不要）。コメントの JSON Mode 記述は本スパイクの一次ソース確認結果に整合させる。
4. `src/app.ts` へ一時配線した `modelComparison` ルートを**外す**。
5. `EXTRACTION_MODEL` 変更後、`npm run test` / `npm run typecheck` / `npm run lint` を green に保つ。
