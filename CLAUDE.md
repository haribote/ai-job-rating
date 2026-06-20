# ai-job-rating — プロジェクト指示

求人情報を AI で構造化抽出・スコアリングし、希望条件で順位付けするセルフホスト前提の OSS。

## 仕様書・設計書

一次ソース。本ファイルには重複させず節番号でポインタする。

- [docs/requirements.md](./docs/requirements.md) — 要件定義
- [docs/roadmap.md](./docs/roadmap.md) — Phase 0(PoC) / 1(MVP) / 2 の計画

AI モデル ID・価格・API 仕様は記憶で答えず一次ソース（公式 docs 等）で確認する。

## 技術スタック

- **Cloudflare Workers 単体**（Hono + 静的資産, §9）。**TypeScript** / **npm** / **wrangler** / **Biome** / **Vitest**。
- **Workers AI**（JSON Mode 構造化抽出, §7.1）。
- ストレージ: **D1**（構造化）/ **R2**（生 HTML 等）/ **KV**（軽量設定・キャッシュ）。§6。
- Phase 2 のみ **Claude API**（企業評判の `web_search`, §7.2）。

## 現在のフェーズ

**Phase 0（PoC）**。公開 SSR ページの単一詳細 URL、固定設定スコアリング、永続化なし。進行したら更新する。

## 設計の最重要原則（ガードレール）

- **抽出とスコアリングの分離**（§5.3）。AI 抽出は求人 1 件 1 回・結果を保存して再利用。**重み・希望値の変更で AI を再実行しない。**
- **スコアリングは決定的**。同一入力・同一設定なら同一スコア。ユニットテストで担保（§8）。
- **フォーク容易性**。アカウント固有値・秘匿情報をコードに直書きしない。`wrangler.jsonc` / 環境変数 / `.dev.vars` 経由（§8）。
- **unknown は中立**。値が取れない項目は加重合計の分母から外す（§5.2）。
- **ラベル正規化**。抽出時に正規スキーマのキーへ寄せ、スコアリングは正規キーのみ参照（§5.2）。

## 開発手法

- **t-wada メソッドの TDD**（Red → Green → Refactor）。決定的ロジックはユニットテスト必須（§8）。
- 取得 / 抽出 / スコアリング / 保存 / UI を責務分離し各層を単体テスト可能にする（§9）。
- 独立した実装タスクは git worktree で並列化する（`.claude/settings.json` の `worktree`、`node_modules` は symlink 共有）。worktree で `wrangler dev` する場合は `.dev.vars` を手動配置（hook により Claude は触れない）。

## 秘匿情報

- **Claude による秘匿ファイル（`.dev.vars` / `.env` 等）の読み書きは禁止。** `.claude/settings.json` の PreToolUse hook（`.claude/hooks/block-secret-access.sh`）が Read/Edit/Write/Bash 経由のアクセスを deny する。`.dev.vars.example` 等の雛形は許可。
- `ANTHROPIC_API_KEY` 等・Cookie/セッションはコミット禁止。実値は `.dev.vars`（ローカル）/ wrangler secrets（本番）、雛形は `.dev.vars.example`（§8）。
- **gitleaks で漏洩検出**。pre-commit（`.githooks/pre-commit`。有効化: `git config core.hooksPath .githooks`）と CI（`.github/workflows/gitleaks.yml`）で scan。設定は `.gitleaks.toml`（`*.example` は allowlist）。
