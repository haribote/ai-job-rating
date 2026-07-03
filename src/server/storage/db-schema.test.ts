import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NORMALIZED_KEYS, type NormalizedJob } from "../../shared/job-schema";
import {
	type ExtractionStructuredJson,
	SCHEMA_VERSION,
	TABLE_NAMES,
	TOTAL_SCORE_CRITERION,
} from "./db-schema";

// 全正規キーを unknown で埋めた最小の NormalizedJob（structured_json 往復用）。
function makeUnknownJob(): NormalizedJob {
	return Object.fromEntries(
		NORMALIZED_KEYS.map((key) => [key, { kind: "unknown" }]),
	) as NormalizedJob;
}

// 各テストは本番マイグレーションを適用した独立スキーマで走る（決定的・同一入力→同一スキーマ）。
beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1 スキーマ", () => {
	it("4 テーブル（jobs/extractions/scores/criteria_config）を作成する", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
		).all<{ name: string }>();
		const names = results.map((r) => r.name);
		for (const table of Object.values(TABLE_NAMES)) {
			expect(names).toContain(table);
		}
	});

	it("jobs を挿入し読み戻せる（source_url 一意・状態の既定値 fetched）", async () => {
		await env.DB.prepare(
			"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, ?, ?)",
		)
			.bind("job-1", "https://example.com/jobs/1", "detail", 1000)
			.run();

		const row = await env.DB.prepare(
			"SELECT status, raw_html_r2_key FROM jobs WHERE id = ?",
		)
			.bind("job-1")
			.first<{ status: string; raw_html_r2_key: string | null }>();
		expect(row?.status).toBe("fetched");
		// 生 HTML(R2) 参照キーは未取得時 NULL（#16→#17）。
		expect(row?.raw_html_r2_key).toBeNull();
	});

	it("source_url の重複投入を一意制約で拒否する", async () => {
		const insert = (id: string) =>
			env.DB.prepare(
				"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
			)
				.bind(id, "https://example.com/dup")
				.run();
		await insert("a");
		await expect(insert("b")).rejects.toThrow();
	});

	it("不正な source_type を CHECK 制約で拒否する", async () => {
		await expect(
			env.DB.prepare(
				"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES ('x','u','bogus',0)",
			).run(),
		).rejects.toThrow();
	});

	it("extractions は mechanism と extraction_status を必須にする（#65）", async () => {
		await seedJob("job-2");
		// extraction_status を省くと NOT NULL 既定で 'ok' になる一方、mechanism は必須。
		await expect(
			env.DB.prepare(
				"INSERT INTO extractions (id, job_id, structured_json, model) VALUES ('e','job-2','{}','m')",
			).run(),
		).rejects.toThrow();
	});

	it("不正な extraction_status を CHECK 制約で拒否する（failed を unknown と誤認させない）", async () => {
		await seedJob("job-3");
		await expect(
			env.DB.prepare(
				"INSERT INTO extractions (id, job_id, structured_json, model, mechanism, extraction_status) VALUES ('e','job-3','{}','m','json-mode','bogus')",
			).run(),
		).rejects.toThrow();
	});

	it("structured_json に NormalizedJob を保存し往復で同型を復元する", async () => {
		await seedJob("job-4");
		const job = makeUnknownJob();
		await env.DB.prepare(
			"INSERT INTO extractions (id, job_id, structured_json, model, mechanism, extraction_status, schema_version) VALUES (?,?,?,?,?,?,?)",
		)
			.bind(
				"ext-4",
				"job-4",
				JSON.stringify(job),
				"@cf/test",
				"json-mode",
				"ok",
				SCHEMA_VERSION,
			)
			.run();

		const row = await env.DB.prepare(
			"SELECT structured_json, extraction_status, repaired, schema_version FROM extractions WHERE id = ?",
		)
			.bind("ext-4")
			.first<{
				structured_json: string;
				extraction_status: string;
				repaired: number;
				schema_version: number;
			}>();
		const restored = JSON.parse(
			row?.structured_json ?? "{}",
		) as ExtractionStructuredJson;
		expect(restored).toEqual(job);
		expect(row?.extraction_status).toBe("ok");
		// repaired は既定 0（修復なし）。SQLite は boolean を 0/1 で持つ。
		expect(row?.repaired).toBe(0);
		expect(row?.schema_version).toBe(SCHEMA_VERSION);
	});

	it("jobs 削除で extractions / scores が CASCADE 削除される", async () => {
		await seedJob("job-5");
		await env.DB.prepare(
			"INSERT INTO extractions (id, job_id, structured_json, model, mechanism) VALUES ('e5','job-5','{}','m','json-mode')",
		).run();
		await env.DB.prepare(
			"INSERT INTO scores (job_id, criterion, sub_score, included, weight) VALUES ('job-5', ?, 1.0, 1, 5)",
		)
			.bind(TOTAL_SCORE_CRITERION)
			.run();

		await env.DB.prepare("DELETE FROM jobs WHERE id = 'job-5'").run();

		const ext = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions WHERE job_id = 'job-5'",
		).first<{ n: number }>();
		const sc = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM scores WHERE job_id = 'job-5'",
		).first<{ n: number }>();
		expect(ext?.n).toBe(0);
		expect(sc?.n).toBe(0);
	});

	it("criteria_config は正規キーを主キーに重み・ハードフィルタを保持する（#20）", async () => {
		// #198 の seed migration により annualSalary は既定行を持つため、上書き検証の前提として一度クリアする。
		await env.DB.prepare("DELETE FROM criteria_config").run();
		await env.DB.prepare(
			"INSERT INTO criteria_config (criterion, desired_value, weight, hard_filter) VALUES ('annualSalary', ?, 5, 'required')",
		)
			.bind(JSON.stringify({ desired: 700, floor: 300 }))
			.run();
		const row = await env.DB.prepare(
			"SELECT weight, hard_filter, desired_value FROM criteria_config WHERE criterion = 'annualSalary'",
		).first<{ weight: number; hard_filter: string; desired_value: string }>();
		expect(row?.weight).toBe(5);
		expect(row?.hard_filter).toBe("required");
		expect(JSON.parse(row?.desired_value ?? "{}")).toEqual({
			desired: 700,
			floor: 300,
		});
	});

	it("criteria_config の不正な hard_filter を CHECK 制約で拒否する", async () => {
		// #198 の seed migration により overtime は既定行を持つため、PRIMARY KEY 制約ではなく
		// 本来検証したい CHECK 制約違反であることを確定させるために一度クリアする。
		await env.DB.prepare("DELETE FROM criteria_config").run();
		await expect(
			env.DB.prepare(
				"INSERT INTO criteria_config (criterion, hard_filter) VALUES ('overtime','bogus')",
			).run(),
		).rejects.toThrow();
	});

	it("scores は included=0 / sub_score NULL で unknown 中立（分母除外）を表せる（§5.2）", async () => {
		await seedJob("job-6");
		await env.DB.prepare(
			"INSERT INTO scores (job_id, criterion, sub_score, included, weight) VALUES ('job-6','overtime', NULL, 0, 3)",
		).run();
		const row = await env.DB.prepare(
			"SELECT sub_score, included FROM scores WHERE job_id='job-6' AND criterion='overtime'",
		).first<{ sub_score: number | null; included: number }>();
		expect(row?.sub_score).toBeNull();
		expect(row?.included).toBe(0);
	});

	it("scores は (job_id, criterion) 複合主キーで重複を拒否する", async () => {
		await seedJob("job-7");
		const insert = () =>
			env.DB.prepare(
				"INSERT INTO scores (job_id, criterion, sub_score, included) VALUES ('job-7', ?, 1.0, 1)",
			)
				.bind(TOTAL_SCORE_CRITERION)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow();
	});
});

// FK 制約検証のために親 jobs 行を用意するヘルパ。
async function seedJob(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(id, `https://example.com/${id}`)
		.run();
}
