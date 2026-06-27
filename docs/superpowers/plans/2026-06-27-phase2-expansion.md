# Phase 2 拡張 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本プランは Issue 1件＝1タスクの粒度で定義し、各タスク内の詳細 TDD（Red→Green→Refactor の bite-sized step）は wave-rider 配下の dev サブエージェントが Issue 実行時に展開する。

**Goal:** Phase 2 を拡張し、React SPA + Hono API 化・src レイヤ再編・スコアリング5軸再設計・抽出パイプライン最適化・UI 刷新を一体で実装する。

**Architecture:** Cloudflare Workers 単体は維持。Hono を `/api/*` JSON バックエンド、React(Vite) SPA を `assets` で配信。決定的スコアリング・抽出・取得はサーバー据え置き。`src/` を server/client/shared にレイヤ再編し、テストは co-located 継続。

**Tech Stack:** TypeScript / Cloudflare Workers / Hono / Workers AI / D1 / R2 / Queues / Browser Rendering / React / Vite / Tailwind CSS / shadcn/ui / lucide-react / Recharts / Vitest（workers + jsdom 2プロジェクト）/ Playwright / Biome。

入力 spec: [docs/superpowers/specs/2026-06-27-phase2-expansion-design.md](../specs/2026-06-27-phase2-expansion-design.md)

## Global Constraints

- 設計の最重要原則を全タスクで維持: 抽出↔スコアリング分離（重み変更で AI 再実行しない）／決定的スコアリング（同一入力・設定→同一スコア・ユニットテスト担保）／unknown 中立（分母から除外）／ラベル正規化（正規キーへ寄せる）／フォーク容易性（アカウント固有値・秘匿情報を直書きしない）。
- 開発手法: t-wada メソッドの TDD（Red→Green→Refactor）。決定的ロジックはユニットテスト必須。コメント・テスト名は日本語で簡潔に「なぜ」を書く。
- 既定抽出モデル（現行）: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` / json_mode（Wave 2 で再評価し更新しうる）。モデル ID・価格・仕様は記憶で答えず一次ソースで確認する。
- 秘匿ファイル（`.dev.vars`/`.env`）は Claude 読み書き禁止（PreToolUse hook が deny）。`*.example` のみ可。秘匿情報・PII・Cookie/セッションはコミット禁止。
- 依存導入は `.npmrc`（`ignore-scripts`/`save-exact`/`min-release-age=7`/`engine-strict`）・Dependabot cooldown・GitHub Actions の commit SHA 固定に従い、導入後 CI に `npm ci` + `npm audit` を保つ。
- ラベル「従業員への誠実さ」軸の表示名は**未確定**。内部識別子は仮に `integrity`（カテゴリキー）として実装し、表示文字列のみ後日差し替え可能にする。
- 並列実装は git worktree で分離（`node_modules` は symlink 共有）。worktree の `wrangler dev` は `.dev.vars` を手動配置（Claude は触れない）。
- merge は人間ゲート（wave-rider 実行モデル）。push/PR/merge は orchestrator が担当。

## File Structure（再編後の責務）

```
src/
  server/
    index.ts            # worker entry（fetch + queue handler, DI 配線）
    app.ts              # Hono /api/* ルーティング
    fetch/              # fetch-html, fetch-authed-html, browser-render(将来), list-detail
    extract/            # extract, ai, trim-html, content-extract(新), golden(新)
    scoring/            # score, ranking, criteria-config, rescore, rescore-core, skill-matcher
    storage/            # db-schema, raw-html-store, ingest
    queue/              # detail-queue, rate-concurrency
  client/               # React SPA（Vite）
    main.tsx, App.tsx
    routes/             # ダッシュボード / 設定ビュー
    components/         # shadcn/ui ＋ RankingCard, ScoreRadar, JobDetailSheet, AddJobModal, ScoreSkeleton
    lib/                # api クライアント・hooks（useRanking, useJobStatus）
  shared/
    job-schema.ts       # NormalizedKey・正規スキーマ（抽出/表示の単一ソース）
    categories.ts       # 5軸カテゴリ ↔ 項目の対応（単一ソース）
    design-tokens.ts    # → Tailwind theme / shadcn CSS 変数へ供給
```

テスト配置: 各実装ファイルに co-located（`x.ts`↔`x.test.ts` / `Component.tsx`↔`Component.test.tsx`）。

---

## Wave 構成（依存順・Issue マップ）

各 Wave ≒ サブシステム。Wave 内タスクは原則並列可。Wave 間は依存。各タスク = GitHub Issue 1件。

- **Wave 1 基盤**: T1–T6（src 再編 / API 化 / React 足場 / Tailwind+shadcn / Vitest 2プロジェクト / lockfile hook）
- **Wave 2 抽出・スコア**: T7–T14（golden ゲート / スキーマ削減 / benefitsCoverage / overtime / remoteWork / skillMatch / モデル再評価 / コンテンツ抽出）
- **Wave 3 UI**: T15–T21（シェル / カード / レーダー / 詳細ドロワー / Skeleton / 投入モーダル / 設定ビュー）
- **Wave 4 取得・運用**: T22–T23（取得戦略 / live スモーク）
- **Wave 5 評判統合**: T24（企業軸合流。既存 #30–#43 と紐付け）

依存: Wave1 → Wave2/Wave3、Wave2 →(scoring 型)→ Wave3、Wave4 は Wave1 後いつでも、Wave5 は Wave2(企業軸)後。

---

# Wave 1 — 基盤

### Task 1: src レイヤ再編（server/shared への移動・挙動不変）

**Files:**
- Move: `src/{index,app,fetch-html,fetch-authed-html,list-detail,extract,ai,trim-html,score,ranking,criteria-config,rescore,rescore-core,skill-matcher,db-schema,raw-html-store,ingest,detail-queue,rate-concurrency}.ts`（＋各 `.test.ts`）→ §File Structure の `server/` サブディレクトリへ
- Move: `src/job-schema.ts`, `src/design-tokens.ts`, `src/design-tokens-css.ts` → `src/shared/`（design-tokens-css は Wave1 T4 で置換予定だが本タスクでは移設のみ）
- Modify: 全相対 import パス、`wrangler.jsonc`（`main: "src/server/index.ts"`）、`scripts/build-css.mjs` の import、`vitest.config.ts` の include
- Test: 既存 `.test.ts` を同梱移動（パスのみ更新）

**Interfaces:**
- Produces: 公開シンボルは不変（移動のみ）。`src/server/index.ts` が新 worker entry。

**Acceptance:**
- `npm run test` 全 green（移動前と同数）、`npm run typecheck` green、`npm run lint` green、`wrangler deploy --dry-run` 成功。
- 挙動変更ゼロ（純粋リファクタ）。1コミットは大きいので「移動」と「import 修正」を分けてコミット。

**Notes:** import 解決誤りは tsc で検出。`@cf` 等の動的 import はリテラル維持（既知の罠: 変数 import 未バンドル）。

---

### Task 2: Hono SSR ページ → `/api/*` JSON エンドポイント化

**Files:**
- Modify: `src/server/app.ts`（ルート定義を `/api/*` JSON へ）
- Modify/Remove: `src/server/url-input.ts`, `paste-input.ts`, `criteria-form.ts`, `ranking-list.ts`, `result-display.ts`, `render-html.ts`（HTML 生成を撤去し、ハンドラはバリデーション＋ JSON 応答に縮約。HTML テンプレは削除）
- Test: 各ハンドラの `.test.ts` を JSON 応答前提に更新

**Interfaces:**
- Produces（API 契約・client が消費）:
  - `POST /api/jobs` body `{ url }` | `{ html }` → `201 { jobId, status }`
  - `GET /api/ranking` → `200 { jobs: RankingItem[] }`（RankingItem: `{ jobId, company, title, total, categories: Record<CategoryKey, number|null>, status }`）
  - `GET /api/jobs/:id` → `200 { job, extraction, breakdown: BreakdownRow[] }`
  - `POST /api/jobs/:id/reextract` → `202 { status }`
  - `GET /api/config` / `PUT /api/config` body `{ items: CriteriaConfigInput[] }` → `200`（PUT は再スコアリングをトリガ）
  - `GET /api/health` / `GET /api/ai-health`（既存維持）
- Consumes: 既存 ingest / ranking / criteria-config の関数群。

**Acceptance:** 各エンドポイントの JSON 契約をユニットテストで固定。HTML を返す経路が無いこと。重み変更（PUT /api/config）で AI 再実行せず再スコアされること（分離原則）。

---

### Task 3: React + Vite スキャフォルド ＋ Workers assets / SPA フォールバック

**Files:**
- Create: `vite.config.ts`（build.outDir = `public`、react プラグイン）, `index.html`, `src/client/main.tsx`, `src/client/App.tsx`, `src/client/lib/api.ts`（fetch ラッパ）
- Modify: `wrangler.jsonc`（`assets` の SPA フォールバック: 未知パス→`index.html`、ただし `/api/*` は Worker が処理）, `package.json`（`build`, `dev` scripts に Vite 連携）
- Modify: `.gitignore`（Vite の中間生成物。`public/` の生成物方針を明記）
- Test: `src/client/lib/api.test.ts`（api ラッパの URL 構築・エラー整形）

**Interfaces:**
- Produces: `apiGet/apiPost/apiPut(path, body?)` → 型付き結果。`App` が `/`（ダッシュボード）と `/settings` をルーティング（最小 router）。

**Acceptance:** `npm run build` で SPA が `public/` に出力。`wrangler dev` で `/` が SPA、`/api/health` が JSON。SPA ルートのリロードで 404 にならない（フォールバック）。

**Notes:** assets binding と `/api/*` の優先順位を実機（`wrangler dev`）で確認（オフライン素通り・live 露見クラスに注意）。

---

### Task 4: Tailwind + shadcn/ui + lucide 導入、design-tokens 供給切替

**Files:**
- Create: `tailwind.config.ts`（theme に `src/shared/design-tokens.ts` のトークンを供給）, `postcss.config.js`, `src/client/styles/globals.css`（Tailwind ディレクティブ＋ shadcn CSS 変数）, `components.json`（shadcn 設定）
- Create: `src/client/components/ui/*`（shadcn の button/card/sheet/dialog/badge/skeleton/table/chart を導入）
- Modify: `src/shared/design-tokens.ts`（Tailwind/CSS 変数へ供給する形へ）
- Remove: `src/shared/design-tokens-css.ts` ＋ `scripts/build-css.mjs` ＋ `public/styles.css` 直生成（Tailwind ビルドへ移行）、関連 `build:css` scripts
- Test: `src/shared/design-tokens.test.ts`（トークン→Tailwind theme 変換の単一ソース性）

**Interfaces:**
- Produces: shadcn UI プリミティブ、Tailwind ユーティリティ、トークン由来テーマ。

**Acceptance:** 文字色/サイズが shadcn 既定（Tailwind スケール＋ CSS 変数）。Claude Design 無しでビルド可。依存は SHA/`save-exact`/`min-release-age` 準拠で追加し `npm audit` green。

---

### Task 5: Vitest 2プロジェクト構成（workers + jsdom）

**Files:**
- Modify: `vitest.config.ts` → workspace 化（project `server`: `@cloudflare/vitest-pool-workers`、project `client`: `jsdom`/`happy-dom` + `@testing-library/react` + `@testing-library/jest-dom`）
- Create: `src/client/test-setup.ts`（testing-library 設定）
- Modify: `package.json`（`test` が両プロジェクトを実行）
- Test: `src/client/App.test.tsx`（最小レンダリングのスモーク）

**Acceptance:** `npm run test` で server（workerd）と client（jsdom）双方が実行され green。既存 server テストは workerd プロジェクトで従来通り。

---

### Task 6: lockfile tab→2-space 正規化 pre-commit hook

**Files:**
- Create: `.githooks/normalize-lockfile`（または既存 `.githooks/pre-commit` に追記）— `package-lock.json` が staged なら 2-space へ正規化し re-add
- Modify: README/CONTRIBUTING に hook 有効化（`core.hooksPath`）の記載があれば追記
- Test: hook スクリプトの動作確認手順を docs に明記（シェルスクリプトのため手動検証）

**Acceptance:** tab で書き換わった lockfile が commit 時に 2-space へ正規化される（#74 で再発した既知の罠の自動化）。

---

# Wave 2 — 抽出・スコア

### Task 7: golden-sample 抽出品質ゲート

**Files:**
- Create: `src/server/extract/golden.ts`（golden ランナー: 入力 HTML → 抽出 → 期待値とフィールド単位 diff、精度スコア算出）
- Create: `src/server/extract/golden.test.ts`
- Create: `test-fixtures/golden/.gitignore`（実体 HTML/期待値は PII を含むため ignore。`*.example`/サニタイズ済のみ追跡）, `test-fixtures/golden/README.md`（投入手順）
- Modify: `.gitignore`（`test-fixtures/golden/*` を ignore、`!*.example` 許可）

**Interfaces:**
- Produces: `runGolden(cases): GoldenReport`（`{ perField: Record<NormalizedKey, {correct,total}>, overall }`）。後続 T8–T14/T13 が回帰判定に使用。

**Acceptance:** サニタイズ済 1 件以上で golden が走り、フィールド別精度を出力。CI ジョブ（任意・PII なしサンプルのみ）として追加可能な形。PII 実体は未コミット。

**Notes:** Phase 1 retro 繰り越し「抽出品質ゲートの前倒し」。これが Wave2 の他タスクの回帰土台。

---

### Task 8: スコアリング項目の削減・5軸再カテゴリ化

**Files:**
- Modify: `src/shared/job-schema.ts`（`NormalizedKey` から削除キーを除去: monthlySalary[採点], salaryRaise, paidLeaveRate, holidaySystem[独立], retirementAllowance[独立], workLocation, employmentType, employmentTerm, businessDomain, languageRequirement, companyPhase, techStack/requiredSkillsMatch/preferredSkillsMatch[→skillMatch]。追加: `skillMatch`, `benefitsCoverage`, `capital`）
- Create: `src/shared/categories.ts`（5軸 `compensation|integrity|flexibility|role|company` ↔ 項目対応の単一ソース。`integrity` の表示名は未確定で別途）
- Modify: `src/server/scoring/criteria-config.ts`（`NORMALIZED_KEY_KINDS` を新項目集合へ。`skillMatch` は keyword kind、`benefitsCoverage` は coverage kind、`capital` は numericRange higherBetter）
- Modify: 既定 seed（criteria_config 初期値）, `src/server/extract/extract.ts`（抽出スキーマ・プロンプトを新項目へ。monthlySalary は年収補完材料として抽出のみ）
- Test: 上記各 `.test.ts` を更新

**Interfaces:**
- Produces: 新 `NormalizedKey` 集合、`CATEGORY_OF: Record<NormalizedKey, CategoryKey>`、`CategoryKey` 型。Wave3 レーダー/内訳が消費。

**Acceptance:** 旧キーは無視され（unknown 中立で分母外）、再スコアが決定的に走る。型で全キー網羅。golden（T7）で構造退行なし。

---

### Task 9: benefitsCoverage（canonical 閉集合・充足率）

**Files:**
- Create: `src/server/scoring/benefits-coverage.ts`（canonical signal 閉集合の定義＋ `coverage(signals, weights?) → 0..100`）
- Create: `src/server/scoring/benefits-coverage.test.ts`
- Modify: `src/server/extract/extract.ts`（benefits signal の boolean 集合を抽出・保存。休日制度 完全週休2日制／各種休暇制度／その他福利厚生を spec §5.2 初期セットで）
- Modify: `src/server/scoring/score.ts`（`benefitsCoverage` kind の採点を coverage 比で。任意の重視 signal 重みに対応）
- Modify: `src/shared/job-schema.ts`（benefits signal 集合の型）

**Interfaces:**
- Produces: `BENEFIT_SIGNALS`（閉集合）, `computeBenefitsCoverage(present: BenefitSignalSet, emphasis?: BenefitSignalKey[]): number`。

**Acceptance:** 充足率＝該当数/総数（決定的・テストで境界固定）。認識外の記載は計上しない（閉集合）。holidaySystem/retirementAllowance は signal として吸収。表示は1スコア＋展開内訳（Wave3）。

---

### Task 10: overtime 定量化＋「有り明記だが定量なし」減点特例

**Files:**
- Modify: `src/server/extract/extract.ts`（overtime を ①平均残業 →②みなし残業 の定量値＋ `overtimeStated: boolean`（有り明記か）＋ `overtimeHours: number|null` で抽出）
- Modify: `src/server/scoring/score.ts`（numericRange lowerBetter。特例: `overtimeStated && overtimeHours==null` → 中立でなく減点。`!overtimeStated && hours==null`（記載なし）→ 中立）
- Test: `score.test.ts` に特例2分岐の境界テスト

**Interfaces:**
- Produces: overtime サブスコア関数（特例分岐込み）。

**Acceptance:** 「有り明記だが定量なし」が減点、「記載なし」が中立、定量あり（平均優先→みなし）が連続採点。unknown 中立の意図的例外を日本語コメントで明文化。

---

### Task 11: remoteWork 細分化（full/partial/onsite・full別格）

**Files:**
- Modify: `src/server/extract/extract.ts`（remoteWork canonical を `full|partial|onsite` に決定的正規化。requirements §5.2.1 の canonical 定義へ追加）
- Modify: `src/server/scoring/score.ts`（categorical 採点で `full` を別格加点。`partial`/`onsite` と明確に差別化）
- Test: 正規化と採点の `.test.ts`

**Acceptance:** フルリモートが partial/onsite より明確に高得点。canonical 外は生表記を1カテゴリとして保持（情報を捨てない）。

---

### Task 12: skillMatch 統合（keyword 方式・aiJudged 廃止）

**Files:**
- Modify: `src/server/scoring/skill-matcher.ts`（techStack＋必須＋歓迎を統合した求人スキル集合 × ユーザー keyword の決定的ヒット採点）
- Modify: `src/server/scoring/criteria-config.ts`（`skillMatch` の `desired_value` を `{ keywords: string[] }` に。aiJudged kind 廃止）
- Modify: `src/server/extract/extract.ts`（求人側スキル/要件テキストを skillMatch 用に抽出統合）
- Modify: `src/server/scoring/score.ts`（aiJudged 経路の撤去）
- Test: `skill-matcher.test.ts` / `criteria-config.test.ts` / `score.test.ts` 更新

**Interfaces:**
- Produces: `matchSkills(jobSkills: string[], keywords: string[]): number`（0..100・決定的）。

**Acceptance:** 必須/歓迎の区別なし。aiJudged が型・実装から消える。keyword ヒットで決定的・再現可能。

---

### Task 13: 抽出モデル再評価 → 既定更新

**Files:**
- Create/Modify: `docs/spikes/issue-XX-model-reeval.md`（候補モデル・一次ソース・golden 結果・決定）
- Modify: `src/server/extract/extract.ts` / `wrangler.jsonc`（既定モデル ID を golden 合格モデルへ。アダプタ機構は維持）
- Test: 既存 extract テスト＋ golden（T7）で横並び比較記録

**Acceptance:** より広 context・高速・FC 対応候補を golden で横並び評価し既定更新。**モデル ID/価格は一次ソース確認**。golden 精度が現行以上であることを合格条件にし、劣化なら差し戻し（アダプタ）。

**Notes:** llama-3.3-70b の遅さ・504・context 24k の根本対処。

---

### Task 14: コンテンツ抽出改善（セクション保持・分割パス・トークン削減）

**Files:**
- Create: `src/server/extract/content-extract.ts`（本文＋福利厚生/休暇セクションを保持しつつトリミングする構造的抽出）
- Modify: `src/server/extract/trim-html.ts`（content-extract と連携・役割整理）
- Modify: `src/server/extract/extract.ts`（重い benefits 集合は必要に応じ分割パスで抽出し 504/context 回避）
- Test: `content-extract.test.ts`（セクション保持・トークン削減）＋ golden 回帰

**Acceptance:** benefitsCoverage に必要なセクションを落とさず入力トークンを削減。golden 精度が T13 比で維持/向上。504 が発生しにくい入力サイズに収まる。

---

# Wave 3 — UI

### Task 15: ダッシュボードシェル（トップバー＋右ドロワー）＋ ルーティング

**Files:**
- Create: `src/client/routes/Dashboard.tsx`, `src/client/components/TopBar.tsx`, `src/client/components/JobDetailSheet.tsx`（Sheet ガワ）, `src/client/lib/useRanking.ts`
- Modify: `src/client/App.tsx`（`/` ダッシュボード, `/settings` 設定）
- Test: `Dashboard.test.tsx`, `TopBar.test.tsx`

**Interfaces:**
- Consumes: `GET /api/ranking`。Produces: 行選択 → Sheet オープン状態。

**Acceptance:** `/` でランキング取得・表示、トップバーに投入/設定、カードクリックで右ドロワーが開く。

---

### Task 16: ランキング カード（ベスト3強調・lucide・色統一）

**Files:**
- Create: `src/client/components/RankingCard.tsx`（通常）, `RankingPodium.tsx`（ベスト3: trophy/medal lucide ＋ 金銀銅 枠色）
- Test: `RankingCard.test.tsx`（スコア/チャート文字色が順位非依存で統一、順位は枠色＋アイコンのみ）

**Acceptance:** ベスト3が強調、4位以降は通常カード、絵文字なし（lucide）、スコア/チャート文字色統一。

---

### Task 17: ScoreRadar（shadcn Chart / Recharts・5軸）

**Files:**
- Create: `src/client/components/ScoreRadar.tsx`（5軸 `categories.ts` 連動。unknown 軸は中立表示）
- Test: `ScoreRadar.test.tsx`（軸数・unknown 中立・単一アクセント色）

**Interfaces:**
- Consumes: `categories.ts` の `CategoryKey` 順、`Record<CategoryKey, number|null>`。

**Acceptance:** 5軸レーダーが描画、データ無し軸は中立/破線、塗りは単一アクセント。カード/ドロワー両方で再利用。

---

### Task 18: 詳細ドロワー（フラット内訳・アクション 再抽出/評判取得）

**Files:**
- Modify: `src/client/components/JobDetailSheet.tsx`（ヘッダ／サマリ レーダー／**フラット内訳表**：項目・抽出値・希望値・サブスコア・重み、unknown 中立明示、ハードフィルタ バッジ。benefitsCoverage は「充足度 NN%」1行＋展開）
- Create: `src/client/components/BreakdownTable.tsx`
- Test: `BreakdownTable.test.tsx`（フラット・unknown 表記・benefits 展開）

**Interfaces:**
- Consumes: `GET /api/jobs/:id`（breakdown）。アクション: `POST /api/jobs/:id/reextract`、評判取得（前提未設定なら案内文）。

**Acceptance:** アコーディオンでなくフラット表。アクションは「再抽出」「評判取得」の2つ。評判は `ANTHROPIC_API_KEY` 等 未設定時に実行ボタン無効＋設定への案内文。

---

### Task 19: Skeleton ＋ 抽出中 楽観的 UI / ポーリング

**Files:**
- Create: `src/client/components/ScoreSkeleton.tsx`, `src/client/lib/useJobStatus.ts`（ポーリング）
- Modify: `Dashboard.tsx`（抽出中はカードを Skeleton 表示、完了で差し替え）
- Test: `useJobStatus.test.ts`（状態遷移）、`ScoreSkeleton.test.tsx`

**Acceptance:** 投入直後〜抽出完了まで Skeleton、完了で楽観的にカードへ差し替え。

---

### Task 20: 求人投入モーダル

**Files:**
- Create: `src/client/components/AddJobModal.tsx`（URL / HTML 貼り付けタブ）
- Modify: `TopBar.tsx`（投入ボタン → モーダル）
- Test: `AddJobModal.test.tsx`（バリデーション・送信 → `POST /api/jobs`）

**Acceptance:** トップバーからモーダルで URL/HTML 投入、送信で新規ジョブ作成し Skeleton 表示へ繋がる。

---

### Task 21: 設定 専用ビュー

**Files:**
- Create: `src/client/routes/Settings.tsx`, `src/client/components/CriteriaForm.tsx`（重み・希望値・ハードフィルタ ＋ benefitsCoverage 重視 signal ＋ 企業評判 対象サイト）
- Test: `CriteriaForm.test.tsx`（編集 → `PUT /api/config` → 即再ランキング・AI 非再実行）

**Acceptance:** 全画面ルートで多項目設定。保存で決定的に再スコア・即再ランキング（分離原則）。

---

# Wave 4 — 取得・運用

### Task 22: 取得戦略最適化（fetch 優先→SPA 検出→BR 必要時・backoff・chunk）

**Files:**
- Modify: `src/server/fetch/fetch-html.ts`（fetch 優先＋安価な SPA 検出）, `src/server/fetch/browser-render.ts`（必要時のみ BR）, `src/server/queue/rate-concurrency.ts`（backoff 再試行）
- Modify: `src/server/extract/content-extract.ts`（大ページ chunk 連携）
- Test: 各 `.test.ts`（SPA 検出分岐・BR フォールバック条件・backoff）

**Acceptance:** SSR は fetch のみで完結、SPA のみ BR、transient/504 はバックオフ再試行、大ページは chunk。robots/レート制御維持。コスト（BR 呼出）が必要最小。

---

### Task 23: live スモーク（deploy 後 binding/dynamic import/最小抽出）

**Files:**
- Create: `scripts/live-smoke.mjs`（deploy 後に `/api/health`・`/api/ai-health`・最小抽出・binding 解決・dynamic import を叩く）
- Modify: CI/デプロイ手順 docs（deploy 後にスモークを実行）
- Test: スモークドライバの自己検証（localhost は .mjs ドライバ経由で fetch）

**Acceptance:** runtime-only バグ（未バンドル import・compat date 既定等）を deploy 直後に検出できる。

---

# Wave 5 — 企業評判統合

### Task 24: 企業軸への評判合流（既存 #30–#43 と紐付け）

**Files:**
- Modify: `src/shared/categories.ts`（`company` 軸に評判サブスコアを合流）
- Modify: `src/server/scoring/score.ts`（companySize/capital ＋ 口コミ評判の加重合算。件数で信頼度重み、データなし中立）
- Modify: `src/client/components/ScoreRadar.tsx` / `BreakdownTable.tsx`（評判の出所・スコア明示、未設定時 中立）
- Test: 企業軸合算の `.test.ts`

**Acceptance:** 企業評判が独立せず企業軸へ合流（空軸を作らない）。`ANTHROPIC_API_KEY` 未設定時は評判を中立除外し他項目で成立。既存 Phase2 評判 issue（#30–#43）と本タスクを依存関係で紐付け。

---

## Self-Review（spec 突き合わせ）

- **#4 アーキ**: T2(API化)/T3(SPA足場)/T4(Tailwind+shadcn) でカバー。design-tokens 供給切替=T4。
- **#5 構造・テスト**: T1(レイヤ再編)/T5(Vitest 2プロジェクト)/co-located 維持。
- **#3 画面**: T15(シェル)/T16(カード)/T17(レーダー)/T18(ドロワー・フラット内訳・2アクション)/T19(Skeleton)/T20(投入モーダル)/T21(設定ビュー)。
- **#2 スコアリング**: T8(削減5軸)/T9(benefitsCoverage)/T10(overtime特例)/T11(remoteWork)/T12(skillMatch)。capital=T8、companyPhase 等削除=T8。
- **#1 抽出最適化**: T7(golden)/T13(モデル再評価)/T14(コンテンツ抽出)/T22(取得戦略)/T23(live スモーク)。
- **既存 Phase2 統合**: T24。lockfile hook=T6（retro 繰り越し）。
- **未確定ラベル**: Global Constraints に内部キー `integrity` 仮置きとして明記（プレースホルダでなく決定済み仮値）。
- 型整合: `CategoryKey`/`NormalizedKey`/`CATEGORY_OF`（T8 で定義）を T16/T17/T18/T24 が一貫消費。`runGolden`（T7）を T13/T14 が消費。API 契約（T2）を T15–T21 が消費。
