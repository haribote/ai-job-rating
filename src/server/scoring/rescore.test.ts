import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../../shared/job-schema";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "../storage/db-schema";
import { rescoreAll, rescoreOne } from "./rescore";

// 全キー unknown の最小求人を作り、必要キーだけ実値で上書きする。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

// jobs + 1 抽出を投入するヘルパ。
async function seed(
	jobId: string,
	job: NormalizedJob,
	status = "ok",
	extractedAt = 1000,
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(jobId, `https://example.com/${jobId}`)
		.run();
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES (?, ?, ?, 'm', 'json-mode', ?, ?)`,
	)
		.bind(`ext-${jobId}`, jobId, JSON.stringify(job), status, extractedAt)
		.run();
}

// criteria_config を 1 行投入/更新するヘルパ。
async function setCriterion(
	criterion: string,
	weight: number,
	desiredValue: unknown,
	hardFilter = "none",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES (?, ?, ?, ?)
		 ON CONFLICT(criterion) DO UPDATE SET desired_value=excluded.desired_value, weight=excluded.weight, hard_filter=excluded.hard_filter`,
	)
		.bind(
			criterion,
			desiredValue === null ? null : JSON.stringify(desiredValue),
			weight,
			hardFilter,
		)
		.run();
}

// 総合スコア行（__total__）の sub_score を引く。
async function readTotal(jobId: string): Promise<number | null | undefined> {
	const row = await env.DB.prepare(
		`SELECT sub_score FROM ${TABLE_NAMES.scores} WHERE job_id = ? AND criterion = ?`,
	)
		.bind(jobId, TOTAL_SCORE_CRITERION)
		.first<{ sub_score: number | null }>();
	return row?.sub_score;
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	// in-memory D1 はテストファイル内で永続するため、各テスト前に jobs を空にして
	// source_url 一意制約の衝突を避ける（jobs 削除で extractions/scores も CASCADE）。
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
});

describe("rescoreOne（保存済み抽出から再スコアリングして scores へ）", () => {
	it("criteria_config と保存済み抽出だけで総合スコアを書き戻す（AI 非依存）", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });

		const scored = await rescoreOne(env.DB, "j1");
		expect(scored?.score.total).toBe(1);
		expect(await readTotal("j1")).toBe(1);
	});

	it("aiJudged は既定 matcher で求人スキル×希望集合を決定的に突合する（#68）", async () => {
		// 求人の必須スキルは当該キーの categorical に載る（#20 extractJobSkills の取得元）。
		await seed(
			"j1",
			jobWith({
				requiredSkillsMatch: {
					kind: "categorical",
					categories: ["go", "ts", "rust"],
				},
			}),
		);
		// 希望集合 [go, ts] は desired_value({skills}) に持つ。matcher は注入しない。
		await setCriterion("requiredSkillsMatch", 1, { skills: ["go", "ts"] });

		const scored = await rescoreOne(env.DB, "j1");
		// 求人 [go, ts, rust] のうち希望 [go, ts] が満たすのは 2/3
		expect(scored?.score.total).toBeCloseTo(2 / 3);
	});

	it("各正規キー行と総合スコア行（__total__）を書く。unknown は included=0/sub_score NULL", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await setCriterion("overtime", 3, { desired: 10, ceil: 45 }); // 求人は unknown

		await rescoreOne(env.DB, "j1");
		const overtime = await env.DB.prepare(
			`SELECT sub_score, included FROM ${TABLE_NAMES.scores} WHERE job_id='j1' AND criterion='overtime'`,
		).first<{ sub_score: number | null; included: number }>();
		expect(overtime?.included).toBe(0);
		expect(overtime?.sub_score).toBeNull();
	});

	it("再実行で scores を冪等に上書きする（重複行を残さない）", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await rescoreOne(env.DB, "j1");
		await rescoreOne(env.DB, "j1");
		const { results } = await env.DB.prepare(
			`SELECT criterion FROM ${TABLE_NAMES.scores} WHERE job_id='j1'`,
		).all<{ criterion: string }>();
		// annualSalary + __total__ の 2 行のみ（重複なし）
		expect(results.length).toBe(2);
	});

	it("失敗(failed)抽出は全項目中立で total=null（unknown 中立と区別）", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
			"failed",
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		const scored = await rescoreOne(env.DB, "j1");
		expect(scored?.score.total).toBeNull();
		expect(await readTotal("j1")).toBeNull();
	});

	it("抽出が無い job_id は null を返し何も書かない", async () => {
		expect(await rescoreOne(env.DB, "missing")).toBeNull();
	});

	it("job_id ごとの最新抽出（extracted_at 最大）を使う", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 400, max: 400 } }),
			"ok",
			1000,
		);
		// 後発の抽出（より高い年収）
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES ('ext2','j1',?, 'm','json-mode','ok', 2000)`,
		)
			.bind(
				JSON.stringify(
					jobWith({
						annualSalary: { kind: "numericRange", min: 800, max: 800 },
					}),
				),
			)
			.run();
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		const scored = await rescoreOne(env.DB, "j1");
		// 最新（800, desired 以上）→ 1.0
		expect(scored?.score.total).toBe(1);
	});

	it("extracted_at 同値の衝突時も決定的に 1 件へ絞る（重複行を作らない）", async () => {
		// 同 job_id・同 extracted_at の抽出を2件投入（id だけ異なる）。
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 400, max: 400 } }),
			"ok",
			1000,
		);
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES ('ext-j1-b','j1',?, 'm','json-mode','ok', 1000)`,
		)
			.bind(
				JSON.stringify(
					jobWith({
						annualSalary: { kind: "numericRange", min: 800, max: 800 },
					}),
				),
			)
			.run();
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await rescoreOne(env.DB, "j1");
		// scores は 1 セットのみ（annualSalary + __total__ の 2 行）
		const { results } = await env.DB.prepare(
			`SELECT criterion FROM ${TABLE_NAMES.scores} WHERE job_id='j1'`,
		).all<{ criterion: string }>();
		expect(results.length).toBe(2);
	});
});

describe("rescoreAll（設定変更→即再ランキング・AI 非再実行・§5.3）", () => {
	it("重み変更だけで AI を再実行せず総合スコアが変わる（抽出は据え置き）", async () => {
		await seed(
			"j1",
			jobWith({
				annualSalary: { kind: "numericRange", min: 800, max: 800 }, // score 1.0
				overtime: { kind: "numericRange", min: 45, max: 45 }, // ceil ちょうど → 0.0
			}),
		);
		await setCriterion("annualSalary", 1, { desired: 700, floor: 300 });
		await setCriterion("overtime", 1, { desired: 10, ceil: 45 });
		// 重み 1:1 → (1*1 + 1*0)/2 = 0.5
		await rescoreAll(env.DB);
		expect(await readTotal("j1")).toBe(0.5);

		// 抽出を触らず重みだけ変更（annualSalary 3 : overtime 1）→ (3*1 + 1*0)/4 = 0.75
		await setCriterion("annualSalary", 3, { desired: 700, floor: 300 });
		await rescoreAll(env.DB);
		expect(await readTotal("j1")).toBe(0.75);

		// 抽出行は一度も増えていない（AI 再実行なしの証跡）
		const ext = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${TABLE_NAMES.extractions} WHERE job_id='j1'`,
		).first<{ n: number }>();
		expect(ext?.n).toBe(1);
	});

	it("複数求人を再スコアリングしランキング可能な総合スコアを書く", async () => {
		await seed(
			"low",
			jobWith({ annualSalary: { kind: "numericRange", min: 400, max: 400 } }),
		);
		await seed(
			"high",
			jobWith({ annualSalary: { kind: "numericRange", min: 900, max: 900 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await rescoreAll(env.DB);
		const low = await readTotal("low");
		const high = await readTotal("high");
		expect(high).toBe(1);
		expect(low).not.toBeNull();
		expect((high ?? 0) > (low ?? 1)).toBe(true);
	});

	it("同一入力・同一設定なら同一スコア（決定的、§8）", async () => {
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 650, max: 650 } }),
		);
		await setCriterion("annualSalary", 5, { desired: 700, floor: 300 });
		await rescoreAll(env.DB);
		const first = await readTotal("j1");
		await rescoreAll(env.DB);
		const second = await readTotal("j1");
		expect(first).toBe(second);
	});

	it("ハードフィルタ required を満たさない求人はランキングから外す（score は保持）", async () => {
		await seed(
			"ok",
			jobWith({ remoteWork: { kind: "categorical", categories: ["full"] } }),
		);
		await seed(
			"ng",
			jobWith({ remoteWork: { kind: "categorical", categories: ["onsite"] } }),
		);
		await setCriterion("remoteWork", 1, { preferred: ["full"] }, "required");
		const scored = await rescoreAll(env.DB);
		const ngResult = scored.find((s) => s.jobId === "ng");
		const okResult = scored.find((s) => s.jobId === "ok");
		expect(okResult?.hardFilter.passed).toBe(true);
		expect(ngResult?.hardFilter.passed).toBe(false);
	});
});
