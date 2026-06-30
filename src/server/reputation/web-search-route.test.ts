import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../app";

// POST /api/companies/:id/reputation の JSON 契約（#30）。
// 実 web_search（Claude API 呼び出し）を伴う成功経路は live 検証（#116）へ委譲し、
// ここでは API を叩かない gated 分岐（キー未設定・企業未存在）のみを決定的に検証する。
beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM companies");
});

describe("POST /api/companies/:id/reputation", () => {
	it("APIキー未設定なら 200 で中立 skip を返す（評判を取得しない）", async () => {
		const res = await app.request(
			"/api/companies/co-1/reputation",
			{ method: "POST" },
			{ ...env, ANTHROPIC_API_KEY: undefined },
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			status: "skipped",
			reason: "api-key-not-configured",
		});
	});

	it("APIキー設定済みでも企業が存在しなければ 404", async () => {
		const res = await app.request(
			"/api/companies/missing/reputation",
			{ method: "POST" },
			{ ...env, ANTHROPIC_API_KEY: "sk-ant-test" },
		);
		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "company not found" });
	});
});
