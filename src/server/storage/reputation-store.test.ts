import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TABLE_NAMES } from "./db-schema";
import {
	deleteReputationSource,
	getLatestReputationSnapshot,
	getReputationSourceById,
	isReputationSnapshotFresh,
	listLatestReputationSnapshots,
	listReputationSources,
	ReputationStoreError,
	saveReputationSnapshot,
	upsertReputationSource,
} from "./reputation-store";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	// applyD1Migrations は冪等で行を消さないため、テスト間の独立性のため明示的に空にする。
	await env.DB.exec("DELETE FROM reputation_snapshots");
	await env.DB.exec("DELETE FROM reputation_sources");
	await env.DB.exec("DELETE FROM companies");
});

// 評判は企業単位の属性のため、companies 行（#32）を最小で用意する（FK の対象）。
async function seedCompany(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO companies (id, name, company_key) VALUES (?, ?, ?)",
	)
		.bind(id, `name-${id}`, `key-${id}`)
		.run();
}

// 決定的な id/now を注入してテストを安定させる。
function fixedOpts(seq: { n: number }, now = 1000) {
	return {
		newId: () => `rep-${++seq.n}`,
		now: () => now,
	};
}

describe("reputation テーブル", () => {
	it("migration 0003 で reputation_snapshots / reputation_sources が作成される", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table'",
		).all<{ name: string }>();
		const names = results.map((r) => r.name);
		expect(names).toContain(TABLE_NAMES.reputationSnapshots);
		expect(names).toContain(TABLE_NAMES.reputationSources);
	});
});

describe("saveReputationSnapshot / getLatestReputationSnapshot（企業単位キャッシュ）", () => {
	it("保存したスナップショットを企業単位で読み戻せる", async () => {
		await seedCompany("co-1");
		const seq = { n: 0 };
		const saved = await saveReputationSnapshot(
			env.DB,
			{
				companyId: "co-1",
				source: "openwork",
				overallScore: 3.8,
				reviewCount: 120,
				subScores: { growth: 4.0, salary: 3.5 },
			},
			fixedOpts(seq),
		);
		const got = await getLatestReputationSnapshot(env.DB, "co-1");
		expect(got).not.toBeNull();
		expect(got?.id).toBe(saved.id);
		expect(got?.overall_score).toBe(3.8);
		expect(got?.review_count).toBe(120);
		// サブ項目は JSON 文字列で往復する（解釈はスコア層 #36）。
		expect(JSON.parse(got?.sub_scores_json ?? "{}")).toEqual({
			growth: 4.0,
			salary: 3.5,
		});
	});

	it("取れない値は NULL で保存され unknown 中立を表せる（§5.2）", async () => {
		await seedCompany("co-1");
		const seq = { n: 0 };
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search" },
			fixedOpts(seq),
		);
		const got = await getLatestReputationSnapshot(env.DB, "co-1");
		// 「取得したがスコア無し」は NULL。行が無い「未取得」と区別できる。
		expect(got).not.toBeNull();
		expect(got?.overall_score).toBeNull();
		expect(got?.review_count).toBeNull();
		expect(got?.sub_scores_json).toBeNull();
	});

	it("未取得企業は null を返す（行が無い＝キャッシュミス）", async () => {
		await seedCompany("co-1");
		expect(await getLatestReputationSnapshot(env.DB, "co-1")).toBeNull();
	});

	it("最新（fetched_at 降順）のスナップショットを返す", async () => {
		await seedCompany("co-1");
		const seq = { n: 0 };
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 3.0 },
			fixedOpts(seq, 1000),
		);
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 4.0 },
			fixedOpts(seq, 2000),
		);
		const got = await getLatestReputationSnapshot(env.DB, "co-1");
		expect(got?.overall_score).toBe(4.0);
		expect(got?.fetched_at).toBe(2000);
	});

	it("source 指定で取得元別の最新を引ける", async () => {
		await seedCompany("co-1");
		const seq = { n: 0 };
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 3.0 },
			fixedOpts(seq, 2000),
		);
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search", overallScore: 4.5 },
			fixedOpts(seq, 1000),
		);
		const openwork = await getLatestReputationSnapshot(
			env.DB,
			"co-1",
			"openwork",
		);
		expect(openwork?.overall_score).toBe(3.0);
	});

	it("存在しない企業への保存は not_found を投げる", async () => {
		await expect(
			saveReputationSnapshot(env.DB, {
				companyId: "missing",
				source: "openwork",
			}),
		).rejects.toBeInstanceOf(ReputationStoreError);
	});

	it("companies 削除でスナップショットが CASCADE 削除される", async () => {
		await seedCompany("co-1");
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 3.0 },
			fixedOpts({ n: 0 }),
		);
		await env.DB.prepare("DELETE FROM companies WHERE id = 'co-1'").run();
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM reputation_snapshots WHERE company_id = 'co-1'",
		).first<{ n: number }>();
		expect(row?.n).toBe(0);
	});
});

describe("listLatestReputationSnapshots（取得元ごとの最新）", () => {
	it("取得元ごとに最新 1 件を source 昇順で返す", async () => {
		await seedCompany("co-1");
		const seq = { n: 0 };
		// openwork は 2 件・最新は 4.0。web_search は 1 件。
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 3.0 },
			fixedOpts(seq, 1000),
		);
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "openwork", overallScore: 4.0 },
			fixedOpts(seq, 2000),
		);
		await saveReputationSnapshot(
			env.DB,
			{ companyId: "co-1", source: "web_search", overallScore: 4.5 },
			fixedOpts(seq, 1500),
		);
		const rows = await listLatestReputationSnapshots(env.DB, "co-1");
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.source)).toEqual(["openwork", "web_search"]);
		expect(rows[0]?.overall_score).toBe(4.0);
		expect(rows[1]?.overall_score).toBe(4.5);
	});
});

describe("isReputationSnapshotFresh（キャッシュ鮮度判定・純関数）", () => {
	it("maxAge 以内は新鮮、超過は陳腐と判定する", () => {
		const snap = { fetched_at: 1000 };
		// 経過 50 秒 ≤ 100 → 新鮮。
		expect(isReputationSnapshotFresh(snap, 100, 1050)).toBe(true);
		// 境界（ちょうど maxAge）は新鮮とみなす。
		expect(isReputationSnapshotFresh(snap, 100, 1100)).toBe(true);
		// 経過 101 秒 > 100 → 陳腐（再取得が必要）。
		expect(isReputationSnapshotFresh(snap, 100, 1101)).toBe(false);
	});
});

describe("reputation_sources（取得元設定の永続化）", () => {
	it("upsert で新規作成し id で読み戻せる", async () => {
		const source = await upsertReputationSource(
			env.DB,
			{
				name: "OpenWork",
				identifier: "https://openwork.test",
				fetchMethod: "web_search",
			},
			fixedOpts({ n: 0 }),
		);
		const got = await getReputationSourceById(env.DB, source.id);
		expect(got?.name).toBe("OpenWork");
		expect(got?.fetch_method).toBe("web_search");
		// 既定値: priority=0 / enabled=1。
		expect(got?.priority).toBe(0);
		expect(got?.enabled).toBe(1);
	});

	it("同名 upsert は更新し行を増やさない", async () => {
		const seq = { n: 0 };
		const a = await upsertReputationSource(
			env.DB,
			{ name: "OpenWork", fetchMethod: "web_search", priority: 1 },
			fixedOpts(seq),
		);
		const b = await upsertReputationSource(
			env.DB,
			{
				name: "OpenWork",
				fetchMethod: "url_html",
				priority: 5,
				enabled: false,
			},
			fixedOpts(seq),
		);
		expect(b.id).toBe(a.id);
		expect(b.fetch_method).toBe("url_html");
		expect(b.priority).toBe(5);
		expect(b.enabled).toBe(0);
		const { results } = await env.DB.prepare(
			"SELECT id FROM reputation_sources",
		).all<{ id: string }>();
		expect(results).toHaveLength(1);
	});

	it("list は priority 昇順で返し enabledOnly で無効を除外する", async () => {
		const seq = { n: 0 };
		await upsertReputationSource(
			env.DB,
			{ name: "B", fetchMethod: "web_search", priority: 2 },
			fixedOpts(seq),
		);
		await upsertReputationSource(
			env.DB,
			{ name: "A", fetchMethod: "web_search", priority: 1 },
			fixedOpts(seq),
		);
		await upsertReputationSource(
			env.DB,
			{ name: "C", fetchMethod: "manual", priority: 3, enabled: false },
			fixedOpts(seq),
		);
		const all = await listReputationSources(env.DB);
		expect(all.map((s) => s.name)).toEqual(["A", "B", "C"]);
		const enabled = await listReputationSources(env.DB, { enabledOnly: true });
		expect(enabled.map((s) => s.name)).toEqual(["A", "B"]);
	});

	it("delete は対象を消し、無ければ not_found を投げる", async () => {
		const source = await upsertReputationSource(
			env.DB,
			{ name: "OpenWork", fetchMethod: "web_search" },
			fixedOpts({ n: 0 }),
		);
		await deleteReputationSource(env.DB, source.id);
		expect(await getReputationSourceById(env.DB, source.id)).toBeNull();
		await expect(
			deleteReputationSource(env.DB, "missing"),
		).rejects.toBeInstanceOf(ReputationStoreError);
	});
});
