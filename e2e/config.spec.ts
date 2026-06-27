import { expect, test } from "@playwright/test";

// GET /api/config・PUT /api/config の JSON 契約を deployed worker（wrangler dev --local）に対し検証する（#95）。
// 旧 SSR フォーム（/config）は撤去済み。PUT は決定的な rescoreAll 経路で AI を再実行しない（§5.3）。
// 空 D1 でも再スコア自体は成立する（投入求人ゼロなので count=0）。AI を呼ばない経路に限定する。
test.describe("/api/config（設定の取得・更新）", () => {
	test("GET /api/config は全正規キーの items を JSON で返す", async ({
		request,
	}) => {
		const res = await request.get("/api/config");
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("application/json");
		const body = await res.json();
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items.length).toBe(21);
	});

	test("PUT /api/config は保存し再スコアする（AI 非再実行・status=rescored）", async ({
		request,
	}) => {
		const res = await request.put("/api/config", {
			data: {
				items: [
					{
						criterion: "annualSalary",
						weight: 5,
						hardFilter: "none",
						desired: { desired: 700, floor: 300 },
					},
				],
			},
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("rescored");
		expect(typeof body.count).toBe("number");
	});

	test("PUT /api/config は不正な重みを 400 で拒否する（AI/再スコアの前に弾く）", async ({
		request,
	}) => {
		const res = await request.put("/api/config", {
			data: {
				items: [{ criterion: "annualSalary", weight: -1, hardFilter: "none" }],
			},
		});
		expect(res.status()).toBe(400);
	});
});
