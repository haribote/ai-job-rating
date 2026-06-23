# AI Job Rating

求人情報のURLを投入するとAIで内容を抽出・スコアリングし、自分の希望条件に照らしてランキングするウェブアプリケーション。  
Cloudflare Workers 単体（Hono + 静的資産）で動くセルフホスト前提の OSS です。  

求人情報のURLは、単一の求人情報が掲載された詳細ページでも、複数の求人情報にリンクしている一覧ページでも、どちらでも投入可能です。  
抽出とスコアリングは分離されており、重みや希望条件を変えても AI の再実行なしに再ランキングされます。

## 必要なもの

- **Cloudflare アカウント（Workers 有料プラン）** 
  -  Browser Rendering（SPA 取得用）と Queues（複数ページの非同期取得）を使うため。
- **Node.js `>=20`** と **npm**。
- **wrangler** 
  - `npx wrangler ...` で実行できます。初回は `npx wrangler login` で認証します。

Workers AI / D1 / R2 / Queues / Browser Rendering の各バインディングは `wrangler.jsonc` に定義済みです。フォーク先で手編集が必要なのは **D1 の `database_id` 1 箇所のみ**です（後述）。

## ローカル開発

```sh
npm ci
# D1 マイグレーションをローカルストレージへ適用
npx wrangler d1 migrations apply ai-job-rating --local
npm run dev
```

`http://localhost:8787` で起動します。ローカル開発では miniflare が D1 / R2 / Queues / Browser を疑似提供するため、Cloudflare 上のリソース作成は不要です。

現在のバージョンでは**必須のシークレットはありません**（Workers AI はバインディング経由、認証下取得の Cookie は取り込み時に都度入力）。シークレットの雛形は `.dev.vars.example` を参照してください。

> `.npmrc` で `ignore-scripts=true`（サプライチェーン防御）を設定しているため、依存の postinstall は実行されません。本プロジェクトは postinstall に依存しません。

## 本番デプロイ（フォーク手順）

フォークした自分の Cloudflare 環境へデプロイする手順です。

### 1. 外部リソースを作成

```sh
# D1（構造化データ）
npx wrangler d1 create ai-job-rating
# R2（生 HTML 保存）
npx wrangler r2 bucket create ai-job-rating-raw-html
# Queues（複数ページの非同期取得 + DLQ）
npx wrangler queues create ai-job-rating-details
npx wrangler queues create ai-job-rating-details-dlq
```

### 2. `database_id` を差し替え

`wrangler d1 create` が出力した `database_id` を `wrangler.jsonc` の D1 設定（placeholder `00000000-0000-0000-0000-000000000000`）に置き換えてください。

### 3. リモート D1 へマイグレーション適用

```sh
npx wrangler d1 migrations apply ai-job-rating --remote
```

`jobs` / `extractions` / `criteria_config` / `scores` の 4 テーブルが作成されます。

### 4. デプロイ

```sh
npm run deploy
```

### 5. Cloudflare ダッシュボードでの有効化

**Workers AI** と **Browser Rendering** はアカウント側で有効化が必要な場合があります。

## 使い方

| 動線 | 内容 |
|---|---|
| `GET/POST /fetch` | 求人URLを投入。詳細URLは即取り込み、一覧URLはそこからリンクしている詳細URLを抽出してキューに投入して非同期取り込み。 |
| `GET/POST /paste` | 取得できない場合のフォールバック。求人ページの HTML を貼り付けて取り込み。 |
| `GET /ranking` | 取り込んだ求人をスコア順に一覧表示（項目別内訳つき）。 |
| `GET/POST /config` | 重み・希望条件・ハードフィルタを設定。保存すると AI を再実行せず即再ランキング。 |
| `GET /health` / `GET /ai-health` | 死活確認 / Workers AI 疎通確認。 |

基本フロー: **取り込み（`/fetch` or `/paste`）→ `/ranking` で確認 → `/config` で条件調整（即再ランキング）**。

## トラブルシューティング

- **抽出に失敗する** — 取得元が SPA / 認証下などで本文を取れないケース。`/paste` から HTML を直接貼り付けてください。抽出失敗は専用画面に誘導され、`unknown 中立`（値が取れない項目）とは区別して記録されます。
- **`no such table` 等の D1 エラー** — マイグレーション未適用。ローカルは `--local`、本番は `--remote` で `d1 migrations apply` を実行してください。
- **Queues / Browser Rendering が動かない** — どちらも Workers 有料プランが必要です。

## 開発

```sh
npm test                 # ユニットテスト (Vitest)
npm run typecheck        # 型チェック
npm run lint             # Biome
npm run build:css:check  # design-tokens と public/styles.css の同期確認
npm run e2e              # Playwright E2E
```

あわせて [`CLAUDE.md`](CLAUDE.md) も参照してください。

## Documentation

- [要件定義書](./docs/requirements.md) — 背景・スコープ・機能/非機能要件・スコアリング設計・データモデル・AIモデル方針・アーキテクチャ
- [開発ロードマップ](./docs/roadmap.md) — PoC / MVP / 将来拡張のフェーズ計画

## License

[MIT](./LICENSE)
