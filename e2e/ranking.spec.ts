import { expect, test } from "@playwright/test";

// GET /api/ranking の JSON 契約を deployed worker（wrangler dev --local）に対し検証する（#95）。
// 旧 SSR 一覧ページ（/ranking）は撤去済み。永続スコアが空でも {jobs:[],excluded:[]} で成立する（空状態）。
// AI 抽出・再スコアリングは呼ばれない経路のため決定的に検証できる（§5.3）。
test.describe("GET /api/ranking 一覧（JSON）", () => {
	test("200 と {jobs,excluded} を JSON で返す", async ({ request }) => {
		const res = await request.get("/api/ranking");
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("application/json");
		const body = await res.json();
		expect(Array.isArray(body.jobs)).toBe(true);
		expect(Array.isArray(body.excluded)).toBe(true);
	});

	test("投入求人が無いときは空配列で成立する（空状態）", async ({
		request,
	}) => {
		// E2E の隔離 D1 は投入求人を持たないため、空配列が期待動作。
		const res = await request.get("/api/ranking");
		const body = await res.json();
		expect(body.jobs).toEqual([]);
		expect(body.excluded).toEqual([]);
	});
});
