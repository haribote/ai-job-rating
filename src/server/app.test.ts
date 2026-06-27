import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "./app";

// Hono アプリの最小ルートを検証する（責務分離: app をテスト対象に切り出す）。
// 詳細な API 契約は api.test.ts で固定し、ここでは health とフォールスルーのみ確認する。
describe("app", () => {
	// ヘルスチェックは死活監視の契約なので固定形式を担保する。
	it("GET /api/health は 200 と ok ステータスを返す", async () => {
		const res = await app.request("/api/health", {}, env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});

	// 静的資産配信のフォールスルー（API 外の GET は assets へ委譲＝SPA シェル）を確認する。
	it("ルート / は静的資産の index.html を返す", async () => {
		const res = await app.request("/", {}, env);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("ai-job-rating");
	});
});
