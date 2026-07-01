import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserLauncher,
	type RenderBrowser,
	type RenderedPage,
	RenderHtmlError,
	renderHtml,
} from "./render-html";

const TARGET = "https://example.com/jobs/123";
// 検出対象の秘匿断片。漏洩検査はこの値を例外チェーン全体から探す
const SECRET = "super-secret-session-token";

// 例外チェーンに秘匿値が現れないことを保証する（cause 連鎖も inspect で深く辿る）。
function assertNoSecret(error: unknown): void {
	expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
}

// 実ブラウザ起動を避けるための最小 fake。goto→content のレンダリング後 HTML 取得経路だけを検証する。
function fakeLauncher(opts: {
	html?: string;
	onGoto?: (
		url: string,
		options?: { waitUntil?: string; timeout?: number },
	) => void | Promise<void>;
	onContent?: () => string | Promise<string>;
	onSetCookie?: () => void | Promise<void>;
}): {
	launch: BrowserLauncher;
	close: ReturnType<typeof vi.fn>;
	page: RenderedPage;
} {
	const close = vi.fn(async () => {});
	const page: RenderedPage = {
		setCookie: vi.fn(async () => {
			await opts.onSetCookie?.();
		}),
		goto: vi.fn(async (url: string, options) => {
			await opts.onGoto?.(url, options);
		}),
		content: vi.fn(async () =>
			opts.onContent
				? await opts.onContent()
				: (opts.html ?? "<html><body>rendered</body></html>"),
		),
	};
	const browser: RenderBrowser = {
		newPage: vi.fn(async () => page),
		close,
	};
	const launch: BrowserLauncher = vi.fn(async () => browser);
	return { launch, close, page };
}

// テストは実 binding を呼ばないので、スタンドインで十分。
const binding = {} as never;

describe("renderHtml", () => {
	// 取得層の責務はレンダリング後 HTML(text) をそのまま返すこと（トリミング・抽出はしない）
	it("レンダリング後の HTML 本文とステータスを返す", async () => {
		const html = "<html><body>SPA BODY</body></html>";
		const { launch } = fakeLauncher({ html });

		const result = await renderHtml(binding, TARGET, { launch });

		expect(result).toEqual({ url: TARGET, status: 200, html });
	});

	// 注入した launcher で対象 URL へ遷移し、ブラウザを確実に閉じることを担保する
	it("対象 URL へ遷移し、終了時にブラウザを閉じる", async () => {
		const { launch, close, page } = fakeLauncher({ html: "ok" });

		await renderHtml(binding, TARGET, { launch });

		expect(page.goto).toHaveBeenCalledTimes(1);
		const [calledUrl] = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(calledUrl).toBe(TARGET);
		expect(close).toHaveBeenCalledTimes(1);
	});

	// 暴走 SPA の安全弁として goto にタイムアウトを渡す
	it("goto にナビゲーションタイムアウトを渡す", async () => {
		let received: { waitUntil?: string; timeout?: number } | undefined;
		const { launch } = fakeLauncher({
			html: "ok",
			onGoto: (_url, options) => {
				received = options;
			},
		});

		await renderHtml(binding, TARGET, { launch, timeoutMs: 1234 });

		expect(received?.timeout).toBe(1234);
	});

	// 例外時もブラウザを閉じてセッションをリークさせない（従量課金・同時実行枠の保護）
	it("レンダリング失敗時もブラウザを閉じる", async () => {
		const { launch, close } = fakeLauncher({
			onContent: () => {
				throw new Error("content failed");
			},
		});

		await renderHtml(binding, TARGET, { launch }).catch(() => {});

		expect(close).toHaveBeenCalledTimes(1);
	});

	// ブラウザ起動失敗（同時実行枠超過・binding 不調）は kind=launch へ整形する
	it("ブラウザ起動失敗は kind=launch の RenderHtmlError を投げる", async () => {
		const cause = new Error("no available browser");
		const launch: BrowserLauncher = vi.fn(async () => {
			throw cause;
		});

		const error = await renderHtml(binding, TARGET, { launch }).catch((e) => e);
		expect(error).toBeInstanceOf(RenderHtmlError);
		expect(error.kind).toBe("launch");
		expect(error.url).toBe(TARGET);
		expect(error.cause).toBe(cause);
	});

	// ナビゲーション中断（タイムアウト）は kind=timeout へ整形する
	it("ナビゲーションタイムアウトは kind=timeout へ整形する", async () => {
		const cause = new Error("Navigation timeout of 1000 ms exceeded");
		const { launch } = fakeLauncher({
			onGoto: () => {
				throw cause;
			},
		});

		const error = await renderHtml(binding, TARGET, {
			launch,
			timeoutMs: 1000,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(RenderHtmlError);
		expect(error.kind).toBe("timeout");
		expect(error.url).toBe(TARGET);
	});

	// goto 等の非タイムアウト例外は kind=render へ整形し原因を cause に保持する
	it("レンダリング例外は kind=render の RenderHtmlError へ整形する", async () => {
		const cause = new Error("net::ERR_NAME_NOT_RESOLVED");
		const { launch } = fakeLauncher({
			onGoto: () => {
				throw cause;
			},
		});

		const error = await renderHtml(binding, TARGET, { launch }).catch((e) => e);
		expect(error).toBeInstanceOf(RenderHtmlError);
		expect(error.kind).toBe("render");
		expect(error.cause).toBe(cause);
	});

	// 認証下 SPA 用に Cookie を url 限定で投入する（cookie jar がドメイン一致時のみ送信＝クロスオリジン非再送）
	it("cookie 指定時、goto の前に url 限定で setCookie する", async () => {
		const { launch, page } = fakeLauncher({ html: "ok" });

		await renderHtml(binding, TARGET, {
			launch,
			cookie: [
				{ name: "session", value: "abc123" },
				{ name: "theme", value: "dark" },
			],
		});

		const setCookie = page.setCookie as ReturnType<typeof vi.fn>;
		expect(setCookie).toHaveBeenCalledTimes(1);
		// 各 cookie は url=対象URL・path="/" で投入する。path を明示しないと CDP が URL の
		// default-path（/jobs → 親ディレクトリ）へ絞り、別パスの XHR に届かず未ログイン化する。
		expect(setCookie.mock.calls[0]).toEqual([
			{ name: "session", value: "abc123", url: TARGET, path: "/" },
			{ name: "theme", value: "dark", url: TARGET, path: "/" },
		]);
		// goto より前に呼ぶ（描画前に cookie を効かせる）
		const goto = page.goto as ReturnType<typeof vi.fn>;
		expect(setCookie.mock.invocationCallOrder[0]).toBeLessThan(
			goto.mock.invocationCallOrder[0],
		);
	});

	// cookie 未指定は従来と完全一致（setCookie を呼ばない）
	it("cookie 未指定なら setCookie を呼ばない", async () => {
		const { launch, page } = fakeLauncher({ html: "ok" });

		await renderHtml(binding, TARGET, { launch });

		expect(page.setCookie as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	// setCookie 失敗時も cookie 生値を漏らさず kind=render へ整形する（最小保持）
	it("setCookie 失敗時に cookie 生値を漏らさず RenderHtmlError を投げる", async () => {
		const { launch, close } = fakeLauncher({
			onSetCookie: () => {
				throw new Error("setCookie failed");
			},
		});

		const error = await renderHtml(binding, TARGET, {
			launch,
			cookie: [{ name: "session", value: SECRET }],
		}).catch((e) => e);

		expect(error).toBeInstanceOf(RenderHtmlError);
		expect(error.kind).toBe("render");
		assertNoSecret(error);
		// 失敗時もブラウザを閉じる
		expect(close).toHaveBeenCalledTimes(1);
	});
});
