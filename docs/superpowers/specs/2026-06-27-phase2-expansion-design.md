# Phase 2 拡張 設計書 — UI刷新・スコアリング再設計・抽出最適化・構造再編

求人比較ツールを「日常運用に耐える実用品質」へ底上げするため、Phase 2 に5領域の要件を追加・統合する設計書。

- ステータス: ドラフト（v0.1・ブレインストーミング合意済み）
- 作成日: 2026-06-27
- 関連: [requirements.md](../../requirements.md) / [roadmap.md](../../roadmap.md)
- 位置づけ: **既存 Phase 2（企業評判 F-8 / #30–#43）を拡張・統合**する。新規 Phase は作らない。

---

## 1. 背景・目的

Phase 1（MVP）完了時点の UI は Hono SSR の MPA（クライアント JS なし・各操作が独立ページ）で、`design-tokens.ts` → `styles.css` のビルド方式。日常的な求人比較には操作性・情報密度が不足する。あわせて Phase 0/1 retro で「抽出品質が後追いハードニングになった」「runtime-only バグが live でのみ露見」等が確認され、スコアリング項目も実運用視点で過剰・冗長な部分がある。

本拡張の目的は次の5点を一体で解決すること。

1. **#3 画面構成・遷移フローの再設計** — ダッシュボード単一ハブへ
2. **#4 UI 刷新** — React + shadcn/ui + Tailwind の導入
3. **#2 スコアリング対象項目の見直し** — 21項目→約10項目・5軸へ削減し、「企業の労働者への誠実さ」を新軸化
4. **#1 スクレイピング/抽出の最適化** — 精度・速度・コスト・成功率を golden ゲート基盤で底上げ
5. **#5 src 構造・テスト配置の再編** — クライアント層追加に耐える責務分離

設計の最重要原則（抽出↔スコアリング分離／決定的スコアリング／unknown 中立／ラベル正規化／フォーク容易性）は全領域で維持する。

---

## 2. スコープ

### スコープ内
- React SPA ＋ Hono `/api/*` への再編（Cloudflare Workers 単体は維持）
- ダッシュボード中心の画面構成・遷移と shadcn/ui ベースの UI 実装
- スコアリング項目の削減・再カテゴリ化（5軸）と新項目 `benefitsCoverage` / `capital` / 統合 `skillMatch`
- 抽出パイプライン最適化（golden ゲート・モデル再評価・コンテンツ抽出改善・取得戦略・live スモーク）
- `src/` のレイヤ別再編とテスト構成更新
- 既存 Phase 2 企業評判（#30–#43）の本構成への統合

### スコープ外（現時点）
- マルチユーザー化・認可（要件 §3 のまま）
- 自動巡回クローリング・求人サイト公式 API 連携
- 応募管理・進捗トラッキング・通知
- Vision モデルによるスクリーンショット抽出（将来検討のまま）

---

## 3. アーキテクチャ（#4 / #5）

### 3.1 全体構成
- **React SPA（Vite ビルド）を静的資産として配信 ＋ Hono を JSON API バックエンド**。Cloudflare Workers 単体・単一 deploy を維持する。
- 既存の Hono SSR ページ（`/fetch`・`/paste`・`/config`・`/ranking`・result）は **`/api/*` の JSON エンドポイント**へ再編する。HTML を返す経路は廃止し、UI は SPA が担う。
- ビルド成果物（SPA バンドル）は `public/` 配下に出力し、Workers の `assets` binding でフォールスルー配信する。SPA ルーティングのため未知パスは `index.html` を返す（API パスは除外）。
- 取得・抽出・スコアリング・保存は**サーバー側に据え置く**。決定的スコアリングと再現性（§8 再現性）は不変。

### 3.2 UI スタック
- **shadcn/ui + Tailwind CSS + lucide-react（アイコン）+ Recharts（shadcn Chart 経由・レーダーチャート）**。
- 絵文字は使用しない。アイコンは lucide に統一する。
- 文字色・文字サイズは **shadcn/ui のデフォルト**（Tailwind タイプスケール、shadcn テーマ CSS 変数 `--foreground`/`--muted-foreground`/`--primary`/`--border` 等）を標準とする。
- **デザイントークンの単一ソースは維持**する。`design-tokens.ts` は **Tailwind theme / shadcn CSS 変数へ供給**する形へ寄せ、ビルド先を `styles.css` 直生成から Tailwind/shadcn テーマへ移す。Claude Design は管理・参照に用い実行時依存にしない（要件 §11）。

### 3.3 依存とサプライチェーン
- 追加依存（react / react-dom / vite / @vitejs/plugin-react / tailwindcss / shadcn 一式 / recharts / lucide-react）は CLAUDE.md のサプライチェーン方針に従う（`.npmrc` の `ignore-scripts`/`save-exact`/`min-release-age=7`、Dependabot cooldown、GitHub Actions の SHA 固定、導入後 `npm ci` + `npm audit`）。
- lockfile の tab インデント → 2-space 正規化を **pre-commit hook 化**する（Phase 1 retro 繰り越し・#74 で再発した既知の罠）。

### 3.4 src 構造・テスト
レイヤ別に再編する。

```
src/
  server/              # Workers/Hono（決定的ロジックを集約）
    index.ts           # worker entry（fetch + queue handler, DI 配線）
    app.ts             # Hono /api/* ルーティング
    fetch/             # fetch-html, fetch-authed-html, browser-render, list-detail
    extract/           # extract, ai, trim-html, content-extract(新), golden(新)
    scoring/           # score, ranking, criteria-config, rescore*, skill-matcher
    storage/           # db-schema, raw-html-store, ingest
    queue/             # detail-queue, rate-concurrency
  client/              # React SPA（Vite）
    main.tsx, App.tsx
    components/         # shadcn/ui ＋ アプリ部品（RankingCard, JobDetailSheet, ScoreRadar …）
    lib/               # api クライアント・hooks
  shared/              # client/server 共有
    job-schema.ts      # NormalizedKey・正規スキーマ（抽出と表示の単一ソース）
    design-tokens.ts   # → Tailwind theme / shadcn CSS 変数へ供給
```

- **テストは co-located 継続**（`x.ts` ↔ `x.test.ts` / `Component.tsx` ↔ `Component.test.tsx`）。
- Vitest は **2プロジェクト構成**にする: server = `@cloudflare/vitest-pool-workers`（workerd ランタイム）、client = `jsdom`/`happy-dom`（@testing-library/react）。Playwright e2e は据え置き。
- フラット29ファイルの移動は churn が大きいため、**client 層追加より前に**レイヤ再編を完了させる。

---

## 4. 画面構成・遷移フロー（#3）

### 4.1 中心概念
**ランキング・ダッシュボード単一ハブ**。アプリを開くと常にランキング。投入・設定・求人詳細はその場でドロワー/モーダル/専用ビューとして開き、1画面に滞在し続ける。

### 4.2 シェル
- **トップバー ＋ 右ドロワー(Sheet)**。トップバーに「求人投入」「設定」。行/カードクリックで詳細が右からスライドする。

### 4.3 ランキング（メイン）
- **カード型**。**ベスト3を強調**: lucide の trophy（1位）/ medal（2・3位）アイコン ＋ 金/銀/銅の**枠色**で区別する。
- **スコア数値・チャート文字色は順位非依存で統一**する（順位は枠色＋アイコンのみで表現）。レーダーの塗りも単一アクセントで統一する。
- 各カードに**5軸レーダーチャート**（後述 §5 のカテゴリ）と総合スコアを表示する。
- **抽出中は Skeleton** で代替表示し、取得→抽出完了で楽観的にカードへ差し替える（ポーリングまたは更新）。
- unknown（情報なし）はレーダー軸を中立表示し、過度に減点しない（要件 §5.2）。

### 4.4 詳細ドロワー（Sheet）
- ヘッダ: 会社/職種・元ページリンク・状態・使用モデル・総合スコア。
- サマリ: 大きめレーダー ＋ カテゴリ別スコア一覧。
- **項目別内訳はフラットな1枚の表**（カテゴリ別アコーディオンにはしない）。各行に「項目／抽出値／希望値／サブスコア／重み」。unknown は「中立」と明示、ハードフィルタはバッジ表示。表示項目は §5 の採点項目に絞り複雑化を避ける。
- **アクションは2つ**: 「再抽出」「評判取得」。評判取得は前提（`ANTHROPIC_API_KEY` 等）が未設定の場合、実行ボタンの代わりに**設定への案内文**を表示する。

### 4.5 投入・設定
- 求人投入（URL / HTML 貼り付け）はトップバーから**モーダル**で開く。
- 設定（重み・希望値・ハードフィルタ ＋ benefitsCoverage の重視 signal ＋ 企業評判の対象サイト）は項目数が多いため**専用ビュー（全画面ルート）**で提供する（モーダルにしない）。

---

## 5. スコアリング項目の見直し（#2）

方針: **抽出スキーマも削減**し、表示・採点の複雑化を防ぐ。21の正規キーを約10項目・5軸へ再編する。要件 §5.1 の「取れるだけ取って保存」と整合させ、抽出は厚く・表示/採点は絞る。

### 5.1 5軸カテゴリと採点項目

| 軸（カテゴリ） | 採点項目 | 算出方式 |
| --- | --- | --- |
| **報酬** | `annualSalary`, `bonus` | numericRange（高いほど良） |
| **従業員への誠実さ**（既定ラベル。候補: 働きやすさ／待遇の手厚さ） | `overtime`(定量), `annualHolidays`, `benefitsCoverage` | numericRange ＋ 充足率 |
| **柔軟な働き方** | `remoteWork`(full別格), `flexWork` | categorical |
| **仕事・スキル** | `skillMatch` | キーワード一致（決定的） |
| **企業** | `companySize`, `capital`〔＋Phase2 口コミ評判〕 | numericRange ／ categorical |

- レーダーは5軸。各軸スコアは軸内項目の正規化加重平均（unknown は分母から除外＝中立、要件 §5.2）。
- 企業評判（Phase 2 F-8）は**「企業」軸に合流**させ、空軸を作らない。`overall_score`/`review_count` は企業単位でキャッシュし、データなし・低信頼は中立/低信頼フラグ（要件 §7.2）。

### 5.2 個別項目の仕様

- **overtime（定量化）**: 「有無」ではなく定量で採点する。優先順位 ①平均残業時間 → ②見込み（みなし）残業時間。`numericRange`・少ないほど良。
  - **特例（unknown 中立の意図的例外）**: 「残業有り」と明記されているのに定量値が抽出できない場合は、中立にせず**減点**する（時間が読めない＝リスク）。一方、残業に関する記載が**一切ない**場合は従来通り中立とする。この2分岐を `score.ts` と抽出側で明示的に区別する。
- **remoteWork（細分化）**: canonical を `full` / `partial` / `onsite` とし、**フルリモートを別格に加点**する（`partial`/`onsite` と明確に差別化）。
- **benefitsCoverage（新規・充足率）**: 労働者にメリットのある制度・待遇の **canonical 閉集合**に対する**充足率** `該当 signal 数 / canonical 総数`（0–100、決定的）で採点する。任意でユーザーが重視する signal に重みを付けられる。
  - canonical 閉集合の初期セット（フォーク先で増減可）:
    - **休日制度**: 完全週休2日制 / 週休2日制 / 4週8休 等（`holidaySystem` を signal として吸収。完全週休2日制を高評価）
    - **休暇制度の数・充実度**: 有給休暇 / 慶弔休暇 / 夏季・年末年始休暇 / リフレッシュ・長期休暇 / 育児・介護休暇 / 特別休暇 / 看護休暇 等
    - **その他福利厚生**: 退職金制度（`retirementAllowance` を吸収）/ 各種手当（住宅・家族・通勤・役職）/ 研修・資格取得支援 / 健康・メンタルケア（人間ドック等）/ 持株会・ストックオプション / 副業可 / 社会保険完備 / 産休育休取得実績 / 時短勤務 / 社宅・寮 等
  - **抽出は厚く・表示は1スコア**: 抽出は各 signal の boolean 集合を返し保存する。詳細ドロワーのフラット表では「福利厚生 充足度 NN%」の1行＋展開で内訳を見せる。
  - 「多いほど高得点」は記載過多なページを過大評価しうるため、**canonical 閉集合に限定**（認識した signal のみ計上）して軽減する。
- **skillMatch（統合）**: `techStack` ＋ `requiredSkillsMatch` ＋ `preferredSkillsMatch` を単一項目へ統合する。抽出時に三者は混ざりやすいため、**ユーザー設定キーワードへのヒット可否で決定的に採点**する（skill-matcher 方式・#68 と整合）。aiJudged kind は廃止する。必須/歓迎の区別はしない。

### 5.3 削除する項目
- `monthlySalary` — 採点からは外す。抽出時に年収補完の材料としてのみ用いる。
- `salaryRaise`（昇給有無）— ほぼ「あり」で差別化に乏しい。
- `paidLeaveRate`（有給取得率）— 記載が少なく欠損が多い。
- `holidaySystem` 単独項目 / `retirementAllowance` 単独項目 — `benefitsCoverage` の signal として吸収（概念は廃止せず移設）。
- 勤務条件カテゴリ全削除: `workLocation` / `employmentType` / `employmentTerm`。
- `businessDomain` — 開集合で正規化困難（非ブロック残課題）。`skillMatch` キーワードで代替可。
- `languageRequirement` — 多くが「日本語のみ」で差別化に乏しい。
- `companyPhase`（上場区分）— 削除。

### 5.4 §5.2.1（構造的に誤りやすい categorical）への影響
- `companyPhase` / `holidaySystem`（独立キー）/ `workLocation` / `businessDomain` は採点項目から外れるため、requirements §5.2.1 の canonical 定義を本拡張に合わせて更新する（`holidaySystem` の canonical は benefitsCoverage の休日制度 signal の判定規則へ移管、`remoteWork` の `full`/`partial`/`onsite` を新たに canonical 定義に追加）。

---

## 6. スクレイピング/抽出の最適化（#1）

benefitsCoverage（signal 集合）・overtime 定量・remoteWork 細分化により抽出への要求が上がる。狙いは精度・速度/タイムアウト・コスト・成功率の同時改善。一体の抽出パイプライン改善として扱う。

1. **golden-sample 抽出品質ゲート（基盤・最優先）**
   - 実求人の golden セット ＋ フィールド単位の期待値で抽出精度を spike/CI で計測する。モデル/プロンプト変更を安全に回す土台（後追いハードニング再発防止・Phase 1 retro 繰り越し）。
   - **PII を含むため golden サンプル実体は gitignore またはサニタイズ必須**（Phase 0 で実サンプルが PII を含むと確認済み・既存 `/spike/` gitignore と同方針）。
2. **抽出モデル/機構の再評価 → 既定更新**
   - 既定 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` の弱点（遅さ・504・context 24k）を根本解決する。アダプタ機構（要件 §7.1）を活かし、より広 context・高速・function calling 対応の Workers AI 新モデルを **golden ゲートで横並び評価**して既定を更新する。**モデル ID・価格・仕様は記憶で答えず一次ソースで確認**する。
3. **コンテンツ抽出の改善（取得→抽出の間）**
   - 単純 `trimHtml` でなく、本文＋**福利厚生/休暇セクションを保持**する構造的抽出にする（benefitsCoverage に必要な箇所を落とさず、かつトークン削減）。重い項目（benefits 集合）は必要に応じ**分割パス**で抽出し 504/context を回避する。
4. **取得戦略の最適化**
   - `fetch` 優先 → 安価な SPA 検出 → **必要時のみ Browser Rendering**（コスト・成功率の両立）。transient/504 はバックオフ再試行、大ページは chunk。robots/レート制御は要件 §8 を維持。
5. **live スモーク（runtime-only バグ検出）**
   - deploy 後に binding 解決・dynamic import・最小抽出を自動チェックする（Phase 1 retro 繰り越し。変数 import 未バンドル・positional entry の compat date 等の「オフライン素通り・live でのみ露見」クラスを検出）。

---

## 7. データモデルへの影響

- **extractions**: 構造化 JSON のスキーマを §5 に合わせて更新（削除キーの除去、`benefitsCoverage` 用の signal boolean 集合、`overtime` 定量値＋「有り明記だが定量なし」フラグ、`remoteWork` の `full`/`partial`/`onsite`、`capital` の追加）。`model` は再評価後の既定へ。
- **criteria_config**: 採点項目の削減に合わせて既定 seed を更新。`skillMatch` は aiJudged から keyword 方式（`desired_value` に `{ "keywords": [...] }`）へ。`benefitsCoverage` の重視 signal を `desired_value` で保持可能に。
- **scores**: 5軸カテゴリのサブスコア集計に対応（カテゴリ→項目の対応表は `shared/` の単一ソースで保持）。
- **companies / reputation_snapshots / reputation_sources**（既存 Phase 2）: 変更なし。企業軸へ合流。
- 既存データのマイグレーション: 削除キーは無視（unknown 中立で自然に分母から外れる）。再採点は決定的に走る。スキーマ変更で再抽出が要る項目（benefits 等）は再抽出導線（ドロワーの「再抽出」）でカバー。

---

## 8. 実装シーケンス（依存順）

Phase 2 内の Wave として依存トポロジで進める。

1. **基盤**: src レイヤ再編（#5）→ React/Hono API スキャフォルド（#4）→ Tailwind/shadcn 導入・design-tokens 供給切替。
2. **抽出/スコア**: golden ゲート構築（#1-1）→ スコアリング項目再編（#2: スキーマ・criteria・score・skill-matcher・benefitsCoverage・overtime 特例）→ モデル再評価/既定更新（#1-2）→ コンテンツ抽出改善（#1-3）。
3. **UI 構築**: ダッシュボード・カード（ベスト3強調・レーダー）・詳細ドロワー（フラット内訳）・設定ビュー・投入モーダル・Skeleton（#3）。
4. **取得最適化・live スモーク**: 取得戦略（#1-4）・live スモーク（#1-5）。
5. **企業評判統合**: 既存 #30–#43 を企業軸へ。

各 Wave は wave-rider オーケストレーション（worktree 分離・人間ゲート merge）で回せる。実装計画は本設計書を入力に writing-plans で別途作成する。

---

## 9. テスト方針

- 決定的ロジック（スコアリング・正規化・benefitsCoverage 充足率・overtime 特例・skillMatch）は **t-wada メソッドの TDD でユニットテスト必須**（要件 §8）。同一入力・同一設定→同一スコアを担保。
- golden ゲートで抽出の構造的精度を回帰検知（モデル/プロンプト変更時）。
- client は @testing-library/react で主要コンポーネント（RankingCard・JobDetailSheet・ScoreRadar）をテスト。Playwright e2e で主要フロー（投入→ランキング→詳細→重み変更→即再ランキング）を回帰。
- live スモークで runtime-only バグを deploy 導線で検出。

---

## 10. リスクと対応

| リスク | 内容 | 対応 |
| --- | --- | --- |
| フォーク容易性の低下 | React/Vite/Tailwind 導入でビルド・依存が増える | 単一 deploy・`npm run build` ＋ commit 済み設定で吸収。サプライチェーン方針（§3.3）遵守 |
| benefits 抽出の困難さ | signal 集合を日本語求人から安定抽出しにくい | golden ゲートで精度計測、canonical 閉集合、分割パス、再抽出導線 |
| 「多いほど高得点」のゲーム性 | 記載過多なページの過大評価 | canonical 閉集合に限定し認識 signal のみ計上 |
| unknown 中立原則の例外（overtime） | 「有り明記だが定量なし」を減点する例外 | §5.2 の意図的例外として明文化、テストで境界を固定 |
| 大規模 churn | フラット29ファイル移動＋API 再編 | client 追加前にレイヤ再編を完了、段階 PR、回帰テスト |
| モデル変更の劣化 | 既定モデル更新で精度低下 | golden ゲート合格を必須条件に。アダプタで差し戻し可能 |

---

## 11. 未確定・フォローアップ（既定あり・要レビュー）

- **「従業員への誠実さ」軸の表示ラベル**: 既定は「従業員への誠実さ」。候補「働きやすさ」「待遇の手厚さ」。スペックレビューで確定。
- **benefitsCoverage の canonical 初期セット**: §5.2 の初期リストを採用。実装時に golden サンプルで取りやすさを見て微調整。
- **チャートライブラリ**: shadcn Chart（Recharts ベース）を既定。レーダー実装の都合で別ライブラリが要れば実装計画で再検討。
