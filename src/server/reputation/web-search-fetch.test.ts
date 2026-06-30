import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveReputationSnapshot } from "../storage/reputation-store";
import {
	fetchReputationSnapshot,
	type RawReputationResult,
	type ReputationWebSearchClient,
} from "./web-search";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM companies");
});

async function seedCompany(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO companies (id, name, company_key) VALUES (?, ?, ?)",
	)
		.bind(id, `name-${id}`, `key-${id}`)
		.run();
}

// 固定結果/失敗を返す Fake クライアント（client.search の呼び出し回数も検証する）。
function fakeClient(result: RawReputationResult | null): {
	client: ReputationWebSearchClient;
	search: ReturnType<typeof vi.fn>;
} {
	const search = vi.fn(async () => result);
	return { client: { search }, search };
}

describe("fetchReputationSnapshot（冪等オーケストレータ）", () => {
	it("キャッシュ未取得なら web_search を呼び、スナップショットを保存する", async () => {
		await seedCompany("co-1");
		const { client, search } = fakeClient({
			overallScore: 3.8,
			reviewCount: 120,
			subScores: { 成長: 4.0 },
		});
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client, now: () => 1000 },
			{
				companyId: "co-1",
				companyName: "テスト株式会社",
				source: "web_search",
			},
		);
		expect(search).toHaveBeenCalledTimes(1);
		expect(r.fetched).toBe(true);
		expect(r.cached).toBe(false);
		expect(r.snapshot?.overall_score).toBe(3.8);
		expect(r.snapshot?.review_count).toBe(120);
		expect(JSON.parse(r.snapshot?.sub_scores_json ?? "{}")).toEqual({
			成長: 4.0,
		});
		// 注入時計が保存行の fetched_at にも効く（鮮度判定と保存で同じ時計・決定性契約）。
		expect(r.snapshot?.fetched_at).toBe(1000);
	});

	it("fresh なキャッシュがあれば web_search を呼ばず返す", async () => {
		await seedCompany("co-1");
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search", overallScore: 4.2 },
			{ newId: () => "snap-1", now: () => 1000 },
		);
		const { client, search } = fakeClient({
			overallScore: 9.9,
			reviewCount: 1,
			subScores: null,
		});
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client, maxAgeSeconds: 100, now: () => 1050 },
			{
				companyId: "co-1",
				companyName: "テスト株式会社",
				source: "web_search",
			},
		);
		expect(search).not.toHaveBeenCalled();
		expect(r.cached).toBe(true);
		expect(r.fetched).toBe(false);
		expect(r.snapshot?.overall_score).toBe(4.2);
	});

	it("stale なキャッシュは web_search を呼び新規保存する", async () => {
		await seedCompany("co-1");
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search", overallScore: 4.2 },
			{ newId: () => "snap-1", now: () => 1000 },
		);
		const { client, search } = fakeClient({
			overallScore: 3.0,
			reviewCount: 5,
			subScores: null,
		});
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client, maxAgeSeconds: 100, now: () => 2000 },
			{
				companyId: "co-1",
				companyName: "テスト株式会社",
				source: "web_search",
			},
		);
		expect(search).toHaveBeenCalledTimes(1);
		expect(r.fetched).toBe(true);
		expect(r.snapshot?.overall_score).toBe(3.0);
	});

	it("取得失敗（client が null）は保存せず、既存 stale キャッシュを返す", async () => {
		await seedCompany("co-1");
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search", overallScore: 4.2 },
			{ newId: () => "snap-1", now: () => 1000 },
		);
		const { client } = fakeClient(null);
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client, maxAgeSeconds: 100, now: () => 2000 },
			{
				companyId: "co-1",
				companyName: "テスト株式会社",
				source: "web_search",
			},
		);
		expect(r.fetched).toBe(false);
		expect(r.cached).toBe(false);
		// stale でも既存キャッシュを返す。新規保存はしていない。
		expect(r.snapshot?.overall_score).toBe(4.2);
		const { results } = await env.DB.prepare(
			"SELECT id FROM reputation_snapshots WHERE company_id = 'co-1'",
		).all();
		expect(results).toHaveLength(1);
	});

	it("取得失敗かつキャッシュ無しは snapshot=null・保存なし", async () => {
		await seedCompany("co-1");
		const { client } = fakeClient(null);
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client },
			{ companyId: "co-1", companyName: "テスト株式会社" },
		);
		expect(r.snapshot).toBeNull();
		expect(r.fetched).toBe(false);
	});

	it("該当なし（全 null）は NULL スナップショットを保存する（negative cache）", async () => {
		await seedCompany("co-1");
		const { client } = fakeClient({
			overallScore: null,
			reviewCount: null,
			subScores: null,
		});
		const r = await fetchReputationSnapshot(
			{ db: env.DB, client },
			{ companyId: "co-1", companyName: "テスト株式会社" },
		);
		expect(r.fetched).toBe(true);
		expect(r.snapshot).not.toBeNull();
		expect(r.snapshot?.overall_score).toBeNull();
		expect(r.snapshot?.review_count).toBeNull();
		expect(r.snapshot?.sub_scores_json).toBeNull();
	});
});
