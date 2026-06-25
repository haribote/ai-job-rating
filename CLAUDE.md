# ai-job-rating — プロジェクト指示

求人情報を AI で構造化抽出・スコアリングし、希望条件で順位付けするセルフホスト前提の OSS。

## 仕様書・設計書

一次ソース。本ファイルには重複させず節番号でポインタする。

- [docs/requirements.md](./docs/requirements.md) — 要件定義
- [docs/roadmap.md](./docs/roadmap.md) — Phase 0(PoC) / 1(MVP) / 2 の計画

AI モデル ID・価格・API 仕様は記憶で答えず一次ソース（公式 docs 等）で確認する。

## 技術スタック

- **Cloudflare Workers 単体**（Hono + 静的資産, §9）
  - **TypeScript** / **npm** / **wrangler** / **Biome** / **Vitest**
- **Workers AI**（構造化抽出。JSON Mode に固定せず機構はアダプタ化し、使用モデル・機構は性能評価で決定, §7.1）
- ストレージ（§6）
  - **D1**（構造化）/ **R2**（生 HTML 等）/ **KV**（軽量設定・キャッシュ）
- **Claude API**（企業評判の `web_search`, §7.2, Phase 2 以降）

## 現在のフェーズ

**Phase 1（MVP）— 完了・トラッキング Issue #70 クローズ済み**。DoD 全項目達成、sub-issue 17 件と保留 PR（#72/#75/#78）全て merge、Phase 1 マイルストーンの open issue は 0。D1/R2 永続化・スコア順ランキング・設定UI（重み変更で即再ランキング・AI非再実行）・一覧/SPA/認証取得・フォーク用整備（#29）を実装済みで live 検証済。抽出機構の方針と既定モデルも確定（#65/#72: 差し替え可能アダプタ + コード側 検証/修復/正規化、既定 = `@cf/meta/llama-3.3-70b-instruct-fp8-fast` / json_mode）。Post-DoD の #88（モデル非依存の構造的抽出エラー是正）も完了（#90: companyPhase/holidaySystem を決定的に canonical 化し live 実証。businessDomain 等の開集合キーは canonical 化せずプロンプト依存で非ブロック残課題）。次フェーズは Phase 2（企業評判・将来拡張, #30–#43）。進行したら更新する。

## 設計の最重要原則（ガードレール）

- **抽出とスコアリングの分離**（§5.3）
  - AI 抽出は求人 1 件 1 回・結果を保存して再利用。**重み・希望値の変更で AI を再実行しない。**
- **スコアリングは決定的**
  - 同一入力・同一設定なら同一スコア。ユニットテストで担保（§8）。
- **フォーク容易性**
  - アカウント固有値・秘匿情報をコードに直書きしない。`wrangler.jsonc` / 環境変数 / `.dev.vars` 経由（§8）。
- **unknown は中立**
  - 値が取れない項目は加重合計の分母から外す（§5.2）。
- **ラベル正規化**
  - 抽出時に正規スキーマのキーへ寄せ、スコアリングは正規キーのみ参照（§5.2）。

## 開発手法

- **t-wada メソッドの TDD**（Red → Green → Refactor）。決定的ロジックはユニットテスト必須（§8）。
- 取得 / 抽出 / スコアリング / 保存 / UI を責務分離し各層を単体テスト可能にする（§9）。
- **コメント・テストコード名は日本語で簡潔に**。「何を」より「なぜ」を書く。局所コメントより関数・型・変数などエンティティ単位にまとめ、複数行に及ぶ説明は `docs/` に切り出す。
- 独立した実装タスクは git worktree で並列化する（`.claude/settings.json` の `worktree`、`node_modules` は symlink 共有）。worktree で `wrangler dev` する場合は `.dev.vars` を手動配置（hook により Claude は触れない）。

## セキュリティ

- **秘匿ファイル（`.dev.vars` / `.env` 等）は Claude が読み書き禁止**。PreToolUse hook（`.claude/hooks/block-secret-access.sh`）が deny する。`*.example` 雛形は許可。
- 秘匿情報（`ANTHROPIC_API_KEY`・Cookie/セッション）はコミット禁止。実値は `.dev.vars` / wrangler secrets、雛形は `.dev.vars.example`（§8）。
- 漏洩検出は gitleaks（`.gitleaks.toml`）。pre-commit（`.githooks/pre-commit`、`core.hooksPath` で有効化）と CI で scan。
- npm サプライチェーン攻撃対策は `.npmrc`（`ignore-scripts` / `save-exact` / `min-release-age=7` / `engine-strict`）、Dependabot（cooldown 7日）、GitHub Actions の commit SHA 固定。依存導入後は CI に `npm ci` + `npm audit` を追加する。
