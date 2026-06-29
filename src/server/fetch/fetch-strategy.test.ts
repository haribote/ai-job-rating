import { describe, expect, it, vi } from "vitest";
import { RenderHtmlError, type RenderHtmlResult } from "../render-html";
import { FetchHtmlError, type FetchHtmlResult } from "./fetch-html";
import {
	type FetchHtmlFn,
	fetchWithStrategy,
	isLikelySpa,
	isTransientFetchError,
	isTransientRenderError,
	type RenderHtmlFn,
} from "./fetch-strategy";

// 本文の多い SSR ページ。BR を呼ぶ必要がない（コスト最小化）。
const SSR_HTML = `<!doctype html><html><body><main>
${"応募資格 必須要件 歓迎要件 年収 600万円 勤務地 東京 リモート可 福利厚生 各種社会保険完備 ".repeat(8)}
</main></body></html>`;

// 未描画 SPA シェル。空の root と module バンドルだけで可視テキストがほとんどない。
const SPA_SHELL_HTML = `<!doctype html><html><head>
<script type="module" src="/assets/index-abc123.js"></script>
</head><body><div id="root"></div></body></html>`;

describe("isLikelySpa", () => {
	// 本文が十分にある SSR ページは SPA とみなさない（BR 不要）
	it("本文の多い SSR ページは false", () => {
		expect(isLikelySpa(SSR_HTML)).toBe(false);
	});

	// 空 root + module バンドルだけの未描画シェルは SPA とみなす
	it("空 root と module バンドルだけのシェルは true", () => {
		expect(isLikelySpa(SPA_SHELL_HTML)).toBe(true);
	});

	// 可視テキストが乏しくても SPA マウント痕跡が無ければ false（誤判定で BR を呼ばない）
	it("マウント痕跡の無い空ページは false", () => {
		expect(isLikelySpa("<html><body><p>少しだけ</p></body></html>")).toBe(
			false,
		);
	});

	// しきい値はフォーク先が上書きできる
	it("minTextChars を上げると短い SSR も SPA 判定になりうる", () => {
		const shortSsr = `<html><body><div id="app"></div><p>${"あ".repeat(50)}</p></body></html>`;
		expect(isLikelySpa(shortSsr, 10)).toBe(false);
		expect(isLikelySpa(shortSsr, 1000)).toBe(true);
	});
});

describe("isTransientFetchError", () => {
	// network/timeout は時間を置けば回復しうる（再試行対象）
	it("network と timeout は true", () => {
		expect(
			isTransientFetchError(
				new FetchHtmlError({ kind: "network", url: "u", message: "m" }),
			),
		).toBe(true);
		expect(
			isTransientFetchError(
				new FetchHtmlError({ kind: "timeout", url: "u", message: "m" }),
			),
		).toBe(true);
	});

	// 5xx（502/503/504）は一過性として再試行対象
	it("5xx は true", () => {
		for (const status of [500, 502, 503, 504]) {
			expect(
				isTransientFetchError(
					new FetchHtmlError({ kind: "http", status, url: "u", message: "m" }),
				),
			).toBe(true);
		}
	});

	// 4xx は恒久失敗。再試行しない（無駄に叩かない）
	it("4xx は false", () => {
		expect(
			isTransientFetchError(
				new FetchHtmlError({
					kind: "http",
					status: 404,
					url: "u",
					message: "m",
				}),
			),
		).toBe(false);
	});

	// FetchHtmlError 以外は対象外
	it("FetchHtmlError 以外は false", () => {
		expect(isTransientFetchError(new Error("other"))).toBe(false);
	});
});

describe("isTransientRenderError", () => {
	// 起動失敗（同時実行枠超過）は時間を置けば回復しうる
	it("launch は true", () => {
		expect(
			isTransientRenderError(
				new RenderHtmlError({ kind: "launch", url: "u", message: "m" }),
			),
		).toBe(true);
	});

	// render/timeout は対象外（再試行しても改善しないことが多い）
	it("render と timeout は false", () => {
		expect(
			isTransientRenderError(
				new RenderHtmlError({ kind: "render", url: "u", message: "m" }),
			),
		).toBe(false);
		expect(
			isTransientRenderError(
				new RenderHtmlError({ kind: "timeout", url: "u", message: "m" }),
			),
		).toBe(false);
	});
});

const URL = "https://example.com/jobs/1";

function okFetch(html: string): FetchHtmlFn {
	return vi.fn(
		async (url: string): Promise<FetchHtmlResult> => ({
			url,
			status: 200,
			html,
		}),
	);
}

function okRender(html: string): RenderHtmlFn {
	return vi.fn(
		async (_binding: unknown, url: string): Promise<RenderHtmlResult> => ({
			url,
			status: 200,
			html,
		}),
	);
}

describe("fetchWithStrategy", () => {
	// SSR で本文が取れれば BR を呼ばずに fetch 結果を返す（コスト最小化の本丸）
	it("SSR は fetch のみで完結し render を呼ばない", async () => {
		const fetchHtmlFn = okFetch(SSR_HTML);
		const renderHtmlFn = okRender("<rendered/>");
		const result = await fetchWithStrategy(URL, {
			browser: {},
			fetchHtmlFn,
			renderHtmlFn,
		});
		expect(result.source).toBe("fetch");
		expect(result.html).toBe(SSR_HTML);
		expect(renderHtmlFn).not.toHaveBeenCalled();
	});

	// SPA シェルを検出したら BR にフォールバックしレンダリング後 HTML を返す
	it("SPA シェルは render にフォールバックする", async () => {
		const fetchHtmlFn = okFetch(SPA_SHELL_HTML);
		const renderHtmlFn = okRender(
			"<html><body>rendered job detail</body></html>",
		);
		const result = await fetchWithStrategy(URL, {
			browser: {},
			fetchHtmlFn,
			renderHtmlFn,
		});
		expect(result.source).toBe("render");
		expect(result.html).toContain("rendered job detail");
		expect(renderHtmlFn).toHaveBeenCalledTimes(1);
	});

	// BR バインディング未提供なら SPA でも BR せず取得済み HTML を返す（フォーク/テスト容易性）
	it("browser 未指定なら SPA でも fetch 結果を返す", async () => {
		const fetchHtmlFn = okFetch(SPA_SHELL_HTML);
		const renderHtmlFn = okRender("<rendered/>");
		const result = await fetchWithStrategy(URL, { fetchHtmlFn, renderHtmlFn });
		expect(result.source).toBe("fetch");
		expect(renderHtmlFn).not.toHaveBeenCalled();
	});

	// 一過性 fetch 失敗はバックオフ再試行し、回復したら成功を返す
	it("transient な fetch 失敗は再試行して回復する", async () => {
		const sleep = vi.fn(async () => {});
		let calls = 0;
		const fetchHtmlFn = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
			calls += 1;
			if (calls === 1) {
				throw new FetchHtmlError({
					kind: "http",
					status: 504,
					url,
					message: "gateway timeout",
				});
			}
			return { url, status: 200, html: SSR_HTML };
		});
		const result = await fetchWithStrategy(URL, {
			fetchHtmlFn,
			retries: 2,
			baseDelayMs: 10,
			sleep,
		});
		expect(result.source).toBe("fetch");
		expect(fetchHtmlFn).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	// 恒久 fetch 失敗（4xx）は再試行せず即座に throw する
	it("4xx の fetch 失敗は再試行せず投げる", async () => {
		const sleep = vi.fn(async () => {});
		const fetchHtmlFn = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
			throw new FetchHtmlError({
				kind: "http",
				status: 404,
				url,
				message: "not found",
			});
		});
		await expect(
			fetchWithStrategy(URL, {
				fetchHtmlFn,
				retries: 3,
				baseDelayMs: 10,
				sleep,
			}),
		).rejects.toMatchObject({ kind: "http", status: 404 });
		expect(fetchHtmlFn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	// BR 起動の一過性失敗もバックオフ再試行する
	it("render の launch 失敗は再試行して回復する", async () => {
		const sleep = vi.fn(async () => {});
		const fetchHtmlFn = okFetch(SPA_SHELL_HTML);
		let calls = 0;
		const renderHtmlFn = vi.fn(
			async (_binding: unknown, url: string): Promise<RenderHtmlResult> => {
				calls += 1;
				if (calls === 1) {
					throw new RenderHtmlError({
						kind: "launch",
						url,
						message: "browser limit",
					});
				}
				return { url, status: 200, html: "<body>rendered job detail</body>" };
			},
		);
		const result = await fetchWithStrategy(URL, {
			browser: {},
			fetchHtmlFn,
			renderHtmlFn,
			retries: 2,
			baseDelayMs: 10,
			sleep,
		});
		expect(result.source).toBe("render");
		expect(renderHtmlFn).toHaveBeenCalledTimes(2);
	});
});
