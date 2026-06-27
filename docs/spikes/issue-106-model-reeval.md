# Issue #106 — 抽出モデル再評価 → 既定更新（spike 記録）

> 実装計画: `docs/superpowers/plans/2026-06-27-phase2-expansion.md` Task 13（Wave 2）。
> 受け入れ: より広 context・高速・FC 対応候補を golden で横並び評価し既定更新。モデル ID/価格は一次ソース確認。
> golden 精度が現行以上を合格条件、劣化ならアダプタで差し戻し。
>
> **状態（2026-06-27）**: 評価ハーネス・モデル差し替えアダプタ・候補 shortlist に加え、
> **live golden eval ランナー（dev 限定 route ＋ Node driver）を実装**。ユーザーが自分の secrets/account で
> 実行できる（手順は「live 実行手順」節）。**既定の最終確定（勝者選定）は live golden が必須で subagent は
> live 実行不可のため引き続き要手動検証**。既定は現行 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` のまま
> 据え置き（劣化防止・差し戻し既定）。

## 前提（#15 の所見を引き継ぐ）

`docs/spikes/issue-15-model-comparison.md` が一次ソース。要点:

- 現行 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` は**唯一の公式 JSON Mode 対応・忠実**だが、遅さ・**504**・**context 24k** が弱点。
- 候補だった `@cf/openai/gpt-oss-120b` は reasoning モデルで JSON Mode 非遵守（`content=null` / `reasoning_content`）→ 現行 JSON Mode パスでは抽出不能（health ping 専用に留まる）。
- `@cf/meta/llama-4-scout-17b-16e-instruct` は JSON Mode 公式保証外で取りこぼし多発（131k context・安価・高速）。
- #15 の結論: **JSON Mode 単体に固定する限り公式対応リストに縛られ、速度/コスト/context/504 を改善できない**。出力機構を広げて広 context・高速・安価モデルを射程に入れることが #106 の本質。

→ したがって #106 の核心は「モデル ID の差し替え」だけでなく「**機構（JSON Mode ↔ Function Calling / prompt+検証）のアダプタ化**」とセット。本 PR は **モデル軸の差し替えアダプタ + モデル横断評価ハーネス**を提供する。広 context FC モデルを既定にするには **機構アダプタの拡張（follow-up）** が要る（後述）。

## 候補 shortlist（一次ソース確認・2026-06-27）

出典:
- JSON Mode 対応一覧: <https://developers.cloudflare.com/workers-ai/features/json-mode/>
- Function calling 対応: <https://developers.cloudflare.com/workers-ai/features/function-calling/>
- モデルカタログ: <https://developers.cloudflare.com/workers-ai/models/>
- 価格: <https://developers.cloudflare.com/workers-ai/platform/pricing/>

| ラベル | モデル ID | 機構 | context（カタログ記載） | 価格（in / out, per M tok） | 位置づけ |
| --- | --- | --- | --- | --- | --- |
| incumbent | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | **JSON Mode 対応** | 公称大だが Workers AI 実効 24k（#15 実測） | $0.293 / $2.253 | 現行既定。忠実だが遅い・504・24k |
| llama3.1-8b-fast | `@cf/meta/llama-3.1-8b-instruct-fast` | **JSON Mode 対応** | — | $0.045 / $0.384（`llama-3.1-8b-instruct-fp8-fast` 行） | 同機構ドロップイン候補。高速・安価。精度は golden 次第 |
| mistral-small-3.1 | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Function calling | 〜128k | $0.351 / （要確認） | 広 context・多言語（日本語）。機構=FC |
| llama4-scout | `@cf/meta/llama-4-scout-17b-16e-instruct` | Function calling | 広 context（Llama 4・MoE 17B active） | （モデルページで要確認） | 広 context・高速。#15 で JSON Mode 取りこぼし。機構=FC/検証 |
| glm-4.7-flash | `@cf/zai/glm-4.7-flash`（slug。`@cf/...` 正式 ID はモデルページで確認） | Function calling | 131,072 | （要確認） | 広 context・高速・多言語 100+。機構=FC |
| qwen3-30b-a3b | `@cf/qwen/qwen3-30b-a3b-fp8` | Function calling | （要確認） | （要確認） | MoE（3B active=高速）・多言語・reasoning。機構=FC |
| gpt-oss-120b | `@cf/openai/gpt-oss-120b` | Function calling / reasoning | 128,000 | $0.35 / $0.75 | #15 で JSON Mode 0 充足（content=null）。FC/Responses 経路前提。出典 [↗](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) |
| gpt-oss-20b | `@cf/openai/gpt-oss-20b` | Function calling / reasoning | 128,000 | $0.20 / $0.30 | 低レイテンシ版。gpt-oss 系は JSON Mode 非遵守（#15）。出典 [↗](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/) |
| gemma-4-26b-a4b-it | `@cf/google/gemma-4-26b-a4b-it` | Function calling / reasoning / vision | 256,000 | $0.10 / $0.30 | **256k context・最安級**。広 context 最有力。JSON Mode 一覧外＝機構 FC。出典 [↗](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) |

注:
- **JSON Mode 公式対応**は incumbent と `llama-3.1-8b-instruct-fast` のみ（一覧記載）。他候補は Function calling 側で、JSON Mode の `response_format: json_schema` は**保証外**。広 context FC モデルを評価するには live で response_format の充足を確認するか、機構を FC へ切り替える必要がある。
- 価格の「要確認」はカタログ表が当該行で truncated のため。**eval 時に各モデルページ / pricing で最終確認**する（記憶で埋めない）。

## 実装した差し替えアダプタ（モデル軸）

- `src/server/extract/extract.ts`
  - `EXTRACTION_MODEL`: コード側の**最終フォールバック**定数（既定の直接の旋回点ではない）。
  - `resolveExtractionModel(configured?)`: env 値→実効モデル ID 解決（空/未設定はコード既定へ）。
  - `extractJob(ai, body, { model })`: `options.model` を優先（評価ハーネスが候補ごとに注入）。
- `wrangler.jsonc` `vars.EXTRACTION_MODEL`: **既定変更はこの 1 行で完結**（フォーク先は `.dev.vars` でも上書き可）。
- 配線: `app.ts` / `index.ts`（queue consumer）が `env.EXTRACTION_MODEL` を ingest 経路（`ingestFromUrl` / `ingestFromHtml` / `reextractJob` → `ingestJob` → `extractJob`）へ伝播。

## 評価ハーネス（決定的・オフライン）

`src/server/extract/model-eval.ts`（unit: `model-eval.test.ts`）。live 推論は extractor 生成の注入で driver 側へ分離。

- `compareModels(baseline, candidate)`: フィールド別／全体の精度差。劣化判定は `correct` 件数（golden 期待値で total はモデル非依存＝同分母）で行い浮動小数誤差を避ける。`acceptable` = 全体が現行以上 ∧ どのフィールドも劣化なし。
- `selectModel(baseline, candidates)`: 合格候補のうち overall correct を**厳密に上回る**最良を採用。同点・合格者なしは現行維持（差し戻し）。
- `evaluateModels(cases, baselineModel, candidateModels, makeExtractor)`: 候補ごとに `runGolden`（#100）を回し選定まで返す。
- `EXTRACTION_MODEL_CANDIDATES`: 候補カタログ（id・機構・context・価格・備考の単一ソース・現在 8 件）。live ドライバは `.map((c) => c.id)` を `candidateModels` に渡す。現行既定（baseline）は含めない。

## live 実行手順（要手動検証・ユーザーが secrets/account で実行）

live golden eval は「dev 限定 route（`POST /api/_eval-models`）＋ Node 製 driver（`scripts/eval/eval-models.mjs`）」で回す。
env.AI は workerd 内でしか叩けず、golden 実体は PII（gitignore）でディスク上にしか無いため、driver が
ディスクから golden を読み route へ POST する分離構成にしている（[[localhost-fetch-via-mjs-driver]]）。
route は本番安全のため `EXTRACTION_EVAL==="1"` のときだけ動作し、未設定/それ以外は **404**（多数の AI
呼び出しを誘発するため gate を最優先で評価）。

機構は #107 のアダプタ（`mechanism.ts` の `resolveExtractionMechanism`）でモデル ID から自動解決され、
route は本番取込と同じ `extractJobFromHtml(env.AI, html, { model })` 経路（content prep＋分割パス＋機構
自動解決）で抽出する。JSON Mode 公式対応は incumbent / `llama-3.1-8b-instruct-fast` のみで、FC 系は
`tool_choice` の受理がモデル依存のため **live でのみ充足が判明する**（非対応は extraction_failed → 全
unknown となり golden で 0 点に出る）。

### 手順

1. **secrets / dev フラグを置く**（`.dev.vars`。Claude は触れない・ユーザーが手動配置）:
   - `EXTRACTION_EVAL=1`（このフラグが無いと route は 404）。
   - Workers AI を呼べる account 認証（`wrangler dev` が Cloudflare アカウントにログイン済みであること）。
2. **golden 実体を置く**: `test-fixtures/golden/*.json`（PII あり・gitignore）。`*.example.json` 雛形でも動く
   （精度差は薄い）。形式は `parseGoldenCase`（`golden.ts`）／`test-fixtures/golden/README.md` を参照。
3. **dev を起動**: `npm run dev`（= `vite build && wrangler dev`）。既定 port は 8787。
4. **driver を実行**: `node scripts/eval/eval-models.mjs`
   （port を変えた場合は `--port <n>` か `EVAL_PORT`、出力先は `--out <path>`）。
5. **結果の見方**: driver は候補ごとに `overall <correct>/<total>（delta 符号付き %）` と `acceptable`、
   `regressed:` フィールド一覧を表示し、末尾に `selected: <model> (changed: yes/no)` を出す。
   生 `ModelSelection` は `eval-result.json`（gitignore）に保存される。
   - 各候補は baseline（現行既定）と横並びで、`acceptable` = overall correct ≥ 現行 ∧ フィールド単位の劣化ゼロ。
   - `selectModel` が合格候補のうち overall correct を**厳密に上回る**最良を勝者にする（同点・合格者なしは現行維持）。
6. **勝者確定後の既定更新（1 箇所）**: `wrangler.jsonc` の `vars.EXTRACTION_MODEL` を勝者 ID に書き換える
   （コード変更不要）。`npm run dev` を再起動し driver を再実行して現行以上を再確認する。

> 注: 本タスク（#106 の live eval ランナー）は**ツールの提供まで**。実モデルでの勝者確定は account/secrets を
> 持つユーザーが上記手順で実行する（**要手動検証**）。route の gate・body 検証・evaluateModels 経路は fake
> binding でユニットテスト済み（`src/server/eval-models-route.test.ts` / `src/server/extract/eval-driver.test.ts`）。

## 決定

- **既定は現行 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` を据え置き**（live 未実施・劣化防止の差し戻し既定）。
- 本 PR で「モデル差し替えアダプタ」「決定的な横断評価ハーネス」「候補 shortlist + live 手順」を確定。

## follow-up（申し送り）

- **機構アダプタの拡張（最優先）**: 広 context FC モデル（mistral-small-3.1 / llama-4-scout / glm-4.7-flash / qwen3）を既定にするには `extractJob` の出力機構を JSON Mode 固定から Function calling / prompt+スキーマ検証へアダプタ化する必要がある（#15・requirements §8 の方針）。これにより 504 / 24k / 遅さ / コストの根本対処になる。#107（コンテンツ抽出改善・Task 14）と協調。
- **golden 拡充**: 現行 golden が薄いと精度差が出ない。複数社・長文（504 誘発帯）を含めると差が顕在化する。
- **価格の最終確認**: 「要確認」セルを eval 時にモデルページ / pricing で埋める。
