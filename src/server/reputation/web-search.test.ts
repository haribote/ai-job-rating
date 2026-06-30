import { describe, expect, it, vi } from "vitest";
import {
	buildReputationPrompt,
	createClaudeReputationClient,
	DEFAULT_REPUTATION_MAX_AGE_SECONDS,
	DEFAULT_REPUTATION_MODEL,
	extractTextFromAnthropicResponse,
	NULL_REPUTATION_CLIENT,
	parseReputationResult,
	resolveReputationMaxAgeSeconds,
	resolveReputationModel,
} from "./web-search";

// Anthropic Messages API の応答 body を最小で組む（text ブロックに JSON を載せる）。
function anthropicBody(text: string): unknown {
	return { content: [{ type: "text", text }] };
}

describe("resolveReputationModel", () => {
	it("未設定/空白はコード既定へフォールバックする", () => {
		expect(resolveReputationModel(undefined)).toBe(DEFAULT_REPUTATION_MODEL);
		expect(resolveReputationModel("   ")).toBe(DEFAULT_REPUTATION_MODEL);
	});
	it("指定値は trim して採用する", () => {
		expect(resolveReputationModel("  claude-opus-4-7 ")).toBe(
			"claude-opus-4-7",
		);
	});
});

describe("resolveReputationMaxAgeSeconds", () => {
	it("未設定/不正は既定へフォールバックする", () => {
		expect(resolveReputationMaxAgeSeconds(undefined)).toBe(
			DEFAULT_REPUTATION_MAX_AGE_SECONDS,
		);
		expect(resolveReputationMaxAgeSeconds("abc")).toBe(
			DEFAULT_REPUTATION_MAX_AGE_SECONDS,
		);
		expect(resolveReputationMaxAgeSeconds("-1")).toBe(
			DEFAULT_REPUTATION_MAX_AGE_SECONDS,
		);
		expect(resolveReputationMaxAgeSeconds("1.5")).toBe(
			DEFAULT_REPUTATION_MAX_AGE_SECONDS,
		);
	});
	it("非負整数は採用する（0 も含む）", () => {
		expect(resolveReputationMaxAgeSeconds("0")).toBe(0);
		expect(resolveReputationMaxAgeSeconds("3600")).toBe(3600);
	});
});

describe("buildReputationPrompt", () => {
	it("企業名を含み、法人番号があれば併記する", () => {
		const p = buildReputationPrompt({
			companyName: "テスト株式会社",
			houjinBangou: "1234567890123",
		});
		expect(p).toContain("テスト株式会社");
		expect(p).toContain("1234567890123");
	});
	it("法人番号が無ければ法人番号の併記を含めない", () => {
		const p = buildReputationPrompt({ companyName: "テスト株式会社" });
		expect(p).toContain("テスト株式会社");
		expect(p).not.toContain("法人番号:");
	});
});

describe("extractTextFromAnthropicResponse", () => {
	it("text ブロックのみを連結し、それ以外は無視する", () => {
		const body = {
			content: [
				{ type: "server_tool_use", name: "web_search" },
				{ type: "text", text: "あ" },
				{ type: "web_search_tool_result", content: [] },
				{ type: "text", text: "い" },
			],
		};
		expect(extractTextFromAnthropicResponse(body)).toBe("あい");
	});
	it("不正な body は空文字を返す", () => {
		expect(extractTextFromAnthropicResponse(null)).toBe("");
		expect(extractTextFromAnthropicResponse({})).toBe("");
		expect(extractTextFromAnthropicResponse({ content: "x" })).toBe("");
	});
});

describe("parseReputationResult", () => {
	it("素の JSON を構造化する", () => {
		const r = parseReputationResult(
			'{"overallScore":3.8,"reviewCount":120,"subScores":{"成長":4.0,"給与":3.5}}',
		);
		expect(r).toEqual({
			overallScore: 3.8,
			reviewCount: 120,
			subScores: { 成長: 4.0, 給与: 3.5 },
		});
	});

	it("コードフェンスや前後の説明文に頑健", () => {
		const text =
			'結果は以下です。\n```json\n{"overallScore":4.1,"reviewCount":5,"subScores":null}\n```\n以上。';
		const r = parseReputationResult(text);
		expect(r).toEqual({ overallScore: 4.1, reviewCount: 5, subScores: null });
	});

	it("JSON より前の散文に波括弧が紛れても正しい JSON を拾う", () => {
		const text =
			'評判の総括: {全体的に良好} 。以下が結果です:\n{"overallScore":3.9,"reviewCount":42,"subScores":null}';
		const r = parseReputationResult(text);
		expect(r).toEqual({ overallScore: 3.9, reviewCount: 42, subScores: null });
	});

	it("文字列値の中の波括弧で対応を誤らない", () => {
		const r = parseReputationResult(
			'{"note":"括弧 } を含む","overallScore":4.0}',
		);
		expect(r?.overallScore).toBe(4.0);
	});

	it("該当なし（全 null）は全フィールド null の結果として返す（negative cache）", () => {
		const r = parseReputationResult(
			'{"overallScore":null,"reviewCount":null,"subScores":null}',
		);
		expect(r).toEqual({
			overallScore: null,
			reviewCount: null,
			subScores: null,
		});
	});

	it("不正な値は検証/修復する（非数値→null・負の件数→null・小数の件数→切り捨て）", () => {
		const r = parseReputationResult(
			'{"overallScore":"high","reviewCount":-3,"subScores":{"a":"x","b":2.5}}',
		);
		expect(r).toEqual({
			overallScore: null,
			reviewCount: null,
			// 非数値の "a" は捨て、数値の "b" のみ残る。
			subScores: { b: 2.5 },
		});
	});

	it("小数の reviewCount は切り捨てる", () => {
		const r = parseReputationResult('{"reviewCount":99.9}');
		expect(r?.reviewCount).toBe(99);
	});

	it("subScores が空になれば null", () => {
		const r = parseReputationResult('{"subScores":{"a":"x"}}');
		expect(r?.subScores).toBeNull();
	});

	it("JSON が取り出せない/壊れている場合は null（取得失敗扱い・保存しない）", () => {
		expect(parseReputationResult("評判は見つかりませんでした")).toBeNull();
		expect(parseReputationResult("{壊れた")).toBeNull();
		expect(parseReputationResult("[1,2,3]")).toBeNull();
	});
});

describe("createClaudeReputationClient", () => {
	it("Messages API へ web_search ツールとモデルを正しく送る", async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json(anthropicBody('{"overallScore":4.0,"reviewCount":10}')),
		);
		const client = createClaudeReputationClient({
			apiKey: "sk-ant-test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const result = await client.search({ companyName: "テスト株式会社" });

		expect(result).toEqual({
			overallScore: 4.0,
			reviewCount: 10,
			subScores: null,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
			"sk-ant-test",
		);
		expect((init.headers as Record<string, string>)["anthropic-version"]).toBe(
			"2023-06-01",
		);
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe(DEFAULT_REPUTATION_MODEL);
		expect(body.tools).toEqual([
			{ type: "web_search_20260209", name: "web_search" },
		]);
	});

	it("非 2xx 応答は null（中立・保存しない）", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("rate limited", { status: 429 }),
		);
		const client = createClaudeReputationClient({
			apiKey: "sk-ant-test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(await client.search({ companyName: "テスト" })).toBeNull();
	});

	it("fetch 例外は null（中立・非ブロック）", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const client = createClaudeReputationClient({
			apiKey: "sk-ant-test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(await client.search({ companyName: "テスト" })).toBeNull();
	});

	it("キー空・企業名空は API を呼ばず null", async () => {
		const fetchImpl = vi.fn();
		const noKey = createClaudeReputationClient({
			apiKey: "  ",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(await noKey.search({ companyName: "テスト" })).toBeNull();
		const noName = createClaudeReputationClient({
			apiKey: "sk-ant-test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(await noName.search({ companyName: "   " })).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("NULL_REPUTATION_CLIENT", () => {
	it("常に null を返す（取得しない）", async () => {
		expect(
			await NULL_REPUTATION_CLIENT.search({ companyName: "テスト" }),
		).toBeNull();
	});
});
