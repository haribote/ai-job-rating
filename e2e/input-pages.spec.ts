import { expect, test } from "@playwright/test";

// 旧 SSR 入力ページ（/ ・ /fetch ・ /paste）は撤去され、投入は POST /api/jobs（JSON）へ統合された（#95）。
// ここでは AI を呼ばない入力検証パス・health・SPA シェル配信を deployed worker に対し検証する。
// 取得→抽出を伴う成功パス（AI 依存）は #96 の SPA e2e で扱う。
test.describe("POST /api/jobs（入力検証）と health / SPA シェル", () => {
	test("GET /api/health は 200 と {status:ok} を返す", async ({ request }) => {
		const res = await request.get("/api/health");
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("application/json");
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("ルート / は SPA シェル（静的資産）を 200 で返す", async ({
		request,
	}) => {
		const res = await request.get("/");
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain("ai-job-rating");
	});

	test("空 url は 400(empty)（AI/取得の前に弾く）", async ({ request }) => {
		const res = await request.post("/api/jobs", { data: { url: "" } });
		expect(res.status()).toBe(400);
		expect((await res.json()).reason).toBe("empty");
	});

	test("非 http(s) url は 400(invalid)（SSRF/誤投入の保護）", async ({
		request,
	}) => {
		const res = await request.post("/api/jobs", {
			data: { url: "ftp://example.com/job" },
		});
		expect(res.status()).toBe(400);
		expect((await res.json()).reason).toBe("invalid");
	});

	test("空 html は 400(empty)", async ({ request }) => {
		const res = await request.post("/api/jobs", { data: { html: "" } });
		expect(res.status()).toBe(400);
		expect((await res.json()).reason).toBe("empty");
	});

	test("url と html の同時指定は 400(body)（排他）", async ({ request }) => {
		const res = await request.post("/api/jobs", {
			data: { url: "https://example.com/1", html: "<p>x</p>" },
		});
		expect(res.status()).toBe(400);
		expect((await res.json()).reason).toBe("body");
	});
});
