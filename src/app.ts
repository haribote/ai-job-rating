import { Hono } from "hono";
import { pasteInput } from "./paste-input";

// Worker の env バインディング型。後続フェーズ（Workers AI / D1 / R2 / KV）でここに追記する
export interface Bindings {
	// 静的資産フォールスルー用バインディング（wrangler.jsonc の assets.binding と一致）
	ASSETS: Fetcher;
}

// アプリ本体を index.ts から切り出し、Hono の app.request() で単体テスト可能にする（責務分離）
const app = new Hono<{ Bindings: Bindings }>();

// 死活監視の契約。固定形式を返し、ユニットテストで担保する
app.get("/health", (c) => c.json({ status: "ok" }));

// HTML 貼り付けフォールバックの入力受け口（GET /paste・POST /paste）。
// 静的資産フォールスルー（app.get("*")）より前に評価させる。
app.route("/", pasteInput);

// SSR ルートに該当しない GET は静的資産へフォールスルーする
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
