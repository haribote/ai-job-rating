import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "./app";

// Hono アプリの最小ルートを検証する（責務分離: app をテスト対象に切り出す）
describe("app", () => {
	// ヘルスチェックは死活監視の契約なので固定形式を担保する
	it("GET /health は 200 と ok ステータスを返す", async () => {
		const res = await app.request("/health", {}, env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});

	// 静的資産配信のフォールスルー（未定義ルートは assets へ委譲）を確認する
	it("ルート / は静的資産の index.html を返す", async () => {
		const res = await app.request("/", {}, env);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("ai-job-rating");
	});
});
