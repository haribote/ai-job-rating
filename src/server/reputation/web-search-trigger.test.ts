import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NULL_CORPORATE_NUMBER_CLIENT } from "../companies/houjin-bangou";
import type {
	RawReputationResult,
	ReputationWebSearchClient,
} from "./web-search";
import { triggerJobReputationWebSearch } from "./web-search-trigger";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM extractions");
	await env.DB.exec("DELETE FROM jobs");
	await env.DB.exec("DELETE FROM companies");
});

// 求人＋最新抽出（company_name）を投入する。company_name=null で「企業名なし」を表す。
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

function fakeClient(result: RawReputationResult | null): {
	client: ReputationWebSearchClient;
	search: ReturnType<typeof vi.fn>;
} {
	const search = vi.fn(async () => result);
	return { client: { search }, search };
}

describe("triggerJobReputationWebSearch（求人起点トリガー）", () => {
	it("企業名から company を seed し jobs.company_id を紐付け、web_search を保存する", async () => {
		await seedJobWithExtraction("job-1", "テスト株式会社");
		const { client, search } = fakeClient({
			overallScore: 3.8,
			reviewCount: 120,
			subScores: null,
		});

		const result = await triggerJobReputationWebSearch(
			{
				db: env.DB,
				client,
				corporateClient: NULL_CORPORATE_NUMBER_CLIENT,
				now: () => 1000,
			},
			"job-1",
		);

		expect(result.kind).toBe("ok");
		expect(search).toHaveBeenCalledTimes(1);
		if (result.kind === "ok") {
			// 求人が seed 済み company へ紐付いた。
			const job = await env.DB.prepare(
				"SELECT company_id FROM jobs WHERE id = ?",
			)
				.bind("job-1")
				.first<{ company_id: string | null }>();
			expect(job?.company_id).toBe(result.companyId);
			// snapshot が保存された。
			expect(result.snapshots[0]?.snapshot?.overall_score).toBe(3.8);
		}
	});

	it("求人が存在しなければ job-not-found（company を作らない）", async () => {
		const { client, search } = fakeClient(null);
		const result = await triggerJobReputationWebSearch(
			{ db: env.DB, client, corporateClient: NULL_CORPORATE_NUMBER_CLIENT },
			"missing",
		);
		expect(result.kind).toBe("job-not-found");
		expect(search).not.toHaveBeenCalled();
		const { results } = await env.DB.prepare("SELECT id FROM companies").all();
		expect(results).toHaveLength(0);
	});

	it("企業名が無い（unknown）なら company-unresolved（web_search を呼ばない）", async () => {
		await seedJobWithExtraction("job-2", null);
		const { client, search } = fakeClient(null);
		const result = await triggerJobReputationWebSearch(
			{ db: env.DB, client, corporateClient: NULL_CORPORATE_NUMBER_CLIENT },
			"job-2",
		);
		expect(result.kind).toBe("company-unresolved");
		expect(search).not.toHaveBeenCalled();
	});
});
