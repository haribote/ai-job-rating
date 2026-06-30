import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../app";

// #35 の補助/フォールバック経路（手入力上書き / URL・HTML 投入）の HTTP 契約。
// AI を要する URL/HTML の happy path はオーケストレータ単体（url-html.test.ts）で fake AI を注入して検証する。
// ここでは AI を呼ぶ前に確定する配線・入力検証・求人解決のステータス対応を担保する。

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM jobs");
	await env.DB.exec("DELETE FROM companies");
});

async function seedJob(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, status, fetched_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, `https://example.com/${id}`, "paste", "scored", 1000)
		.run();
}

function put(path: string, body: unknown) {
	return app.request(
		path,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

function post(path: string, body: unknown) {
	return app.request(
		path,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

describe("PUT /api/jobs/:id/reputation/manual", () => {
	it("手入力を保存して 200 と snapshot を返す", async () => {
		await seedJob("job-1");
		const res = await put("/api/jobs/job-1/reputation/manual", {
			companyName: "Acme",
			source: "openwork",
			overallScore: 4,
			reviewCount: 9,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			snapshot: { overall_score: number; review_count: number };
		};
		expect(json.snapshot.overall_score).toBe(4);
		expect(json.snapshot.review_count).toBe(9);
	});

	it("不正入力は 400 と reason", async () => {
		await seedJob("job-1");
		const res = await put("/api/jobs/job-1/reputation/manual", {
			companyName: "Acme",
			source: "openwork",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { reason: string }).reason).toBe("empty");
	});

	it("不存在の job は 404", async () => {
		const res = await put("/api/jobs/missing/reputation/manual", {
			companyName: "Acme",
			source: "openwork",
			overallScore: 1,
		});
		expect(res.status).toBe(404);
	});

	it("企業名が名寄せ不能なら 400", async () => {
		await seedJob("job-1");
		const res = await put("/api/jobs/job-1/reputation/manual", {
			companyName: "なし",
			source: "openwork",
			overallScore: 1,
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /api/jobs/:id/reputation/url", () => {
	it("url と html 同時指定は 400", async () => {
		await seedJob("job-1");
		const res = await post("/api/jobs/job-1/reputation/url", {
			companyName: "Acme",
			source: "openwork",
			url: "https://a.example",
			html: "<p>x</p>",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { reason: string }).reason).toBe("body");
	});

	it("html 上限超過は 413", async () => {
		await seedJob("job-1");
		const res = await post("/api/jobs/job-1/reputation/url", {
			companyName: "Acme",
			source: "openwork",
			html: "a".repeat(2 * 1024 * 1024 + 1),
		});
		expect(res.status).toBe(413);
	});

	it("不存在の job は 404（AI 到達前に弾く）", async () => {
		const res = await post("/api/jobs/missing/reputation/url", {
			companyName: "Acme",
			source: "openwork",
			html: "<p>本文</p>",
		});
		expect(res.status).toBe(404);
	});
});
