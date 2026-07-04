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
	await env.DB.exec("DELETE FROM extractions");
	await env.DB.exec("DELETE FROM jobs");
	await env.DB.exec("DELETE FROM companies");
});

async function seedJobWithExtraction(
	jobId: string,
	companyName: string | null,
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, status, fetched_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(jobId, `https://example.com/${jobId}`, "detail", "scored", 1000)
		.run();
	await env.DB.prepare(
		`INSERT INTO extractions
		 (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at, company_name, job_title)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`ext-${jobId}`,
			jobId,
			"{}",
			"gpt-oss-20b",
			"json_mode",
			"ok",
			1000,
			companyName,
			null,
		)
		.run();
}

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

// POST /api/jobs/:id/reputation（求人起点トリガー #117）。実 web_search 成功は live 検証（#116）へ委譲し、
// ここでは gated 分岐（キー未設定・求人不在・企業名不能）のみ決定的に検証する。
describe("POST /api/jobs/:id/reputation", () => {
	it("APIキー未設定なら 200 で中立 skip を返す", async () => {
		const res = await app.request(
			"/api/jobs/job-1/reputation",
			{ method: "POST" },
			{ ...env, ANTHROPIC_API_KEY: undefined },
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			status: "skipped",
			reason: "api-key-not-configured",
		});
	});

	it("APIキー設定済みでも求人が存在しなければ 404", async () => {
		const res = await app.request(
			"/api/jobs/missing/reputation",
			{ method: "POST" },
			{ ...env, ANTHROPIC_API_KEY: "sk-ant-test" },
		);
		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "job not found" });
	});

	it("抽出企業名が無い（名寄せ不能）なら 400", async () => {
		await seedJobWithExtraction("job-noco", null);
		const res = await app.request(
			"/api/jobs/job-noco/reputation",
			{ method: "POST" },
			{ ...env, ANTHROPIC_API_KEY: "sk-ant-test" },
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: "company could not be resolved",
			reason: "companyName",
		});
	});
});
