# Issue #65 — JSON Mode に依存しない構造化抽出機構の方針決定（spike 決定記録）

> DoD: JSON Mode 単体依存の制約を踏まえ、構造化抽出の機構（function calling / `guided_json` / prompt+スキーマ検証+修復 / 非 LLM 併用）を比較検討し、Phase 1 で採用する抽出機構の方針を決定・記録する。本ファイルが成果物。
>
> 親 Issue: #70（Phase 1 — MVP, Wave 1）。先行: [`issue-15-model-comparison.md`](./issue-15-model-comparison.md)。
>
> **状態（2026-06-22）**: 方針は決定済み（下記「決定」）。モデル別の日本語抽出**精度・速度・コストの live 実測**は account/secrets 依存で subagent では実行不可のため「要手動検証」として計測項目を明記する（下記「要手動検証」）。
>
> **更新（2026-06-23）**: 既定モデルを確定する前に**検証対象を見直し**（一次ソース再確認）。live 実測の対象を `glm-4.7-flash` / `llama-4-scout` / `gpt-oss-20b` / `gpt-oss-120b` / `gemma-4-26b-a4b-it`（＋現行 `llama-3.3-70b` baseline）に整理した。**現時点で候補間の優劣は判定せず**、live 実測で平等に比較して既定モデルを確定する。詳細は下記「検証対象モデル」「要手動検証」。機構の決定（アダプタ＋コード側 検証/修復/正規化）は不変。
>
> **更新（2026-06-24）**: 検証対象に [`@cf/qwen/qwen3-30b-a3b-fp8`](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/) を追加（一次ソース確認）。Qwen3 MoE・reasoning 系・context 32,768・FC 対応・JSON Mode 非対応。他候補と**平等に** live 実測する。下表「検証対象モデル」「要手動検証」に反映。機構の決定は不変。

## 前提（#15 で判明した制約）

#15 の手動検証で、現行の **Workers AI JSON Mode（`response_format: { type: "json_schema" }`）に固定すると次の制約を受ける**ことが判明した（一次ソース: `docs/spikes/issue-15-model-comparison.md`）。

- **モデルが公式サポートリストに縛られる**。JSON Mode の公式対応モデルは Llama 3.x 系・hermes-2-pro・deepseek 系のみ（下表）。`llama-4-scout` / `gpt-oss-120b` は非対応で、scout は取りこぼし多発・gpt-oss は `content=null`。
- **llama-3.3-70b は context 24,000 tokens が上限**。入力が増える（実測 2,822 chars）と単発呼び出しで **504 Gateway Timeout**。本番 `extractJob` は 504 を 3 回リトライするが、レイテンシ・失敗リスクは実在。
- requirements §8 リスク表も「JSON Mode **＋ スキーマ検証 ＋ フォールバック**」とセットで規定しており、JSON Mode 単体に 100% は委ねていない。

つまり制約の本質は「**出力の構造化を JSON Mode という単一機構に縛っていること**」であり、`EXTRACTION_MODEL` 定数の差し替え（§5.3 ガードレール内）では解けない。本 spike は抽出機構そのものの設計判断を行う。

## 一次ソース（Cloudflare Workers AI、2026-06-22 確認）

### JSON Mode 対応モデル一覧

出典: <https://developers.cloudflare.com/workers-ai/features/json-mode/>

`llama-3.1-8b-instruct-fast` / `llama-3.1-70b-instruct` / **`llama-3.3-70b-instruct-fp8-fast`（現行）** / `llama-3-8b-instruct` / `llama-3.1-8b-instruct` / `llama-3.2-11b-vision-instruct` / `hermes-2-pro-mistral-7b` / `deepseek-coder-6.7b-instruct-awq` / **`deepseek-r1-distill-qwen-32b`**。

> 重要（公式注記）: Workers AI は要求 JSON Schema 通りの応答を**保証しない**。満たせない場合はエラー `JSON Mode couldn't be met` を返し、**呼び出し側でハンドリングが必須**。JSON Mode は **streaming 非対応**。

### 機構・モデルの比較軸（一次ソース裏取り）

| 機構 | API 形 | モデル可搬性 | 形式保証 | 備考 |
| --- | --- | --- | --- | --- |
| **JSON Mode**（現行） | `response_format: { type:"json_schema", json_schema }` | 公式対応モデルのみ（上記9種） | schema 準拠を試みるが**保証なし**（`couldn't be met` あり）。streaming 不可 | OpenAI 互換。`required` 必須 |
| **Traditional function calling** | `tools: [{name, description, parameters}]` → `response.tool_calls` | function calling 対応モデル（scout=Yes / llama-3.3=Yes / hermes-2-pro 等） | tool_calls の arguments で構造化。**保証なし**（モデル次第） | 出典: function-calling/traditional/ |
| **Embedded function calling** | `@cloudflare/ai-utils` の `runWithTools` | hermes-2-pro 等 | 関数実行まで束ねる用途。**本件は外部 API 呼ばないので不要** | 依存追加・サプライチェーン面で重い |
| **prompt で JSON 指示 + スキーマ検証 + 修復** | 通常 `messages` のみ | **全 text-generation モデル**（scout/gpt-oss 含む） | コード側の検証で**機構として保証**を作る | §8 既定方針。モデル非依存 |
| **非 LLM 併用**（正規表現・DOM・ラベル正規化） | LLM 呼ばない | N/A | 決定的（テストで担保） | 既に `job-schema.ts` に LABEL_ALIASES / `parseNumbers` 等あり |

`guided_json` は scout 等で**パラメータは存在するが JSON Mode 公式保証外**（#15 根本原因より）。実体は上記「prompt+検証+修復」と同じ扱いに帰着する。

### 検証対象モデル（2026-06-23 再確認）

出典: 各 model ページ・`/platform/pricing/`・`/models/`（2026-06-23 確認）。「早く・安く・日本語」の観点で live 実測の対象を下表に整理する。**現時点で候補間の優劣は判定しない**（live 実測で平等に比較し既定モデルを確定する）。

| モデル ID | Context | FC | JSON Mode | in/out (per M) | 備考（事実のみ） |
| --- | --- | --- | --- | --- | --- |
| [`@cf/meta/llama-3.3-70b-instruct-fp8-fast`](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)（現行） | 24,000 | Yes | 対応 | $0.29 / $2.25 | incumbent baseline。context 小・504 リスク |
| [`@cf/zai-org/glm-4.7-flash`](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/) | 131,072 | Yes | 非対応 | $0.06 / $0.40 | 多言語 100+・reasoning 系（`content` 挙動を要確認）・アダプタ経由 |
| [`@cf/meta/llama-4-scout-17b-16e-instruct`](https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/) | 131,000 | Yes | 非対応 | $0.27 / $0.85 | #15 で取りこぼし→`required`＋修復前提・アダプタ経由 |
| [`@cf/openai/gpt-oss-20b`](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/) | 128,000 | Yes | 非対応 | $0.20 / $0.30 | reasoning 系・**Responses API 経由** |
| [`@cf/openai/gpt-oss-120b`](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) | 128,000 | Yes | 非対応 | $0.35 / $0.75 | reasoning 系・**Responses API 経由** |
| [`@cf/google/gemma-4-26b-a4b-it`](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) | 256,000 | Yes | 非対応 | $0.10 / $0.30 | Gemma 4・reasoning 系・`response_format` param 有(公式保証外)・アダプタ経由 |
| [`@cf/qwen/qwen3-30b-a3b-fp8`](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)（2026-06-24 追加） | 32,768 | Yes | 非対応 | $0.051 / $0.34 | Qwen3 MoE(A3B=active 3B)・reasoning 系（`content` 挙動を要確認）・多言語・Batch 対応・アダプタ経由 |

- JSON Mode 非対応の候補（glm-4.7-flash / llama-4-scout / gpt-oss-20b / gpt-oss-120b / gemma-4-26b-a4b-it / qwen3-30b-a3b-fp8）は**「prompt+検証+修復」または function calling アダプタ経由**でコード側保証が前提。
- 上記候補は live 実測で**同一サンプル・同一プロンプト/スキーマで横並び・平等に評価**する。

## 検討（Phase 1 での適合性）

- **JSON Mode 単体（現行維持）**: 小入力では忠実だが、context 24k と 504 が解消しない。長文求人・将来の一覧展開（#21）で詰む。形式保証もそもそも「保証なし」。→ 単体採用は不可。
- **Traditional function calling**: tool_calls で構造化でき scout でも使えるが、**arguments の schema 準拠は同じく保証なし**。JSON Mode と保証レベルは変わらず、API 形が増えるだけ。単独の決め手にならない。
- **prompt + スキーマ検証 + 修復**: 出力機構を**モデル非依存**にできる唯一の手段。検証・修復・正規化を**コード側の決定的ロジック**に置けば、どの構造化機構（JSON Mode / function calling / 素の prompt）を表面に使ってもバックエンドで品質を担保できる。§8 既定方針とも一致。
- **非 LLM 併用**: ラベル正規化・数値パース・カテゴリ正規化は既に `job-schema.ts` / `extract.ts` の決定的ロジックに存在。**「LLM は正規キーごとの生抽出文字列を返すだけ、正規化と検証はコード」という現行の責務分離を維持・強化**するのが正しい。LLM の役割を最小化するほど速く・安く・揺れにくい。

## 決定（Phase 1 採用方針）

**「構造化機構は差し替え可能なアダプタとし、品質保証はコード側の `検証 → 修復 → 正規化` レイヤに集約する」** ことを採用する。具体的には:

1. **抽出アダプタを抽象化する**。AI への要求は現行どおり「正規キーごとの生抽出文字列」を返させる契約を維持し、その実現手段（JSON Mode / traditional function calling / 素の prompt）を**差し替え可能なアダプタ**として切り出す。`extractJob` 本体・正規化・スコアリングはアダプタに依存しない。
   - これは §5.3 ガードレール（`EXTRACTION_MODEL` 差し替え）を**機構レベルに拡張**するもの。機構もモデルもアカウント固有値も `wrangler.jsonc` / 環境変数経由で差し替えられるようにする（フォーク容易性）。
2. **品質保証は機構非依存のコードレイヤで作る**（§8 既定方針）。`JSON Mode couldn't be met` や不完全 JSON を含め、`検証（スキーマ）→ 修復（部分パース・欠損補完）→ 正規化（ラベル・unknown 中立）`の決定的パイプラインを通す。形式保証をモデルに委ねない。
   - 現行 `extract.ts` の「想定外形は落とさず全 unknown へ畳む」「504 リトライ」は維持。これに**部分的に取れたフィールドだけでも救う修復**（全 unknown へ畳む前に、得られたキーは活かす）を加える方向。
3. **既定モデルは Phase 1 でも JSON Mode 対応モデルを incumbent として維持**しつつ、**長文・コスト対策の候補を「prompt+検証+修復」アダプタ経由で評価**する。検証対象は上表（`glm-4.7-flash` / `llama-4-scout` / `gpt-oss-20b` / `gpt-oss-120b` / `gemma-4-26b-a4b-it` / `qwen3-30b-a3b-fp8` ＋ 現行 baseline）。**現時点で優劣は付けず**、下記 live 実測で平等に比較して既定モデルを確定する（本 spike は機構を決め、モデル最終確定は #15 系の実測フォローに委ねる）。
4. **LLM の役割は最小化する**。決定的に取れる項目（ラベル一致・数値・カテゴリ）は非 LLM のコードで処理し、LLM は不定形テキストからの抽出に限定する。既存の責務分離を維持。

### 採用しない/保留

- **Embedded function calling（`@cloudflare/ai-utils`）は採用しない**。本件は外部 API を呼ばず構造化出力が欲しいだけで、関数実行の束ねは不要。依存追加はサプライチェーン面（CLAUDE.md セキュリティ方針）でも割に合わない。
- **JSON Mode の全廃はしない**。対応モデルでは形式の取りやすさに寄与するため、アダプタの一実装として残す。単体依存をやめるだけ。

## #16 / #68 への含意（申し送り）

### → #16（D1 データモデル: extractions テーブル）

採用機構が「機構非依存・コード側で検証/修復/正規化」であることから、extractions のカラム設計は次を満たすこと:

- **`structured_json`（正規スキーマ JSON）を保存**。これは `NormalizedJob`（`job-schema.ts`）= 全正規キー必須・各値が `numericRange|categorical|aiJudged|unknown` の判別共用体。スコアリング（#20）はこれだけを読み AI 非再実行（§5.3）。
- **`model`（使用モデル ID）に加え、抽出機構を識別する `mechanism`（例: `json_mode` / `function_calling` / `prompt_repair`）を保存**。機構が差し替え可能になったため、再現性・監査・将来の再抽出要否判断に必要。
- **`extraction_status`（`ok` / `extraction_failed`）を保存**（`ExtractionStatus` 相当）。全 unknown が「中立」か「失敗の畳み込み」かを区別するため（§5.2）。これを持たないと #20 のスコアリングが失敗を中立と誤認する。
- 任意で **`raw_fields`（正規化前のキー別生文字列）/ `repaired`（修復が走ったか）** を監査用に保存できると、機構比較・精度回帰の追跡に有用。R2 の生 HTML への参照キー（#16→#17）とは別レイヤ。
- 形式: 構造化 JSON は D1 の TEXT カラムに JSON 文字列で格納（D1 は構造化データ用、§6）。スキーマバージョン列（`schema_version`）を持たせると正規キー集合の増減（フォーク・将来拡張）に耐える。

### → #68（aiJudged の実値化: requiredSkillsMatch / preferredSkillsMatch）

- 現状 `requiredSkillsMatch` / `preferredSkillsMatch` は `aiJudged` kind だが **score:0 プレースホルダ**（Phase 0 は unknown 中立扱い）。本機構の上では次の方向を推奨:
  - **突合は「抽出」と「スコアリング」で責務を割る**。抽出フェーズでは求人側の required/preferred スキル**集合**を `categorical`（正規化済みスキル名の配列）として取り出すに留める。希望スキル集合（ユーザー設定 = `criteria_config`）との**突合・0..100 算定はスコアリング側（#20）で決定的に行う**のが §5.3（抽出↔スコアリング分離）に合致。
  - こうすると、希望スキルの変更で **AI を再実行しない**（突合は決定的・ユニットテスト可能）。AI に 0..100 を直接出させると希望条件変更のたびに再判定が必要になり、§5.3 ガードレールに反する。
  - したがって **#68 は `aiJudged` の意味を「AI に主観点数を出させる」から「求人側スキル集合を抽出 → コードで希望集合と突合し 0..100 を算定」へ寄せる**ことを検討する。突合方式（含有率 / 完全一致 / 部分一致 + 重み）は決定的ロジックとして #20 と協調設計。
  - もし「AI 主観判定」を残すなら、それは抽出フェーズで求人単体に閉じた指標（例: 職務記述の具体性）に限定し、希望条件依存の点数は持たせないこと。
- データモデル含意（#16 へ波及）: スキル集合を保持するなら `requiredSkillsMatch` 系を抽出時点では **categorical（スキル名配列）として structured_json に格納**し、スコア値は scores テーブル側（#20）に置く。aiJudged の最終形は #68 で確定。

## 要手動検証（live 実測。secrets 必須のため subagent 不可）

`.dev.vars` に `account_id` / API token を配置し、`wrangler dev` で実モデルを叩いて計測する（#15 の `POST /spike/compare` 同様のハーネスを使い捨てで用意）。PII を含む生抽出は gitignored の `spike/` にのみ保存し、本ファイルには自動指標のみ残す。

計測項目。**検証対象は平等に扱い、事前に優劣を付けない**。共通の記録: 21 正規キー充足数・correct/wrong/hallucinated/missed（KIMURA 真値判定）・latencyMs・504 有無・概算コスト。#15 の小入力（〜1,900 chars）・大入力（〜2,822 chars 以上）で実施:

1. **検証対象（`glm-4.7-flash` / `llama-4-scout` / `gpt-oss-20b` / `gpt-oss-120b` / `gemma-4-26b-a4b-it` / `qwen3-30b-a3b-fp8` ＋ 現行 `llama-3.3-70b` baseline）を、同一サンプル・同一プロンプト/スキーマで横並び抽出**し、上記指標で平等に比較する。
2. **reasoning 系（`glm-4.7-flash` / `gpt-oss-20b` / `gpt-oss-120b` / `gemma-4-26b-a4b-it` / `qwen3-30b-a3b-fp8`）は `content` 挙動を最初に確認**（`content=null`/`reasoning_content` か）。`gpt-oss` 系は Responses API 経由。本文が `content` に入らない場合の取り回しを記録。
3. **JSON Mode 非対応候補（glm / scout / gpt-oss 20b・120b / qwen3-30b）は「prompt+検証+修復」アダプタ経由**で評価し、必要に応じ traditional function calling（`tools` → `tool_calls`）とも比較。`llama-4-scout` は `required` 列挙込み。各候補の context（qwen3-30b は 32,768、他は 128k 以上）で 504 が解消するかを確認。
4. 各機構で **`JSON Mode couldn't be met` / 不完全 JSON / tool_calls 欠損**の発生率と、修復レイヤが救えた割合を記録（修復の有効性検証）。
5. 概算コスト（入力 trim 後 token 数 × unit pricing）を機構別に出し、speed/cost/精度のトレードオフで**既定モデル + 既定機構を最終確定**。

## 受け入れ条件

| 条件 | 充足 |
| --- | --- |
| Phase 1 で採用する抽出機構の方針が決まったか | true（機構非依存アダプタ + コード側 検証/修復/正規化レイヤ） |
| #16（extractions データモデル）への含意が明確か | true（structured_json / model / mechanism / extraction_status / 任意 raw_fields・schema_version） |
| #68（aiJudged 突合方式）への含意が明確か | true（抽出はスキル集合を categorical 抽出、突合・0..100 算定はスコアリング側で決定的に） |
| モデル別の日本語精度・速度・コストの確定 | 要手動検証（secrets 依存・上記マトリクス） |
