import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NULL_CORPORATE_NUMBER_CLIENT } from "../companies/houjin-bangou";
import { getLatestReputationSnapshot } from "../storage/reputation-store";
import { parseManualReputationInput, saveManualReputation } from "./manual";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM jobs");
	await env.DB.exec("DELETE FROM companies");
});

// 求人 1 件を最小列で用意する（company 解決の対象）。
async function seedJob(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, status, fetched_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, `https://example.com/${id}`, "paste", "scored", 1000)
		.run();
}

function fixedOpts(seq: { n: number }, now = 2000) {
	return {
		snapshotOpts: { newId: () => `rep-${++seq.n}`, now: () => now },
		companyOpts: { newId: () => `co-${++seq.n}`, now: () => now },
	};
}

describe("parseManualReputationInput（純関数）", () => {
	it("companyName と source と少なくとも1つのスコアがあれば通る", () => {
		const r = parseManualReputationInput({
			companyName: "  Acme 株式会社 ",
			source: " openwork ",
			overallScore: 3.5,
		});
		expect(r).toEqual({
			ok: true,
			value: {
				companyName: "Acme 株式会社",
				source: "openwork",
				overallScore: 3.5,
				reviewCount: null,
				subScores: null,
			},
		});
	});

	it("reviewCount / subScores のみでも通る", () => {
		const r = parseManualReputationInput({
			companyName: "Acme",
			source: "openwork",
			reviewCount: 12,
			subScores: { growth: 4, salary: 2.5 },
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.reviewCount).toBe(12);
			expect(r.value.subScores).toEqual({ growth: 4, salary: 2.5 });
			expect(r.value.overallScore).toBeNull();
		}
	});

	it.each([
		["非オブジェクト", null, "companyName"],
		["companyName 欠落", { source: "x", overallScore: 1 }, "companyName"],
		[
			"companyName 空白",
			{ companyName: "  ", source: "x", overallScore: 1 },
			"companyName",
		],
		["source 欠落", { companyName: "Acme", overallScore: 1 }, "source"],
		[
			"source 空白",
			{ companyName: "Acme", source: " ", overallScore: 1 },
			"source",
		],
		[
			"overallScore 負",
			{ companyName: "Acme", source: "x", overallScore: -1 },
			"overallScore",
		],
		[
			"overallScore NaN",
			{ companyName: "Acme", source: "x", overallScore: Number.NaN },
			"overallScore",
		],
		[
			"overallScore 非数",
			{ companyName: "Acme", source: "x", overallScore: "3" },
			"overallScore",
		],
		[
			"reviewCount 小数",
			{ companyName: "Acme", source: "x", reviewCount: 1.5 },
			"reviewCount",
		],
		[
			"reviewCount 負",
			{ companyName: "Acme", source: "x", reviewCount: -2 },
			"reviewCount",
		],
		[
			"subScores 非record",
			{ companyName: "Acme", source: "x", subScores: [1, 2] },
			"subScores",
		],
		[
			"subScores 空",
			{ companyName: "Acme", source: "x", subScores: {} },
			"subScores",
		],
		[
			"subScores 非数値値",
			{ companyName: "Acme", source: "x", subScores: { a: "x" } },
			"subScores",
		],
		[
			"subScores 負値",
			{ companyName: "Acme", source: "x", subScores: { a: -1 } },
			"subScores",
		],
		["上書き値なし", { companyName: "Acme", source: "x" }, "empty"],
	])("不正入力を理由付きで弾く: %s", (_label, input, reason) => {
		const r = parseManualReputationInput(input);
		expect(r).toEqual({ ok: false, reason });
	});

	it("overallScore=0 は有効（非負）", () => {
		const r = parseManualReputationInput({
			companyName: "Acme",
			source: "x",
			overallScore: 0,
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.overallScore).toBe(0);
	});
});

describe("saveManualReputation（company 単位 append-only 上書き）", () => {
	it("検証済み値を company 単位 snapshot として保存する", async () => {
		await seedJob("job-1");
		const seq = { n: 0 };
		const result = await saveManualReputation(
			{ db: env.DB, client: NULL_CORPORATE_NUMBER_CLIENT, ...fixedOpts(seq) },
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				overallScore: 4,
				reviewCount: 10,
				subScores: { growth: 5 },
			},
		);
		expect(result.kind).toBe("saved");
		if (result.kind === "saved") {
			expect(result.snapshot.overall_score).toBe(4);
			expect(result.snapshot.review_count).toBe(10);
			expect(JSON.parse(result.snapshot.sub_scores_json ?? "null")).toEqual({
				growth: 5,
			});
		}
	});

	it("不存在の job では job-not-found を返し company を作らない", async () => {
		const result = await saveManualReputation(
			{ db: env.DB, client: NULL_CORPORATE_NUMBER_CLIENT },
			"missing",
			{
				companyName: "Acme",
				source: "x",
				overallScore: 1,
				reviewCount: null,
				subScores: null,
			},
		);
		expect(result.kind).toBe("job-not-found");
		const { results } = await env.DB.prepare("SELECT id FROM companies").all();
		expect(results).toHaveLength(0);
	});

	it("企業名が unknown 表記なら company-unresolved", async () => {
		await seedJob("job-1");
		const result = await saveManualReputation(
			{ db: env.DB, client: NULL_CORPORATE_NUMBER_CLIENT },
			"job-1",
			{
				companyName: "不明",
				source: "x",
				overallScore: 1,
				reviewCount: null,
				subScores: null,
			},
		);
		expect(result.kind).toBe("company-unresolved");
	});

	it("manual を後から積むと getLatest が最新（手入力）を返す＝上書き", async () => {
		await seedJob("job-1");
		// 先に web_search 相当の snapshot を別途保存しておく（同 source）。
		const seq = { n: 0 };
		const first = await saveManualReputation(
			{ db: env.DB, client: NULL_CORPORATE_NUMBER_CLIENT, ...fixedOpts(seq) },
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				overallScore: 2,
				reviewCount: null,
				subScores: null,
			},
		);
		expect(first.kind).toBe("saved");
		const companyId = first.kind === "saved" ? first.snapshot.company_id : "";

		// 後から手入力で上書き（fetched_at をより新しく）。
		const second = await saveManualReputation(
			{
				db: env.DB,
				client: NULL_CORPORATE_NUMBER_CLIENT,
				snapshotOpts: { newId: () => "rep-late", now: () => 9000 },
			},
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				overallScore: 5,
				reviewCount: null,
				subScores: null,
			},
		);
		expect(second.kind).toBe("saved");

		const latest = await getLatestReputationSnapshot(
			env.DB,
			companyId,
			"openwork",
		);
		expect(latest?.overall_score).toBe(5);
	});
});
