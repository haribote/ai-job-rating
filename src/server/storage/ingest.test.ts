import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "./db-schema";
import { ingestJob } from "./ingest";
import { getRawHtml } from "./raw-html-store";

// 抽出が 1 項目だけ値を返す fake（本文内容に依存せず決定的）。
const okAi: AiRunner = {
	run: async () => ({ response: { annualSalary: "700万〜900万" } }),
};

// 非 transient エラーで抽出失敗（extraction_failed）を起こす fake。リトライ待ちを避けるため 400 を投げる。
const failingAi: AiRunner = {
	run: async () => {
		throw { status: 400 };
	},
};

// id/時刻を注入して決定的にする deps を組み立てる。
function deps(
	ai: AiRunner,
	ids: string[],
	now = 1000,
): {
	db: typeof env.DB;
	bucket: typeof env.RAW_HTML;
	ai: AiRunner;
	newId: () => string;
	now: () => number;
} {
	let i = 0;
	return {
		db: env.DB,
		bucket: env.RAW_HTML,
		ai,
		newId: () => ids[i++] ?? `id-${i}`,
		now: () => now,
	};
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
});

describe("ingestJob（取込→永続化: jobs/extractions/R2/scores 結線・#26）", () => {
	it("jobs 行を作成し jobId を返す", async () => {
		const result = await ingestJob(deps(okAi, ["job-1"]), {
			html: "<html><body>年収 700万〜900万</body></html>",
			sourceType: "detail",
			sourceUrl: "https://example.com/j1",
		});

		expect(result.jobId).toBe("job-1");
		const row = await env.DB.prepare(
			"SELECT source_url, source_type, status FROM jobs WHERE id = ?",
		)
			.bind("job-1")
			.first<{ source_url: string; source_type: string; status: string }>();
		expect(row).toEqual({
			source_url: "https://example.com/j1",
			source_type: "detail",
			status: "scored",
		});
	});

	it("extractions 行へ抽出結果を保存する（structured_json/model/mechanism/extraction_status）", async () => {
		await ingestJob(deps(okAi, ["job-1"]), {
			html: "<html><body>年収 700万〜900万</body></html>",
			sourceType: "detail",
			sourceUrl: "https://example.com/j1",
		});

		const ext = await env.DB.prepare(
			`SELECT structured_json, model, mechanism, extraction_status FROM ${TABLE_NAMES.extractions} WHERE job_id = ?`,
		)
			.bind("job-1")
			.first<{
				structured_json: string;
				model: string;
				mechanism: string;
				extraction_status: string;
			}>();
		expect(ext?.mechanism).toBe("json-mode");
		expect(ext?.extraction_status).toBe("ok");
		expect(ext?.model).not.toBe("");
		// structured_json は NormalizedJob として parse でき、抽出値が反映される。
		const job = JSON.parse(ext?.structured_json ?? "{}");
		expect(job.annualSalary).toMatchObject({ kind: "numericRange" });
	});

	it("生 HTML を R2 に保存し jobs.raw_html_r2_key へ紐付ける", async () => {
		const html = "<html><body>年収 700万〜900万</body></html>";
		await ingestJob(deps(okAi, ["job-1"]), {
			html,
			sourceType: "detail",
			sourceUrl: "https://example.com/j1",
		});

		const row = await env.DB.prepare(
			"SELECT raw_html_r2_key FROM jobs WHERE id = ?",
		)
			.bind("job-1")
			.first<{ raw_html_r2_key: string | null }>();
		expect(row?.raw_html_r2_key).not.toBeNull();
		const stored = await getRawHtml(env.RAW_HTML, row?.raw_html_r2_key ?? "");
		expect(stored).toBe(html);
	});

	it("取込後に scores を生成する（__total__ 行が存在）", async () => {
		await ingestJob(deps(okAi, ["job-1"]), {
			html: "<html><body>年収 700万〜900万</body></html>",
			sourceType: "detail",
			sourceUrl: "https://example.com/j1",
		});

		const total = await env.DB.prepare(
			`SELECT 1 AS hit FROM ${TABLE_NAMES.scores} WHERE job_id = ? AND criterion = ?`,
		)
			.bind("job-1", TOTAL_SCORE_CRITERION)
			.first<{ hit: number }>();
		expect(total?.hit).toBe(1);
	});

	it("抽出失敗時は extraction_status=failed・jobs.status=failed で保存する", async () => {
		const result = await ingestJob(deps(failingAi, ["job-1"]), {
			html: "<html><body>本文</body></html>",
			sourceType: "detail",
			sourceUrl: "https://example.com/j1",
		});

		expect(result.extractionStatus).toBe("failed");
		const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?")
			.bind("job-1")
			.first<{ status: string }>();
		expect(job?.status).toBe("failed");
		const ext = await env.DB.prepare(
			`SELECT extraction_status FROM ${TABLE_NAMES.extractions} WHERE job_id = ?`,
		)
			.bind("job-1")
			.first<{ extraction_status: string }>();
		expect(ext?.extraction_status).toBe("failed");
	});

	it("paste 経路は source_url を合成し URL なしでも保存できる", async () => {
		const result = await ingestJob(deps(okAi, ["job-1"]), {
			html: "<html><body>年収 700万〜900万</body></html>",
			sourceType: "paste",
		});

		const row = await env.DB.prepare(
			"SELECT source_url, source_type FROM jobs WHERE id = ?",
		)
			.bind(result.jobId)
			.first<{ source_url: string; source_type: string }>();
		expect(row?.source_type).toBe("paste");
		// 合成 URL は UNIQUE 制約を満たす非空値（job ごとに一意）。
		expect(row?.source_url).toContain("job-1");
	});

	it("同一 URL の再取込は新 job を作らず最新抽出として追加する", async () => {
		const input = {
			html: "<html><body>年収 700万〜900万</body></html>",
			sourceType: "detail" as const,
			sourceUrl: "https://example.com/j1",
		};
		const first = await ingestJob(deps(okAi, ["job-1"], 1000), input);
		const second = await ingestJob(deps(okAi, ["job-2"], 2000), input);

		// 同一 URL は同一 job に集約（新 id を採番しない）。
		expect(second.jobId).toBe(first.jobId);
		const jobCount = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM jobs WHERE source_url = ?",
		)
			.bind("https://example.com/j1")
			.first<{ n: number }>();
		expect(jobCount?.n).toBe(1);
		// 抽出は追加されている（再取込で履歴を残す）。
		const extCount = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${TABLE_NAMES.extractions} WHERE job_id = ?`,
		)
			.bind(first.jobId)
			.first<{ n: number }>();
		expect(extCount?.n).toBe(2);
	});
});
