import { describe, expect, it, vi } from "vitest";
import { type Fetcher, FetchHtmlError, fetchHtml } from "./fetch-html";

const TARGET = "https://example.com/jobs/123";

describe("fetchHtml", () => {
	// 取得層の責務は HTML(text) をそのまま返すこと（トリミング・抽出はしない）
	it("2xx 応答は HTML 本文とステータスをそのまま返す", async () => {
		const html = "<html><body>job detail</body></html>";
		const fetcher: Fetcher = vi.fn(
			async () => new Response(html, { status: 200 }),
		);

		const result = await fetchHtml(TARGET, { fetcher });

		expect(result).toEqual({ url: TARGET, status: 200, html });
	});

	// 注入した fetcher に対象 URL と中断シグナルが渡ることを担保する
	it("注入した fetcher を対象 URL と AbortSignal 付きで呼ぶ", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("ok", { status: 200 }),
		);

		await fetchHtml(TARGET, { fetcher });

		expect(fetcher).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetcher.mock.calls[0];
		expect(calledUrl).toBe(TARGET);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	// 非 2xx は取得失敗。kind="http" とステータスを保持する
	it("非 2xx は kind=http の FetchHtmlError を投げる", async () => {
		const fetcher: Fetcher = vi.fn(
			async () => new Response("not found", { status: 404 }),
		);

		await expect(fetchHtml(TARGET, { fetcher })).rejects.toMatchObject({
			name: "FetchHtmlError",
			kind: "http",
			status: 404,
			url: TARGET,
		});
	});

	// 5xx も同様に http エラーとして整形する（境界の網羅）
	it("5xx も kind=http として整形する", async () => {
		const fetcher: Fetcher = vi.fn(
			async () => new Response("boom", { status: 503 }),
		);

		await expect(fetchHtml(TARGET, { fetcher })).rejects.toMatchObject({
			kind: "http",
			status: 503,
		});
	});

	// fetch 自体が失敗した場合（DNS 等）は network エラーへ整形し原因を cause に保持する
	it("fetch 例外は kind=network の FetchHtmlError へ整形する", async () => {
		const cause = new TypeError("dns failure");
		const fetcher: Fetcher = vi.fn(async () => {
			throw cause;
		});

		const error = await fetchHtml(TARGET, { fetcher }).catch((e) => e);
		expect(error).toBeInstanceOf(FetchHtmlError);
		expect(error.kind).toBe("network");
		expect(error.url).toBe(TARGET);
		expect(error.cause).toBe(cause);
	});

	// タイムアウト時は abort され kind=timeout へ整形される
	it("タイムアウトすると kind=timeout の FetchHtmlError を投げる", async () => {
		// signal.aborted を見て中断を再現する fetcher
		const fetcher: Fetcher = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});

		await expect(
			fetchHtml(TARGET, { fetcher, timeoutMs: 5 }),
		).rejects.toMatchObject({
			name: "FetchHtmlError",
			kind: "timeout",
			url: TARGET,
		});
	});
});
