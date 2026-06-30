import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NULL_CORPORATE_NUMBER_CLIENT } from "../companies/houjin-bangou";
import { resolveCompanyForReputation } from "./attach";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
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

describe("resolveCompanyForReputation", () => {
	it("求人を企業へ解決し jobs.company_id を紐付ける", async () => {
		await seedJob("job-1");
		const r = await resolveCompanyForReputation(
			env.DB,
			"job-1",
			"Acme 株式会社",
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const job = await env.DB.prepare(
				"SELECT company_id FROM jobs WHERE id = ?",
			)
				.bind("job-1")
				.first<{ company_id: string }>();
			expect(job?.company_id).toBe(r.companyId);
		}
	});

	it("同一企業名は名寄せで同じ company に収束する（冪等）", async () => {
		await seedJob("job-1");
		await seedJob("job-2");
		const a = await resolveCompanyForReputation(
			env.DB,
			"job-1",
			"Acme 株式会社",
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		const b = await resolveCompanyForReputation(
			env.DB,
			"job-2",
			"（株）Acme", // 表記揺れだが companyKey は一致する
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.companyId).toBe(b.companyId);
	});

	it("既に紐付け済みの求人は既存 company を尊重し companyName で上書きしない", async () => {
		// 抽出パイプラインが付けた正しい紐付けを用意する。
		await env.DB.prepare(
			"INSERT INTO companies (id, name, company_key) VALUES (?, ?, ?)",
		)
			.bind("co-correct", "Correct Co", "correct")
			.run();
		await env.DB.prepare(
			"INSERT INTO jobs (id, source_url, source_type, status, fetched_at, company_id) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(
				"job-linked",
				"https://example.com/linked",
				"paste",
				"scored",
				1000,
				"co-correct",
			)
			.run();

		const r = await resolveCompanyForReputation(
			env.DB,
			"job-linked",
			"別会社 株式会社", // 異なる企業名を渡しても上書きしない
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(r).toEqual({ ok: true, companyId: "co-correct" });

		const job = await env.DB.prepare("SELECT company_id FROM jobs WHERE id = ?")
			.bind("job-linked")
			.first<{ company_id: string }>();
		expect(job?.company_id).toBe("co-correct");
		// 別会社の company 行を新規作成していない。
		const { results } = await env.DB.prepare("SELECT id FROM companies").all<{
			id: string;
		}>();
		expect(results.map((x) => x.id)).toEqual(["co-correct"]);
	});

	it("不存在の job は job_not_found を返し company を作らない", async () => {
		const r = await resolveCompanyForReputation(
			env.DB,
			"missing",
			"Acme",
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(r).toEqual({ ok: false, reason: "job_not_found" });
		const { results } = await env.DB.prepare("SELECT id FROM companies").all();
		expect(results).toHaveLength(0);
	});

	it("企業名が unknown 表記なら company_unresolved", async () => {
		await seedJob("job-1");
		const r = await resolveCompanyForReputation(
			env.DB,
			"job-1",
			"記載なし",
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(r).toEqual({ ok: false, reason: "company_unresolved" });
	});
});
