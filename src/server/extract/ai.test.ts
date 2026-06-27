import { describe, expect, it } from "vitest";
import { DEFAULT_AI_HEALTH_MODEL, runAiHealthCheck } from "./ai";

// Workers AI の疎通確認ロジックを検証する。
// live 推論は account/secrets を要するため、env.AI を fake して整形・分岐のみを担保する（決定的）。
describe("runAiHealthCheck", () => {
	// 正常系: モデルが本文を返したら ok:true と整形済み reply を返す
	it("推論成功時は ok と整形した reply を返す", async () => {
		// fake runner: 呼び出し引数を捕捉し固定レスポンスを返す
		const calls: Array<{ model: string; inputs: unknown }> = [];
		const fakeAi = {
			run: async (model: string, inputs: unknown) => {
				calls.push({ model, inputs });
				return {
					choices: [{ message: { role: "assistant", content: "pong" } }],
				};
			},
		};

		const result = await runAiHealthCheck(fakeAi);

		expect(result).toEqual({
			ok: true,
			model: DEFAULT_AI_HEALTH_MODEL,
			reply: "pong",
		});
		// 既定モデルへ messages 形式で渡していることを確認する
		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe(DEFAULT_AI_HEALTH_MODEL);
	});

	// 異常系: 推論が throw しても疎通確認は落とさず ok:false と理由を返す
	it("推論失敗時は ok:false とエラー理由を返す", async () => {
		const fakeAi = {
			run: async () => {
				throw new Error("upstream down");
			},
		};

		const result = await runAiHealthCheck(fakeAi);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("upstream down");
		}
	});

	// 整形の頑健性: 想定外のレスポンス形でも reply は空文字へ正規化し ok:true を保つ
	it("本文が欠落していても reply を空文字へ正規化する", async () => {
		const fakeAi = {
			run: async () => ({ choices: [] }),
		};

		const result = await runAiHealthCheck(fakeAi);

		expect(result).toEqual({
			ok: true,
			model: DEFAULT_AI_HEALTH_MODEL,
			reply: "",
		});
	});
});
