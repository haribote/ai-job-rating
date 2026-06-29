import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CorporateNumberClient } from "../companies/houjin-bangou";
import { NULL_CORPORATE_NUMBER_CLIENT } from "../companies/houjin-bangou";
import {
	CompaniesStoreError,
	getCompanyById,
	getCompanyByKey,
	linkJobToCompany,
	resolveCompanyForJob,
	upsertCompany,
} from "./companies-store";
import { TABLE_NAMES } from "./db-schema";

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	// applyD1Migrations は冪等で行を消さないため、テスト間の独立性のため明示的に空にする。
	await env.DB.exec("DELETE FROM companies");
	await env.DB.exec("DELETE FROM jobs");
});

// jobs 行を最小で用意する（company_id 紐付けの対象）。
async function seedJob(id: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(id, `https://example.test/${id}`)
		.run();
}

// 決定的な id/now を注入してテストを安定させる。
function fixedOpts(seq: { n: number }) {
	return {
		newId: () => `co-${++seq.n}`,
		now: () => 1000,
	};
}

describe("companies テーブル", () => {
	it("migration 0002 で companies が作成される", async () => {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
		)
			.bind(TABLE_NAMES.companies)
			.first<{ name: string }>();
		expect(row?.name).toBe(TABLE_NAMES.companies);
	});
});

describe("upsertCompany（名寄せキーで一意化）", () => {
	it("表記揺れ（前株/後株/㈱）は同一企業へ収束する", async () => {
		const seq = { n: 0 };
		const a = await upsertCompany(
			env.DB,
			{ name: "株式会社サイバーエージェント" },
			fixedOpts(seq),
		);
		const b = await upsertCompany(
			env.DB,
			{ name: "㈱サイバーエージェント" },
			fixedOpts(seq),
		);
		const c = await upsertCompany(
			env.DB,
			{ name: "サイバーエージェント株式会社" },
			fixedOpts(seq),
		);
		expect(b.id).toBe(a.id);
		expect(c.id).toBe(a.id);
		const { results } = await env.DB.prepare("SELECT id FROM companies").all<{
			id: string;
		}>();
		expect(results).toHaveLength(1);
	});

	it("後から取得した法人番号を NULL のときだけバックフィルする", async () => {
		const seq = { n: 0 };
		await upsertCompany(env.DB, { name: "メルカリ" }, fixedOpts(seq));
		const enriched = await upsertCompany(
			env.DB,
			{ name: "メルカリ", houjinBangou: "1234567890123" },
			fixedOpts(seq),
		);
		expect(enriched.houjin_bangou).toBe("1234567890123");
	});

	it("法人番号一致なら表記が違っても同一企業を返す（最強シグナル）", async () => {
		const seq = { n: 0 };
		const a = await upsertCompany(
			env.DB,
			{ name: "日本電気", houjinBangou: "7010001000000" },
			fixedOpts(seq),
		);
		const b = await upsertCompany(
			env.DB,
			{ name: "ＮＥＣ", houjinBangou: "7010001000000" },
			fixedOpts(seq),
		);
		expect(b.id).toBe(a.id);
	});

	// なぜ: 同名でも法人番号が違えば別法人。最強シグナル（法人番号）で別企業として分離する。
	it("同名（同一名寄せキー）でも法人番号が違えば別企業になる", async () => {
		const seq = { n: 0 };
		const a = await upsertCompany(
			env.DB,
			{ name: "株式会社あさひ", houjinBangou: "1111111111111" },
			fixedOpts(seq),
		);
		const b = await upsertCompany(
			env.DB,
			{ name: "株式会社あさひ", houjinBangou: "2222222222222" },
			fixedOpts(seq),
		);
		expect(b.id).not.toBe(a.id);
		const { results } = await env.DB.prepare("SELECT id FROM companies").all<{
			id: string;
		}>();
		expect(results).toHaveLength(2);
	});

	it("法人番号未判明の同名は判明済み行へ併合せず未判明バケットで一意化する", async () => {
		const seq = { n: 0 };
		const identified = await upsertCompany(
			env.DB,
			{ name: "株式会社あさひ", houjinBangou: "1111111111111" },
			fixedOpts(seq),
		);
		const unknown1 = await upsertCompany(
			env.DB,
			{ name: "株式会社あさひ" },
			fixedOpts(seq),
		);
		const unknown2 = await upsertCompany(
			env.DB,
			{ name: "あさひ" },
			fixedOpts(seq),
		);
		expect(unknown1.id).not.toBe(identified.id);
		expect(unknown2.id).toBe(unknown1.id);
	});

	it("getCompanyById / getCompanyByKey で引ける", async () => {
		const seq = { n: 0 };
		const created = await upsertCompany(
			env.DB,
			{ name: "テスト" },
			fixedOpts(seq),
		);
		expect((await getCompanyById(env.DB, created.id))?.id).toBe(created.id);
		expect((await getCompanyByKey(env.DB, created.company_key))?.id).toBe(
			created.id,
		);
		expect(await getCompanyById(env.DB, "missing")).toBeNull();
	});
});

describe("linkJobToCompany", () => {
	it("jobs.company_id を更新する", async () => {
		const seq = { n: 0 };
		await seedJob("job-1");
		const company = await upsertCompany(
			env.DB,
			{ name: "X社" },
			fixedOpts(seq),
		);
		await linkJobToCompany(env.DB, "job-1", company.id);
		const row = await env.DB.prepare(
			"SELECT company_id FROM jobs WHERE id = 'job-1'",
		).first<{ company_id: string }>();
		expect(row?.company_id).toBe(company.id);
	});

	it("対象 job が無ければ not_found を投げる", async () => {
		await expect(linkJobToCompany(env.DB, "missing", "co-x")).rejects.toThrow(
			CompaniesStoreError,
		);
	});
});

describe("resolveCompanyForJob（名寄せ→紐付けの結線）", () => {
	it("有効な企業名で company を作成し job へ紐付ける（API 無効でも非ブロック）", async () => {
		const seq = { n: 0 };
		await seedJob("job-2");
		const company = await resolveCompanyForJob(
			env.DB,
			"job-2",
			"株式会社サイバーエージェント",
			NULL_CORPORATE_NUMBER_CLIENT,
			fixedOpts(seq),
		);
		expect(company?.houjin_bangou).toBeNull();
		const row = await env.DB.prepare(
			"SELECT company_id FROM jobs WHERE id = 'job-2'",
		).first<{ company_id: string }>();
		expect(row?.company_id).toBe(company?.id);
	});

	it("空・unknown 表記は企業を作らず中立（null）に倒す", async () => {
		const seq = { n: 0 };
		await seedJob("job-3");
		expect(
			await resolveCompanyForJob(
				env.DB,
				"job-3",
				"  ",
				NULL_CORPORATE_NUMBER_CLIENT,
				fixedOpts(seq),
			),
		).toBeNull();
		expect(
			await resolveCompanyForJob(
				env.DB,
				"job-3",
				"記載なし",
				NULL_CORPORATE_NUMBER_CLIENT,
				fixedOpts(seq),
			),
		).toBeNull();
		const { results } = await env.DB.prepare("SELECT id FROM companies").all();
		expect(results).toHaveLength(0);
	});

	// なぜ: name 検索は部分一致しうるため、名寄せキー厳密一致の候補のみ法人番号を採用する。
	it("名寄せキーが一致する候補だけ法人番号を採用する", async () => {
		const seq = { n: 0 };
		await seedJob("job-4");
		const exactClient: CorporateNumberClient = {
			lookupByName: async () => [
				{ corporateNumber: "5010401052465", name: "㈱サイバーエージェント" },
			],
		};
		const matched = await resolveCompanyForJob(
			env.DB,
			"job-4",
			"株式会社サイバーエージェント",
			exactClient,
			fixedOpts(seq),
		);
		expect(matched?.houjin_bangou).toBe("5010401052465");

		await seedJob("job-5");
		const wrongClient: CorporateNumberClient = {
			lookupByName: async () => [
				{ corporateNumber: "9999999999999", name: "全く別の会社" },
			],
		};
		const unmatched = await resolveCompanyForJob(
			env.DB,
			"job-5",
			"株式会社メルカリ",
			wrongClient,
			fixedOpts(seq),
		);
		expect(unmatched?.houjin_bangou).toBeNull();
	});
});
