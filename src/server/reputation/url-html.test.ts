import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NULL_CORPORATE_NUMBER_CLIENT } from "../companies/houjin-bangou";
import type { AiRunner } from "../extract/ai";
import { FetchHtmlError } from "../fetch/fetch-html";
import type { FetchStrategyResult } from "../fetch/fetch-strategy";
import { getLatestReputationSnapshot } from "../storage/reputation-store";
import {
	buildReputationExtractionMessages,
	extractReputationFromHtml,
	ingestUrlHtmlReputation,
	parseReputationAiOutput,
	parseUrlHtmlReputationInput,
} from "./url-html";

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

// 抽出済みスコアを返すフェイク AiRunner（Workers AI の {response: object} 形を模す）。
function fakeAi(response: unknown): AiRunner {
	return { run: vi.fn(async () => ({ response })) };
}

describe("parseUrlHtmlReputationInput（純関数）", () => {
	it("url 投入を判別して通す", () => {
		const r = parseUrlHtmlReputationInput({
			companyName: " Acme ",
			source: " openwork ",
			url: " https://openwork.example/acme ",
		});
		expect(r).toEqual({
			ok: true,
			value: {
				companyName: "Acme",
				source: "openwork",
				mode: "url",
				url: "https://openwork.example/acme",
			},
		});
	});

	it("html 投入を判別して通す", () => {
		const r = parseUrlHtmlReputationInput({
			companyName: "Acme",
			source: "openwork",
			html: "<html>評判</html>",
		});
		expect(r.ok).toBe(true);
		if (r.ok && r.value.mode === "html") {
			expect(r.value.html).toContain("評判");
		}
	});

	it.each([
		[
			"companyName 欠落",
			{ source: "x", url: "https://a.example" },
			"companyName",
		],
		[
			"source 欠落",
			{ companyName: "Acme", url: "https://a.example" },
			"source",
		],
		[
			"url と html 両方",
			{
				companyName: "Acme",
				source: "x",
				url: "https://a.example",
				html: "<p>x</p>",
			},
			"body",
		],
		["url も html も無し", { companyName: "Acme", source: "x" }, "body"],
		[
			"url 不正スキーム",
			{ companyName: "Acme", source: "x", url: "ftp://a.example" },
			"url",
		],
		["url 空", { companyName: "Acme", source: "x", url: "  " }, "url"],
		["html 空", { companyName: "Acme", source: "x", html: "   " }, "html"],
	])("不正入力を理由付きで弾く: %s", (_label, input, reason) => {
		const r = parseUrlHtmlReputationInput(input);
		expect(r).toEqual({ ok: false, reason });
	});

	it("html が上限超過なら too-large", () => {
		const big = "a".repeat(2 * 1024 * 1024 + 1);
		const r = parseUrlHtmlReputationInput({
			companyName: "Acme",
			source: "x",
			html: big,
		});
		expect(r).toEqual({ ok: false, reason: "too-large" });
	});
});

describe("parseReputationAiOutput（決定的パース）", () => {
	it("Workers AI の {response: object} を取り出す", () => {
		const r = parseReputationAiOutput({
			response: {
				overallScore: 3.8,
				reviewCount: 120,
				subScores: { growth: 4 },
			},
		});
		expect(r).toEqual({
			overallScore: 3.8,
			reviewCount: 120,
			subScores: { growth: 4 },
		});
	});

	it("文字列 content（フェンス付き）を JSON として読む", () => {
		const r = parseReputationAiOutput({
			choices: [
				{
					message: {
						content: '```json\n{"overallScore": 4, "reviewCount": 5}\n```',
					},
				},
			],
		});
		expect(r.overallScore).toBe(4);
		expect(r.reviewCount).toBe(5);
		expect(r.subScores).toBeNull();
	});

	it("reviewCount の小数は四捨五入し、負・非数は null へ畳む", () => {
		const r = parseReputationAiOutput({
			response: {
				overallScore: -2,
				reviewCount: 9.6,
				subScores: { ok: 3, bad: -1, alsoBad: "x" },
			},
		});
		expect(r.overallScore).toBeNull();
		expect(r.reviewCount).toBe(10);
		expect(r.subScores).toEqual({ ok: 3 });
	});

	it("想定外形は全 null へ畳む", () => {
		expect(parseReputationAiOutput(null)).toEqual({
			overallScore: null,
			reviewCount: null,
			subScores: null,
		});
		expect(parseReputationAiOutput("not json")).toEqual({
			overallScore: null,
			reviewCount: null,
			subScores: null,
		});
	});
});

describe("buildReputationExtractionMessages", () => {
	it("system + user の 2 メッセージを組む", () => {
		const msgs = buildReputationExtractionMessages("本文");
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe("system");
		expect(msgs[1]).toEqual({ role: "user", content: "本文" });
	});
});

describe("extractReputationFromHtml", () => {
	it("空本文では AI を呼ばず全 null（status ok）", async () => {
		const ai = fakeAi({ overallScore: 1 });
		const r = await extractReputationFromHtml(ai, "<html></html>", {
			model: "@cf/test",
		});
		expect(r.status).toBe("ok");
		expect(r.overallScore).toBeNull();
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("AI 応答を構造化スコアへパースする", async () => {
		const ai = fakeAi({ overallScore: 4.2, reviewCount: 33 });
		const r = await extractReputationFromHtml(
			ai,
			"<html><body>とても良い会社です。残業少なめ。</body></html>",
			{ model: "@cf/test" },
		);
		expect(r.status).toBe("ok");
		expect(r.overallScore).toBe(4.2);
		expect(r.reviewCount).toBe(33);
	});

	it("AI が throw したら extraction_failed に畳む", async () => {
		const ai: AiRunner = {
			run: vi.fn(async () => {
				throw new Error("upstream 504");
			}),
		};
		const r = await extractReputationFromHtml(ai, "<p>本文あり</p>", {
			model: "@cf/test",
		});
		expect(r.status).toBe("extraction_failed");
		expect(r.overallScore).toBeNull();
	});
});

describe("ingestUrlHtmlReputation（取得→抽出→保存）", () => {
	const fixed = {
		snapshotOpts: { newId: () => "rep-1", now: () => 5000 },
		companyOpts: { newId: () => "co-1", now: () => 5000 },
	};

	it("html 投入: 抽出して company 単位 snapshot を保存する", async () => {
		await seedJob("job-1");
		const ai = fakeAi({
			overallScore: 4,
			reviewCount: 8,
			subScores: { growth: 3 },
		});
		const result = await ingestUrlHtmlReputation(
			{ db: env.DB, ai, client: NULL_CORPORATE_NUMBER_CLIENT, ...fixed },
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				mode: "html",
				html: "<p>良い</p>",
			},
		);
		expect(result.kind).toBe("saved");
		if (result.kind === "saved") {
			const latest = await getLatestReputationSnapshot(
				env.DB,
				result.snapshot.company_id,
				"openwork",
			);
			expect(latest?.overall_score).toBe(4);
			expect(latest?.review_count).toBe(8);
		}
	});

	it("url 投入: fetchStrategy で取得してから抽出する", async () => {
		await seedJob("job-1");
		const fetchStrategy = vi.fn(
			async (): Promise<FetchStrategyResult> => ({
				url: "https://openwork.example/acme",
				status: 200,
				html: "<p>口コミ本文</p>",
				source: "fetch",
			}),
		);
		const ai = fakeAi({ overallScore: 3, reviewCount: 50 });
		const result = await ingestUrlHtmlReputation(
			{
				db: env.DB,
				ai,
				client: NULL_CORPORATE_NUMBER_CLIENT,
				fetchStrategy,
				...fixed,
			},
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				mode: "url",
				url: "https://openwork.example/acme",
			},
		);
		expect(fetchStrategy).toHaveBeenCalledOnce();
		expect(result.kind).toBe("saved");
	});

	it("url 取得の恒久失敗は fetch-error（reason は error.kind）", async () => {
		await seedJob("job-1");
		const fetchStrategy = vi.fn(async (): Promise<FetchStrategyResult> => {
			throw new FetchHtmlError({
				kind: "http",
				url: "https://openwork.example/acme",
				status: 404,
				message: "not found",
			});
		});
		const result = await ingestUrlHtmlReputation(
			{
				db: env.DB,
				ai: fakeAi({}),
				client: NULL_CORPORATE_NUMBER_CLIENT,
				fetchStrategy,
			},
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				mode: "url",
				url: "https://openwork.example/acme",
			},
		);
		expect(result).toEqual({ kind: "fetch-error", reason: "http" });
	});

	it("AI 抽出失敗時は保存せず extraction-failed", async () => {
		await seedJob("job-1");
		const ai: AiRunner = {
			run: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		const result = await ingestUrlHtmlReputation(
			{ db: env.DB, ai, client: NULL_CORPORATE_NUMBER_CLIENT },
			"job-1",
			{
				companyName: "Acme",
				source: "openwork",
				mode: "html",
				html: "<p>本文</p>",
			},
		);
		expect(result.kind).toBe("extraction-failed");
		const { results } = await env.DB.prepare(
			"SELECT id FROM reputation_snapshots",
		).all();
		expect(results).toHaveLength(0);
	});

	it("不存在の job では取得・AI を呼ばず job-not-found", async () => {
		const ai = fakeAi({ overallScore: 1 });
		const result = await ingestUrlHtmlReputation(
			{ db: env.DB, ai, client: NULL_CORPORATE_NUMBER_CLIENT },
			"missing",
			{
				companyName: "Acme",
				source: "openwork",
				mode: "html",
				html: "<p>x</p>",
			},
		);
		expect(result.kind).toBe("job-not-found");
		expect(ai.run).not.toHaveBeenCalled();
	});
});
