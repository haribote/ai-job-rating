import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { parseReputationSourceInput } from "./reputation-config";

// ---------------------------------------------------------------------------
// 決定的バリデーション（純関数）
// ---------------------------------------------------------------------------

describe("parseReputationSourceInput", () => {
	it("name を trim して非空なら受理する", () => {
		const r = parseReputationSourceInput({
			name: "  openwork  ",
			fetchMethod: "web_search",
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.name).toBe("openwork");
	});

	it("name が空・非文字列は reason:name で拒否する", () => {
		expect(parseReputationSourceInput({ fetchMethod: "web_search" })).toEqual({
			ok: false,
			reason: "name",
		});
		expect(
			parseReputationSourceInput({ name: "   ", fetchMethod: "web_search" }),
		).toEqual({ ok: false, reason: "name" });
		expect(
			parseReputationSourceInput({ name: 1, fetchMethod: "web_search" }),
		).toEqual({ ok: false, reason: "name" });
	});

	it("fetchMethod は閉集合のみ受理する（web_search/url_html/manual）", () => {
		for (const m of ["web_search", "url_html", "manual"] as const) {
			const r = parseReputationSourceInput({ name: "s", fetchMethod: m });
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.fetchMethod).toBe(m);
		}
		expect(
			parseReputationSourceInput({ name: "s", fetchMethod: "scrape" }),
		).toEqual({ ok: false, reason: "fetch_method" });
		expect(parseReputationSourceInput({ name: "s" })).toEqual({
			ok: false,
			reason: "fetch_method",
		});
	});

	it("identifier は trim し、未指定・空文字は null（任意）", () => {
		const a = parseReputationSourceInput({
			name: "s",
			fetchMethod: "url_html",
			identifier: "  https://x.test  ",
		});
		expect(a.ok && a.value.identifier).toBe("https://x.test");
		const b = parseReputationSourceInput({ name: "s", fetchMethod: "manual" });
		expect(b.ok && b.value.identifier).toBe(null);
		const c = parseReputationSourceInput({
			name: "s",
			fetchMethod: "manual",
			identifier: "   ",
		});
		expect(c.ok && c.value.identifier).toBe(null);
	});

	it("identifier が非文字列・非 null は reason:identifier で拒否する", () => {
		expect(
			parseReputationSourceInput({
				name: "s",
				fetchMethod: "manual",
				identifier: 5,
			}),
		).toEqual({ ok: false, reason: "identifier" });
	});

	it("priority は非負整数のみ受理し、未指定は 0", () => {
		const a = parseReputationSourceInput({
			name: "s",
			fetchMethod: "manual",
			priority: 3,
		});
		expect(a.ok && a.value.priority).toBe(3);
		const b = parseReputationSourceInput({ name: "s", fetchMethod: "manual" });
		expect(b.ok && b.value.priority).toBe(0);
		for (const bad of [-1, 1.5, Number.NaN, "2"]) {
			expect(
				parseReputationSourceInput({
					name: "s",
					fetchMethod: "manual",
					priority: bad,
				}),
			).toEqual({ ok: false, reason: "priority" });
		}
	});

	it("enabled は真偽値のみ受理し、未指定は true", () => {
		const a = parseReputationSourceInput({
			name: "s",
			fetchMethod: "manual",
			enabled: false,
		});
		expect(a.ok && a.value.enabled).toBe(false);
		const b = parseReputationSourceInput({ name: "s", fetchMethod: "manual" });
		expect(b.ok && b.value.enabled).toBe(true);
		expect(
			parseReputationSourceInput({
				name: "s",
				fetchMethod: "manual",
				enabled: "yes",
			}),
		).toEqual({ ok: false, reason: "enabled" });
	});

	it("非オブジェクト入力は reason:name で拒否する", () => {
		expect(parseReputationSourceInput(null)).toEqual({
			ok: false,
			reason: "name",
		});
		expect(parseReputationSourceInput("x")).toEqual({
			ok: false,
			reason: "name",
		});
	});
});

// ---------------------------------------------------------------------------
// ルート契約（GET / PUT / DELETE）— D1 往復
// ---------------------------------------------------------------------------

async function listSources(): Promise<Response> {
	return app.request("/api/reputation/sources", {}, env);
}

async function putSource(body: unknown): Promise<Response> {
	return app.request(
		"/api/reputation/sources",
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.exec("DELETE FROM reputation_sources");
});

describe("GET /api/reputation/sources", () => {
	it("初期状態は空配列を返す", async () => {
		const res = await listSources();
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ sources: [] });
	});

	it("priority 昇順・同値は name 昇順で返す", async () => {
		await putSource({ name: "b", fetchMethod: "web_search", priority: 1 });
		await putSource({ name: "a", fetchMethod: "manual", priority: 1 });
		await putSource({ name: "c", fetchMethod: "url_html", priority: 0 });
		const res = await listSources();
		const body = (await res.json()) as { sources: { name: string }[] };
		expect(body.sources.map((s) => s.name)).toEqual(["c", "a", "b"]);
	});
});

describe("PUT /api/reputation/sources", () => {
	it("upsert して保存済み行を返す（name 一意）", async () => {
		const res = await putSource({
			name: "openwork",
			fetchMethod: "web_search",
			identifier: "openwork.jp",
			priority: 2,
			enabled: true,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			source: { name: string; priority: number; enabled: number };
		};
		expect(body.source.name).toBe("openwork");
		expect(body.source.priority).toBe(2);
		// SQLite には boolean が無いため 0/1 で返る。
		expect(body.source.enabled).toBe(1);

		// 同名 PUT は新規行を増やさず更新する。
		await putSource({ name: "openwork", fetchMethod: "manual", priority: 5 });
		const list = (await (await listSources()).json()) as {
			sources: unknown[];
		};
		expect(list.sources).toHaveLength(1);
	});

	it("不正な fetchMethod は 400 reason:fetch_method", async () => {
		const res = await putSource({ name: "x", fetchMethod: "scrape" });
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			reason: "fetch_method",
		});
	});

	it("name 空は 400 reason:name", async () => {
		const res = await putSource({ name: "  ", fetchMethod: "manual" });
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "name" });
	});

	it("配列など非オブジェクト body は 400 reason:body", async () => {
		const res = await putSource([{ name: "x", fetchMethod: "manual" }]);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ reason: "body" });
	});
});

describe("DELETE /api/reputation/sources/:id", () => {
	it("既存を削除すると 200・一覧から消える", async () => {
		const created = (await (
			await putSource({ name: "to-del", fetchMethod: "manual" })
		).json()) as { source: { id: string } };
		const res = await app.request(
			`/api/reputation/sources/${created.source.id}`,
			{ method: "DELETE" },
			env,
		);
		expect(res.status).toBe(200);
		const list = (await (await listSources()).json()) as { sources: unknown[] };
		expect(list.sources).toHaveLength(0);
	});

	it("存在しない id は 404", async () => {
		const res = await app.request(
			"/api/reputation/sources/missing",
			{ method: "DELETE" },
			env,
		);
		expect(res.status).toBe(404);
	});
});
