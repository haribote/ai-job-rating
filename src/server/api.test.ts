import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../shared/job-schema";
import app from "./app";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "./storage/db-schema";

// 全キー unknown の最小求人を作り、必要キーだけ実値で上書きする。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

// jobs + 最新抽出のみ投入する（scores はまだ無い）。
async function seedJob(jobId: string, job: NormalizedJob): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, status, fetched_at) VALUES (?, ?, 'detail', 'extracted', 0)",
	)
		.bind(jobId, `https://example.com/${jobId}`)
		.run();
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES (?, ?, ?, 'm', 'json-mode', 'ok', 1000)`,
	)
		.bind(`ext-${jobId}`, jobId, JSON.stringify(job))
		.run();
}

async function putConfig(items: unknown): Promise<Response> {
	return app.request(
		"/api/config",
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ items }),
		},
		env,
	);
}

async function postJobs(body: unknown): Promise<Response> {
	return app.request(
		"/api/jobs",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM scores").run();
	await env.DB.prepare("DELETE FROM extractions").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
	await env.DB.prepare("DELETE FROM jobs").run();
});

describe("GET /api/health", () => {
	it("200 と固定形式 { status: ok } を返す", async () => {
		const res = await app.request("/api/health", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});
});

describe("POST /api/jobs（入力検証）", () => {
	it("不正 JSON は 400(body)", async () => {
		const res = await app.request(
			"/api/jobs",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			},
			env,
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "body" });
	});

	it("url と html の同時指定は 400(body)", async () => {
		const res = await postJobs({
			url: "https://example.com",
			html: "<p>x</p>",
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "body" });
	});

	it("どちらも無いは 400(body)", async () => {
		const res = await postJobs({});
		expect(res.status).toBe(400);
	});

	it("空 url は 400(empty)", async () => {
		const res = await postJobs({ url: "" });
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "empty" });
	});

	it("非 http(s) url は 400(invalid)", async () => {
		const res = await postJobs({ url: "ftp://example.com/job" });
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "invalid" });
	});

	it("空 html は 400(empty)", async () => {
		const res = await postJobs({ html: "" });
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "empty" });
	});

	it("上限超過 html は 413(too-large)", async () => {
		const res = await postJobs({ html: "a".repeat(2 * 1024 * 1024 + 1) });
		expect(res.status).toBe(413);
		await expect(res.json()).resolves.toMatchObject({ reason: "too-large" });
	});
});

describe("GET /api/jobs/:id", () => {
	it("未存在は 404", async () => {
		const res = await app.request("/api/jobs/nope", {}, env);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/jobs/:id/reextract", () => {
	it("未存在は 404", async () => {
		const res = await app.request(
			"/api/jobs/nope/reextract",
			{ method: "POST" },
			env,
		);
		expect(res.status).toBe(404);
	});
});

describe("GET /api/ranking", () => {
	it("200 と { jobs, excluded } を JSON で返す", async () => {
		const res = await app.request("/api/ranking", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { jobs: unknown[]; excluded: unknown[] };
		expect(Array.isArray(body.jobs)).toBe(true);
		expect(Array.isArray(body.excluded)).toBe(true);
	});

	it("スコア済み求人を一覧行（jobId/total/status）として返す", async () => {
		await seedJob(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		// 設定を入れて再スコアさせる（PUT 経由）。
		await putConfig([
			{
				criterion: "annualSalary",
				weight: 5,
				hardFilter: "none",
				desired: { desired: 700, floor: 300 },
			},
		]);
		const res = await app.request("/api/ranking", {}, env);
		const body = (await res.json()) as {
			jobs: { jobId: string; total: number | null; status: string }[];
		};
		expect(body.jobs.length).toBe(1);
		expect(body.jobs[0]).toMatchObject({ jobId: "j1", status: "ok", total: 1 });
	});
});

describe("GET /api/config", () => {
	it("200 と全正規キーぶんの items を返す", async () => {
		const res = await app.request("/api/config", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { items: unknown[] };
		expect(body.items.length).toBe(21);
	});
});

describe("PUT /api/config", () => {
	it("items が配列でなければ 400(body)", async () => {
		const res = await app.request(
			"/api/config",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ items: "nope" }),
			},
			env,
		);
		expect(res.status).toBe(400);
	});

	it("不正入力は 400 で、criteria_config を変更しない", async () => {
		const res = await putConfig([
			{ criterion: "annualSalary", weight: -1, hardFilter: "none" },
		]);
		expect(res.status).toBe(400);
		const n = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM criteria_config",
		).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	// ガードレールの中核: 重み変更で AI を再実行せず、保存済み抽出のまま決定的に再スコアする（§5.3）。
	it("保存後に再スコアし、AI は再実行しない（抽出 row 数不変・決定的スコア）", async () => {
		await seedJob(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await seedJob(
			"j2",
			jobWith({ annualSalary: { kind: "numericRange", min: 400, max: 400 } }),
		);
		const extBefore = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions",
		).first<{ n: number }>();

		const res = await putConfig([
			{
				criterion: "annualSalary",
				weight: 5,
				hardFilter: "none",
				desired: { desired: 700, floor: 300 },
			},
		]);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			status: "rescored",
			count: 2,
		});

		// 抽出 row 数が増えていない = AI 抽出を再実行していない証拠。
		const extAfter = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions",
		).first<{ n: number }>();
		expect(extAfter?.n).toBe(extBefore?.n);

		// 決定的な再スコア結果（desired=700/floor=300）。
		const total1 = await env.DB.prepare(
			"SELECT sub_score FROM scores WHERE job_id='j1' AND criterion=?",
		)
			.bind(TOTAL_SCORE_CRITERION)
			.first<{ sub_score: number | null }>();
		const total2 = await env.DB.prepare(
			"SELECT sub_score FROM scores WHERE job_id='j2' AND criterion=?",
		)
			.bind(TOTAL_SCORE_CRITERION)
			.first<{ sub_score: number | null }>();
		expect(total1?.sub_score).toBe(1);
		expect(total2?.sub_score).toBeCloseTo(0.25, 5);
	});
});

describe("HTML を返す経路が無いこと", () => {
	it("既知の API ルートは application/json を返す（HTML でない）", async () => {
		for (const path of ["/api/health", "/api/ranking", "/api/config"]) {
			const res = await app.request(path, {}, env);
			expect(res.headers.get("content-type")).toContain("application/json");
		}
	});
});
