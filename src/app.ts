import { Hono } from "hono";
import { runAiHealthCheck } from "./ai";
import { criteriaForm } from "./criteria-form";
import { pasteInput } from "./paste-input";
import { urlInput } from "./url-input";

// Worker の env バインディング型。後続フェーズ（D1 / R2 / KV）でここに追記する
export interface Bindings {
	// 静的資産フォールスルー用バインディング（wrangler.jsonc の assets.binding と一致）
	ASSETS: Fetcher;
	// Workers AI バインディング（wrangler.jsonc の ai.binding と一致, §7.1）。型は wrangler types 生成の Ai
	AI: Ai;
	// D1 バインディング（wrangler.jsonc の d1_databases.binding と一致, §6）。構造化データの永続化に使う
	DB: D1Database;
	// R2 バインディング（wrangler.jsonc の r2_buckets.binding と一致, §6）。生 HTML 等の保存に使う（#17）
	RAW_HTML: R2Bucket;
}

// アプリ本体を index.ts から切り出し、Hono の app.request() で単体テスト可能にする（責務分離）
const app = new Hono<{ Bindings: Bindings }>();

// 死活監視の契約。固定形式を返し、ユニットテストで担保する
app.get("/health", (c) => c.json({ status: "ok" }));

// Workers AI binding の疎通確認（§7.1）。最小推論を投げて到達性を返す。
// 整形・分岐は runAiHealthCheck に集約し fake でテストする。live 推論は手動検証。
app.get("/ai-health", async (c) => {
	const result = await runAiHealthCheck(c.env.AI);
	return c.json(result, result.ok ? 200 : 503);
});

// 求人 URL 入力の受け口（GET /fetch・POST /fetch）。SSR 取得の主経路（roadmap Phase 0）。
// HTML 貼り付けフォールバックの入力受け口（GET /paste・POST /paste）。
// 評価条件の設定 UI の受け口（GET /config・POST /config）。保存で即再ランキング（#19→#20）。
// いずれも静的資産フォールスルー（app.get("*")）より前に評価させる。
app.route("/", urlInput);
app.route("/", pasteInput);
app.route("/", criteriaForm);

// SSR ルートに該当しない GET は静的資産へフォールスルーする
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
