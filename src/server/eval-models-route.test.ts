import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { AiRunner } from "./extract/ai";
import { rawFieldsToNormalizedJob } from "./extract/extract";
import { EXTRACTION_MODEL_CANDIDATES } from "./extract/model-eval";

// #106 live golden eval ランナーの dev 限定ルートを検証する。
// live 推論には依存させず、env.AI を fake binding に差し替えて経路（gate→検証→evaluateModels）を固定する。

// 呼び出し回数を数える AiRunner。throws=true なら呼ばれた瞬間に throw（gate 検証用）。
function countingAi(
	response: unknown,
	throws = false,
): { ai: AiRunner; calls: () => number } {
	let calls = 0;
	const ai: AiRunner = {
		run: async () => {
			calls += 1;
			if (throws) throw new Error("AI を呼んではいけない（gate で弾くべき）");
			return response;
		},
	};
	return { ai, calls: () => calls };
}

// gate で AI を呼ばないことの検証用（呼ばれたら throw）。
const spyAi = () => countingAi(undefined, true);

// JSON Mode 応答（{ response: <object> }）を固定で返す fake。決定的に baseline を満点へ寄せる。
const jsonModeAi = (fields: Record<string, string>) =>
	countingAi({ response: fields });

const evalEnv = (overrides: Record<string, unknown>) =>
	({ ...env, ...overrides }) as unknown as Parameters<typeof app.request>[2];

describe("POST /api/_eval-models（dev 限定ルート）", () => {
	it("EXTRACTION_EVAL 未設定なら 404 を返し AI を呼ばない（本番安全）", async () => {
		const spy = spyAi();
		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: JSON.stringify({ cases: [] }),
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: spy.ai, EXTRACTION_EVAL: undefined }),
		);
		expect(res.status).toBe(404);
		expect(spy.calls()).toBe(0);
	});

	it('EXTRACTION_EVAL が "1" 以外なら 404（gate は厳密一致）', async () => {
		const spy = spyAi();
		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: JSON.stringify({ cases: [] }),
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: spy.ai, EXTRACTION_EVAL: "0" }),
		);
		expect(res.status).toBe(404);
		expect(spy.calls()).toBe(0);
	});

	it("不正な JSON body は 400", async () => {
		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: "{not json",
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: spyAi().ai, EXTRACTION_EVAL: "1" }),
		);
		expect(res.status).toBe(400);
	});

	it("cases が配列でなければ 400", async () => {
		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: JSON.stringify({ cases: "x" }),
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: spyAi().ai, EXTRACTION_EVAL: "1" }),
		);
		expect(res.status).toBe(400);
	});

	it("golden ケースが不正（html 欠落）なら 400（AI を呼ぶ前に弾く）", async () => {
		const spy = spyAi();
		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: JSON.stringify({ cases: [{ name: "x" }] }),
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: spy.ai, EXTRACTION_EVAL: "1" }),
		);
		expect(res.status).toBe(400);
		expect(spy.calls()).toBe(0);
	});

	it("正常系: 候補を横並び評価し ModelSelection を返す（fake AI 注入）", async () => {
		// baseline（json-mode）が満点になる入力を fake が返す。FC 候補は tool_calls 不在で 0 点。
		const matching = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		const fake = jsonModeAi({ annualSalary: "700万〜900万" });
		const goldenCase = {
			name: "c1",
			html: "<p>年収 700万〜900万</p>",
			expected: { annualSalary: matching.annualSalary },
		};

		const res = await app.request(
			"/api/_eval-models",
			{
				method: "POST",
				body: JSON.stringify({ cases: [goldenCase] }),
				headers: { "content-type": "application/json" },
			},
			evalEnv({ AI: fake.ai, EXTRACTION_EVAL: "1" }),
		);

		expect(res.status).toBe(200);
		const selection = (await res.json()) as {
			baselineModel: string;
			selectedModel: string;
			changed: boolean;
			comparisons: { candidateModel: string }[];
		};
		// 全候補ぶんの比較が返る。
		const candidateIds = EXTRACTION_MODEL_CANDIDATES.map((c) => c.id);
		expect(selection.comparisons.map((c) => c.candidateModel)).toEqual(
			candidateIds,
		);
		// baseline は env 解決値、勝者は据え置き（候補は同点 or 劣化のみ）。
		expect(typeof selection.baselineModel).toBe("string");
		expect(selection.selectedModel).toBe(selection.baselineModel);
		expect(selection.changed).toBe(false);
		// live 経路が実際に AI binding を叩いている。
		expect(fake.calls()).toBeGreaterThan(0);
	});
});
