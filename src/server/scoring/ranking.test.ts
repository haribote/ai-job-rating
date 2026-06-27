import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../../shared/job-schema";
import app from "../app";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "../storage/db-schema";
import { readRanking } from "./ranking";
import { rescoreAll } from "./rescore";

// 全キー unknown の最小求人。必要キーだけ実値で上書きする。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

// jobs + 1 抽出を投入する。extraction_status は failed 時の前処理（全 unknown 化）検証に使う。
async function seed(
	jobId: string,
	job: NormalizedJob,
	status = "ok",
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(jobId, `https://example.com/${jobId}`)
		.run();
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES (?, ?, ?, 'm', 'json-mode', ?, 1000)`,
	)
		.bind(`ext-${jobId}`, jobId, JSON.stringify(job), status)
		.run();
}

// criteria_config を 1 行投入する。
async function setCriterion(
	criterion: string,
	weight: number,
	desiredValue: unknown,
	hardFilter = "none",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES (?, ?, ?, ?)`,
	)
		.bind(
			criterion,
			desiredValue === null ? null : JSON.stringify(desiredValue),
			weight,
			hardFilter,
		)
		.run();
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
	await env.DB.prepare("DELETE FROM scores").run();
});

describe("readRanking（scores からスコア順一覧を組む）", () => {
	it("総合スコア降順に並べ、各求人へ内訳と raw 値を載せる", async () => {
		await seed(
			"low",
			jobWith({
				annualSalary: {
					kind: "numericRange",
					min: 400,
					max: 400,
					raw: "400万",
				},
			}),
		);
		await seed(
			"high",
			jobWith({
				annualSalary: {
					kind: "numericRange",
					min: 900,
					max: 900,
					raw: "900万",
				},
			}),
		);
		await setCriterion("annualSalary", 5, { desired: 800, floor: 300 });
		await rescoreAll(env.DB);

		const { ranked, excluded } = await readRanking(env.DB);
		expect(ranked.map((v) => v.jobId)).toEqual(["high", "low"]);
		expect(excluded).toHaveLength(0);
		// 内訳に raw 値が載る。
		const high = ranked.find((v) => v.jobId === "high");
		const salaryRow = high?.breakdown.find((r) => r.key === "annualSalary");
		expect(salaryRow?.raw).toBe("900万");
		expect(salaryRow?.included).toBe(true);
	});

	it("unknown 中立の項目は included=false（分母除外）で載せる", async () => {
		await seed("j1", jobWith({}));
		await setCriterion("annualSalary", 5, { desired: 800, floor: 300 });
		await rescoreAll(env.DB);

		const { ranked } = await readRanking(env.DB);
		const row = ranked[0]?.breakdown.find((r) => r.key === "annualSalary");
		expect(row?.included).toBe(false);
		expect(row?.score).toBeNull();
		// 採点項目が無いので total は null（評価できる項目なし）。
		expect(ranked[0]?.total).toBeNull();
	});

	it("ハードフィルタ除外求人は ranked から外し excluded へ理由つきで入れる", async () => {
		await seed(
			"ok",
			jobWith({
				remoteWork: { kind: "categorical", categories: ["full-remote"] },
			}),
		);
		await seed("ng", jobWith({})); // remoteWork unknown → required 不適合で除外
		await setCriterion(
			"remoteWork",
			1,
			{ preferred: ["full-remote"] },
			"required",
		);
		await rescoreAll(env.DB);

		const { ranked, excluded } = await readRanking(env.DB);
		expect(ranked.map((v) => v.jobId)).toEqual(["ok"]);
		expect(excluded.map((v) => v.jobId)).toEqual(["ng"]);
		expect(excluded[0]?.rejectedBy).toEqual({
			criterion: "remoteWork",
			filter: "required",
		});
	});

	it("scores が無ければ空の一覧を返す", async () => {
		const { ranked, excluded } = await readRanking(env.DB);
		expect(ranked).toHaveLength(0);
		expect(excluded).toHaveLength(0);
	});

	it("failed 抽出は全 unknown 前処理を経てハードフィルタ判定する（永続スコアと整合）", async () => {
		// raw JSON は値を持つが extraction_status=failed。rescore は全 unknown として採点し、
		// required フィルタを満たせず除外している。ranking も同じ前処理を通すこと（raw 値で誤通過しない）。
		await seed(
			"failed",
			jobWith({
				remoteWork: { kind: "categorical", categories: ["full-remote"] },
			}),
			"failed",
		);
		await setCriterion(
			"remoteWork",
			1,
			{ preferred: ["full-remote"] },
			"required",
		);
		await rescoreAll(env.DB);

		const { ranked, excluded } = await readRanking(env.DB);
		// raw 値だけ見れば通過するが、failed → 全 unknown で required 不適合 → 除外が正。
		expect(ranked.map((v) => v.jobId)).toEqual([]);
		expect(excluded.map((v) => v.jobId)).toEqual(["failed"]);
	});

	it("総合スコア行（__total__）由来の total を表示用に反映する", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await rescoreAll(env.DB);

		// 永続化された __total__ 行と一致する total を表示ビューが持つ。
		const persistedTotal = await env.DB.prepare(
			`SELECT sub_score FROM ${TABLE_NAMES.scores} WHERE job_id = ? AND criterion = ?`,
		)
			.bind("j1", TOTAL_SCORE_CRITERION)
			.first<{ sub_score: number | null }>();
		const { ranked } = await readRanking(env.DB);
		expect(ranked[0]?.total).toBe(persistedTotal?.sub_score ?? null);
	});
});

describe("GET /api/ranking（スコア順一覧の JSON ルート）", () => {
	it("scores を読みスコア順の一覧行を JSON で返す", async () => {
		await seed(
			"j1",
			jobWith({
				annualSalary: {
					kind: "numericRange",
					min: 900,
					max: 900,
					raw: "900万",
				},
			}),
		);
		await setCriterion("annualSalary", 5, { desired: 800, floor: 300 });
		await rescoreAll(env.DB);

		const res = await app.request("/api/ranking", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			jobs: { jobId: string; total: number | null; status: string }[];
		};
		expect(body.jobs[0]).toMatchObject({ jobId: "j1", status: "ok" });
		expect(body.jobs[0]?.total).toBe(1);
	});

	it("求人が無いときは空配列を返す", async () => {
		const res = await app.request("/api/ranking", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { jobs: unknown[]; excluded: unknown[] };
		expect(body.jobs).toEqual([]);
		expect(body.excluded).toEqual([]);
	});
});
