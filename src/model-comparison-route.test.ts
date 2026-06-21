import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import { modelComparison } from "./model-comparison-route";

// テスト用に AI を注入できる app を組む（本番は c.env.AI を渡す）。
function appWith(ai: AiRunner) {
	const app = new Hono<{ Bindings: { AI: AiRunner } }>();
	app.route("/", modelComparison);
	return { app, env: { AI: ai } };
}

// 比較ルートは「人間が live で各モデルの抽出結果を並べて見る」薄いエントリ。
// 整形・集計は model-comparison.ts に集約し、ここは HTTP 境界のみ担う。
describe("POST /compare", () => {
	it("本文配列を受け、全候補モデルの抽出結果を横並びで返す", async () => {
		const calls: string[] = [];
		const fakeAi: AiRunner = {
			run: async (model: string) => {
				calls.push(model);
				return { response: { annualSalary: "700万" } };
			},
		};
		const { app, env } = appWith(fakeAi);

		const res = await app.request(
			"/compare",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					fixtures: [{ name: "job1", body: "年収 700万" }],
				}),
			},
			env,
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			models: string[];
			report: Array<{ fixture: string; results: unknown[] }>;
		};
		// 候補モデルすべてを回す（既定の CANDIDATE_MODELS）
		expect(json.models.length).toBeGreaterThanOrEqual(2);
		expect(calls.length).toBe(json.models.length); // 1 fixture × N モデル
		expect(json.report[0].fixture).toBe("job1");
	});

	it("fixtures が空・不正なら 400 を返す（AI を呼ばない）", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};
		const { app, env } = appWith(fakeAi);

		const res = await app.request(
			"/compare",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ fixtures: [] }),
			},
			env,
		);

		expect(res.status).toBe(400);
		expect(called).toBe(false);
	});
});
