# Issue #15 — 日本語求人抽出モデル比較（spike 決定記録）

> DoD（roadmap §Phase 0）: 両候補モデルの日本語抽出品質を複数求人で比較・記録し、デフォルトモデルを決定・記録する。
> 本ファイルが DoD 成果物。検証ハーネス（`src/spike-compare.ts` / `spike/` / tmux session `issue15`）は使い捨てで、記録後に撤収済み。
>
> **状態（2026-06-21）**: 手動検証は途中で中止。複数求人での精度裏取りは未完だが、候補モデルが本抽出設計に
> 不適合である**根本原因が判明**したため、その所見と今後の方針を記録する（下記「根本原因」「決定・今後の方針」）。

## 比較対象モデル

| ラベル | モデル ID | 位置づけ |
| --- | --- | --- |
| gpt-oss | `@cf/openai/gpt-oss-120b` | issue/roadmap 候補・reasoning |
| llama4-scout | `@cf/meta/llama-4-scout-17b-16e-instruct` | issue/roadmap 候補 |
| llama3.3 | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 現行 incumbent（`EXTRACTION_MODEL`） |

## 評価方法

- 同一前処理（`validatePastedHtml` → `trimHtml`）・同一プロンプト/JSON スキーマで 3 モデルを横並び抽出（`POST /spike/compare`）。
- 自動指標: JSON Mode 妥当性・スキーマ網羅（21 キー中の充足数）・latencyMs。
- 人手判定（KIMURA が原文を真値として）: フィールド単位 correct / wrong / hallucinated / missed。
  - correct=原文と一致 / wrong=記載はあるが誤抽出 / hallucinated=原文に無い値を捏造 / missed=原文にあるのに `-`。
- 集計: モデル別フィールド正答率 + latency（+ 既知のコスト傾向）→ デフォルト選定。

---

## Step 0: smoke test（モデル ID 生死確認）

`GET /spike/smoke` の結果。死んでいる ID（deprecated/renamed/権限不足）はここで除外を明記する。
現行コードが候補と別の llama3.3 を採用している理由の手掛かりもここに記録。

最小入力「テスト求人。年収700万円。フルリモート可。」での結果:

| モデル | ok | latencyMs | 充足キー | 備考 |
| --- | --- | --- | --- | --- |
| gpt-oss | true | 3847 | **0/21** | `response_format: json_schema` を無視。chat.completion 形式で `message.content=null`、実体は `reasoning_content` へ。**現行 JSON Mode 抽出パスでは使用不可**。 |
| llama4-scout | true | 1258 | 3/21 | 正しく `{response:{...}}` を返すが、見つけたキーのみ出力し未記載を `-` で埋めない（スキーマ網羅が弱い）。最速。 |
| llama3.3 | true | 6307 | **21/21** | 全キー網羅・未記載 `-` 埋めを遵守。最も忠実だが最も遅い。 |

**ドリフト理由（判明）**: roadmap/issue は gpt-oss / llama4-scout を候補に挙げたが、実装（#11）で JSON Mode（`response_format: json_schema`）を採用した結果、
- gpt-oss-120b は reasoning モデルで JSON Mode を遵守せず（content=null）抽出不能 → health ping 専用（`DEFAULT_AI_HEALTH_MODEL`）に留まった。
- llama4-scout はスキーマ網羅が弱い。
ため、JSON Mode を忠実に履行する llama3.3 が暫定 `EXTRACTION_MODEL` に採用された。本スパイクは実求人で精度を裏取りし最終確定する。

> 注: gpt-oss は本抽出パス（JSON Mode）では 0 充足のため、以降の実サンプル比較は実質 llama4-scout vs llama3.3 が主軸。gpt-oss は記録上 0/21 のまま据える（暗黙の打ち切りにしない）。

---

## 実サンプル所見（1 求人のみ・検証中止）

実求人 1 件（herp 掲載の SaaS 企業求人）を投入。`001.html` と `002.html` は**同一求人の別保存版**（完成度違い）で、
独立サンプルとしては実質 1 社。生抽出は PII（企業名・住所等）を含むため gitignored の `spike/` にのみ保存し、
本ファイルには PII を含まない自動指標のみ残す。

| サンプル | 入力(trim後) | gpt-oss | llama4-scout | llama3.3 |
| --- | --- | --- | --- | --- |
| 小（=002.html） | 1,900 chars | 0/21 | 3/21 | 21/21（13.9s, 全キー忠実） |
| 大（=001.html） | 2,822 chars | 0/21 | 2/21 | **504 Gateway Timeout（60s, 失敗）** |

- **llama3.3**: 小入力では全キー忠実だが、入力が増える（2,822 chars）と単発呼び出しで **504 タイムアウト**。
  本番 `extractJob` は 504 を最大 3 回リトライするが、レイテンシが高く 504 リスクは実在。context 上限 24,000 tokens も弱点。
- **llama4-scout**: `required` 未指定のため 2〜3 キーしか返さない（根本原因は下記）。常に高速（〜2s）。
- **gpt-oss**: 終始 0 充足（JSON Mode 非対応）。

---

## 根本原因（一次ソース: developers.cloudflare.com）

候補 2 モデルが期待を満たさないのは、**JSON Mode 抽出という設計に最初から不適合**だったため。
Workers AI の **JSON Mode 公式サポートモデル一覧**（<https://developers.cloudflare.com/workers-ai/features/json-mode/>）で全て説明がつく。

| モデル | JSON Mode 公式対応 | 実測との整合 |
| --- | --- | --- |
| llama-3.3-70b（現行） | **対応（一覧にあり）** | 全キー忠実 ← 正しく動く |
| llama-4-scout | **一覧になし**（`guided_json`/`response_format` パラメータは在るが保証外） | 取りこぼし多発 |
| gpt-oss-120b | **一覧になし**（reasoning モデル） | `content=null`/`reasoning_content` |

- **gpt-oss-120b**: reasoning モデルで正式には **Responses API（`input` / `/ai/v1/responses`）** で呼ぶ設計
  （<https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/>）。`response_format` + `messages` の JSON Mode は想定外の使い方で、
  `content=null`・推論が `reasoning_content` に出るのは仕様どおり。本用途に不向き。
- **llama-4-scout**: 取りこぼしの主因は **`required` 未指定**（公式サンプルは全フィールドを `required` に列挙）。ただし scout は
  JSON Mode 公式保証外のため、`required` を足しても充足は保証されず、出力スキーマ検証＋フォールバックが必須。131k context・安価・高速。
- **llama-3.3-70b** が忠実なのは公式 JSON Mode 対応モデルだから。→ **#11 実装時のドリフト（候補 → llama-3.3）は妥当な判断**だった。

---

## 決定・今後の方針

- **暫定デフォルト**: 現行の `@cf/meta/llama-3.3-70b-instruct-fp8-fast` を**継続**（唯一の公式 JSON Mode 対応・忠実）。
  ただし**複数求人での精度裏取りは未完**（検証中止）であり、本決定は暫定。弱点は遅さ・504・context 24k。
- **#15 の再定義**: 本 issue は「JSON Mode 前提で候補 2 モデルを比較」する形だったが、その候補自体が設計不適合と判明した。
  「JSON Mode 公式対応リスト内で選ぶ」問題に縮退するため、当初の比較としては**一旦保留／再定義**が妥当。

### 今後の検討事項（要 follow-up・別 issue 化推奨）

> **JSON Mode の仕様に拘らず、日本語で書かれた求人情報を「早く・安く」スクレイピング／構造化抽出できる手段を検討する。**

理由: JSON Mode（guided generation）に固定する限りモデルは公式対応リストに縛られ、速度・コスト・context・504 の制約を
受ける。requirements §8 リスク表も「JSON Mode **＋ スキーマ検証 ＋ フォールバック**」とセットで規定しており、JSON Mode 単体に
100% は委ねていない。構造化出力の機構を広げれば、より速く安いモデルが射程に入る。検討の方向性:

- **Function calling / `guided_json`** による構造化出力（scout も対応）。
- **prompt で JSON 指示 + スキーマ検証 + 修復フォールバック**（§8 リスク表の既定方針）。出力機構をモデル非依存にできる。
- **大 context・低単価・高速モデル**（例: llama-4-scout 131k）＋ 出力検証で 504/長文/コストを改善。
- 他の公式 JSON Mode 候補（`deepseek-r1-distill-qwen-32b`, `llama-3.1-70b` 等）の日本語精度実測（Cloudflare docs に日本語ベンチは無し）。
- **非 LLM/軽量手段の併用**（ルールベース抽出・正規表現・DOM 構造利用）で「早く・安く」取れる項目は LLM を使わない。

→ これらは抽出機構そのものの設計判断であり、`EXTRACTION_MODEL` 定数の差し替え（§5.3 のガードレール内）に留まらない。
別タスクとして起票し、Phase 1 のデータモデル確定前に方針を固めることを推奨。
