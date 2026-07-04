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
	await env.DB.prepare("DELETE FROM reputation_snapshots").run();
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM companies").run();
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

		const { ranked, excluded } = await readRanking(env.DB, false);
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

		const { ranked } = await readRanking(env.DB, false);
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

		const { ranked, excluded } = await readRanking(env.DB, false);
		expect(ranked.map((v) => v.jobId)).toEqual(["ok"]);
		expect(excluded.map((v) => v.jobId)).toEqual(["ng"]);
		expect(excluded[0]?.rejectedBy).toEqual({
			criterion: "remoteWork",
			filter: "required",
		});
	});

	it("scores が無ければ空の一覧を返す", async () => {
		const { ranked, excluded } = await readRanking(env.DB, false);
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

		const { ranked, excluded } = await readRanking(env.DB, false);
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
		const { ranked } = await readRanking(env.DB, false);
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

	// スクショ回帰: 仕事・スキル軸（既存の1塊 categories データ）と企業軸（companySize）が
	// unknown（—）や 0.00 に落ちず、実値スコアとして categoryScores に載ることを HTTP 経路で検証する。
	it("仕事・スキル軸と企業軸が実値スコアとして返る", async () => {
		await seed(
			"j1",
			jobWith({
				// 抽出が分割せず保存した既存データを模した1塊 categories。読み取り側で分割して突合する。
				skillMatch: {
					kind: "categorical",
					categories: ["TypeScript, React, Go"],
					raw: "TypeScript, React, Go",
				},
				companySize: { kind: "numericRange", min: 1000, max: 1000 },
			}),
		);
		await setCriterion("skillMatch", 4, { keywords: ["react"] });
		await setCriterion("companySize", 2, { desired: 1000, floor: 50 });
		await rescoreAll(env.DB);

		const res = await app.request("/api/ranking", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			jobs: {
				jobId: string;
				categoryScores: { role: number | null; company: number | null };
			}[];
		};
		const item = body.jobs.find((j) => j.jobId === "j1");
		// role: keyword "react" が1塊から分割・突合されヒット → 100% = 1（0.00 でも — でもない）。
		expect(item?.categoryScores.role).toBe(1);
		// company: companySize=1000 が desired=1000 に到達 → 1（— でない）。
		expect(item?.categoryScores.company).not.toBeNull();
	});
});

describe("readRanking（企業評判を total・順位・company 軸へ read-time 合流・#181）", () => {
	// 企業を作り求人へ紐付け、評判 snapshot を積む。
	async function seedCompanyWithReputation(
		jobId: string,
		companyId: string,
		overallScore: number,
		reviewCount: number,
	): Promise<void> {
		await env.DB.prepare(
			"INSERT INTO companies (id, name, company_key) VALUES (?, ?, ?)",
		)
			.bind(companyId, `name-${companyId}`, `key-${companyId}`)
			.run();
		await env.DB.prepare("UPDATE jobs SET company_id = ? WHERE id = ?")
			.bind(companyId, jobId)
			.run();
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.reputationSnapshots}
			 (id, company_id, source, overall_score, review_count, sub_scores_json, fetched_at, created_at)
			 VALUES (?, ?, 'web_search', ?, ?, NULL, 1000, 1000)`,
		)
			.bind(`snap-${jobId}`, companyId, overallScore, reviewCount)
			.run();
	}

	// 同一の基礎スコア（annualSalary 550 → 0.5）を持つ 2 求人。片方に高評判を付ける。
	async function seedTwoEqualJobs(): Promise<void> {
		const equalSalary = {
			annualSalary: {
				kind: "numericRange" as const,
				min: 550,
				max: 550,
				raw: "550万",
			},
		};
		await seed("with-rep", jobWith(equalSalary));
		await seed("no-rep", jobWith(equalSalary));
		await setCriterion("annualSalary", 5, { desired: 800, floor: 300 });
		await seedCompanyWithReputation("with-rep", "co-good", 4.8, 100000);
		await rescoreAll(env.DB);
	}

	it("キー設定済みなら高評判の求人が total を上げ、同点だった相手を上回る", async () => {
		await seedTwoEqualJobs();
		const { ranked } = await readRanking(env.DB, true);
		// 基礎は同点（0.5）だが、評判合流で with-rep が上位。
		expect(ranked.map((v) => v.jobId)).toEqual(["with-rep", "no-rep"]);
		const withRep = ranked.find((v) => v.jobId === "with-rep");
		const noRep = ranked.find((v) => v.jobId === "no-rep");
		expect(withRep?.total as number).toBeGreaterThan(0.5);
		expect(noRep?.total).toBe(0.5); // 評判なしは基礎スコアのまま
	});

	it("キー未設定なら評判は中立除外で total・順位は不変（決定性）", async () => {
		await seedTwoEqualJobs();
		const { ranked } = await readRanking(env.DB, false);
		// 同点 → jobId 昇順（no-rep < with-rep）。評判は total に効かない。
		expect(ranked.every((v) => v.total === 0.5)).toBe(true);
		expect(ranked.map((v) => v.jobId)).toEqual(["no-rep", "with-rep"]);
	});

	it("company 軸 radar に評判が合流する（キー設定済み）", async () => {
		await seedTwoEqualJobs();
		const res = await app.request(
			"/api/ranking",
			{},
			{ ...env, ANTHROPIC_API_KEY: "sk-ant-test" },
		);
		const body = (await res.json()) as {
			jobs: {
				jobId: string;
				categoryScores: { company: number | null };
			}[];
		};
		// with-rep は companySize/capital 未設定でも評判だけで company 軸が値を持つ（null でない）。
		const withRep = body.jobs.find((j) => j.jobId === "with-rep");
		expect(withRep?.categoryScores.company).not.toBeNull();
		// no-rep は company 軸の材料が無い → null（中立）。
		const noRep = body.jobs.find((j) => j.jobId === "no-rep");
		expect(noRep?.categoryScores.company).toBeNull();
	});
});
