import { describe, expect, it } from "vitest";
import { ApiRequestError, buildApiUrl, createApiClient } from "./api";

// fetch を差し替えて決定的に検証するための記録付きフェイク。
// 呼び出し URL / init を捕捉し、用意したレスポンスを返す。
function fakeFetch(response: Response) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve(response);
	};
	return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("buildApiUrl", () => {
	it("先頭スラッシュ付きパスを /api 配下へ前置する", () => {
		expect(buildApiUrl("/ranking")).toBe("/api/ranking");
	});

	it("先頭スラッシュ無しパスも吸収して /api 配下へ寄せる", () => {
		expect(buildApiUrl("ranking")).toBe("/api/ranking");
	});

	it("ネストしたパスを保持する", () => {
		expect(buildApiUrl("/jobs/abc123")).toBe("/api/jobs/abc123");
	});
});

describe("createApiClient", () => {
	it("get は /api 配下へ GET し JSON を型付きで返す", async () => {
		const { impl, calls } = fakeFetch(jsonResponse({ jobs: [], excluded: [] }));
		const client = createApiClient(impl);

		const result = await client.get<{ jobs: unknown[]; excluded: unknown[] }>(
			"/ranking",
		);

		expect(result).toEqual({ jobs: [], excluded: [] });
		expect(calls[0].url).toBe("/api/ranking");
		expect(calls[0].init?.method).toBe("GET");
		// body の無い GET には content-type を付けない
		expect(calls[0].init?.body).toBeUndefined();
	});

	it("post は JSON body と content-type を付けて POST する", async () => {
		const { impl, calls } = fakeFetch(
			jsonResponse({ jobId: "j1", status: "stored" }, 201),
		);
		const client = createApiClient(impl);

		await client.post("/jobs", { url: "https://example.com/job/1" });

		expect(calls[0].url).toBe("/api/jobs");
		expect(calls[0].init?.method).toBe("POST");
		expect(
			(calls[0].init?.headers as Record<string, string>)["content-type"],
		).toBe("application/json");
		expect(calls[0].init?.body).toBe(
			JSON.stringify({ url: "https://example.com/job/1" }),
		);
	});

	it("put は PUT メソッドで body を送る", async () => {
		const { impl, calls } = fakeFetch(
			jsonResponse({ status: "rescored", count: 3 }),
		);
		const client = createApiClient(impl);

		await client.put("/config", [{ key: "weight", value: 1 }]);

		expect(calls[0].url).toBe("/api/config");
		expect(calls[0].init?.method).toBe("PUT");
		expect(calls[0].init?.body).toBe(
			JSON.stringify([{ key: "weight", value: 1 }]),
		);
	});

	it("body 無しの POST には content-type を付けない（再抽出など）", async () => {
		const { impl, calls } = fakeFetch(jsonResponse({ status: "queued" }, 202));
		const client = createApiClient(impl);

		await client.post("/jobs/abc/reextract");

		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].init?.body).toBeUndefined();
		expect(calls[0].init?.headers).toBeUndefined();
	});

	it("非 2xx は契約の {error,reason} を ApiRequestError へ整形して投げる", async () => {
		const { impl } = fakeFetch(
			jsonResponse({ error: "invalid config", reason: "weights" }, 400),
		);
		const client = createApiClient(impl);

		await expect(client.put("/config", {})).rejects.toMatchObject({
			name: "ApiRequestError",
			status: 400,
			code: "invalid config",
			reason: "weights",
		});
	});

	it("reason 無しのエラーボディは reason を undefined にする", async () => {
		const { impl } = fakeFetch(jsonResponse({ error: "not found" }, 404));
		const client = createApiClient(impl);

		const err = await client.get("/jobs/missing").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect((err as ApiRequestError).status).toBe(404);
		expect((err as ApiRequestError).code).toBe("not found");
		expect((err as ApiRequestError).reason).toBeUndefined();
	});

	it("JSON でないエラーボディは汎用コード http_<status> へフォールバックする", async () => {
		const { impl } = fakeFetch(
			new Response("Internal Server Error", { status: 500 }),
		);
		const client = createApiClient(impl);

		const err = await client.get("/ranking").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect((err as ApiRequestError).status).toBe(500);
		expect((err as ApiRequestError).code).toBe("http_500");
		expect((err as ApiRequestError).reason).toBeUndefined();
	});
});
