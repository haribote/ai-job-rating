import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../app";

// GET /api/reputation/config の JSON 契約（#31）。
// presence のみを返し、キー値そのものは絶対に漏らさないことを担保する。
describe("GET /api/reputation/config", () => {
	it("キー未設定なら 200 と apiKeyConfigured=false", async () => {
		const res = await app.request(
			"/api/reputation/config",
			{},
			{ ...env, ANTHROPIC_API_KEY: undefined },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		await expect(res.json()).resolves.toEqual({ apiKeyConfigured: false });
	});

	it("キー設定済みなら apiKeyConfigured=true で、応答にキー値を含めない", async () => {
		const secret = "sk-ant-route-secret";
		const res = await app.request(
			"/api/reputation/config",
			{},
			{ ...env, ANTHROPIC_API_KEY: secret },
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(JSON.parse(text)).toEqual({ apiKeyConfigured: true });
	});
});
