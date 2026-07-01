import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
	AuthFetchError,
	buildCookieHeader,
	fetchAuthedHtml,
	parseCookiePairs,
} from "./fetch-authed-html";
import { type Fetcher, FetchHtmlError } from "./fetch-html";

const TARGET = "https://example.com/jobs/123";
// テスト用ダミー Cookie。実セッション値は決して埋め込まない（秘匿情報の非コミット）
const DUMMY_COOKIE = "session=abc123; theme=dark";
// 検出対象の秘匿断片。漏洩検査はこの値を例外チェーン全体から探す
const SECRET = "abc123";

// 例外チェーン（message + cause 連鎖 + 列挙プロパティ）に秘匿値が現れないことを保証する。
// Error.cause は non-enumerable のため JSON.stringify では見えない。inspect で深く辿る。
function assertNoSecret(error: unknown): void {
	expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
}

describe("buildCookieHeader", () => {
	// 生 Cookie ヘッダ文字列はそのまま採用しつつ前後空白だけ整える（RFC6265 OWS）
	it("単一の生 Cookie 文字列を受け取り前後空白を除いて返す", () => {
		expect(buildCookieHeader("  session=abc123  ")).toEqual({
			ok: true,
			value: "session=abc123",
		});
	});

	// name=value ペア配列は "; "（semicolon + SP）で連結する（RFC6265 cookie-string）
	it("ペア配列を semicolon+space で連結する", () => {
		expect(
			buildCookieHeader([
				{ name: "session", value: "abc123" },
				{ name: "theme", value: "dark" },
			]),
		).toEqual({ ok: true, value: "session=abc123; theme=dark" });
	});

	// 空入力・空白のみは認証情報なしとして弾く（無駄な認証付き取得を避ける）
	it("空文字・空白のみは reason=empty で弾く", () => {
		expect(buildCookieHeader("")).toEqual({ ok: false, reason: "empty" });
		expect(buildCookieHeader("   ")).toEqual({ ok: false, reason: "empty" });
		expect(buildCookieHeader([])).toEqual({ ok: false, reason: "empty" });
	});

	// CR/LF を含む値はヘッダインジェクションの恐れがあるため拒否する
	it("CR/LF を含む生文字列は reason=invalid で弾く（ヘッダインジェクション防止）", () => {
		expect(buildCookieHeader("session=abc\r\nX-Evil: 1")).toEqual({
			ok: false,
			reason: "invalid",
		});
		// 中間の改行は trim で消えないため確実に弾く（前後の改行は OWS として整形される）
		expect(buildCookieHeader("a=1\nb=2")).toEqual({
			ok: false,
			reason: "invalid",
		});
		// NUL 等 CR/LF 以外の制御文字も弾く（fetch の TypeError 経由 Cookie 漏洩を防ぐ）
		expect(buildCookieHeader("session=abc123\x00")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	// ペアの name は token、value は cookie-octet 準拠でなければ拒否する（RFC6265 §4.1.1）
	it("不正な name/value のペアは reason=invalid で弾く", () => {
		// value に semicolon（区切り文字）
		expect(buildCookieHeader([{ name: "session", value: "a;b" }])).toEqual({
			ok: false,
			reason: "invalid",
		});
		// value に空白
		expect(buildCookieHeader([{ name: "session", value: "a b" }])).toEqual({
			ok: false,
			reason: "invalid",
		});
		// name が空
		expect(buildCookieHeader([{ name: "", value: "x" }])).toEqual({
			ok: false,
			reason: "invalid",
		});
		// name に区切り文字
		expect(buildCookieHeader([{ name: "a=b", value: "x" }])).toEqual({
			ok: false,
			reason: "invalid",
		});
	});
});

describe("parseCookiePairs", () => {
	// 生 Cookie 文字列を name/value ペアへ分解する（BR の page.setCookie 用）
	it("生 Cookie 文字列を name/value ペア配列へ分解する", () => {
		expect(parseCookiePairs("session=abc123; theme=dark")).toEqual({
			ok: true,
			pairs: [
				{ name: "session", value: "abc123" },
				{ name: "theme", value: "dark" },
			],
		});
	});

	// 前後 OWS や要素間の空白は整えて分解する
	it("前後・区切りの空白を整えて分解する", () => {
		expect(parseCookiePairs("  a=1 ;  b=2  ")).toEqual({
			ok: true,
			pairs: [
				{ name: "a", value: "1" },
				{ name: "b", value: "2" },
			],
		});
	});

	// value に "=" を含む場合は最初の "=" だけで name/value を割る
	it("最初の = のみで割り value 内の = は保持する", () => {
		expect(parseCookiePairs("token=a=b=c")).toEqual({
			ok: true,
			pairs: [{ name: "token", value: "a=b=c" }],
		});
	});

	// ペア配列はそのまま検証して返す（buildCookieHeader と同じ RFC6265 検証）
	it("ペア配列は検証して返す", () => {
		expect(
			parseCookiePairs([
				{ name: "session", value: "abc123" },
				{ name: "theme", value: "dark" },
			]),
		).toEqual({
			ok: true,
			pairs: [
				{ name: "session", value: "abc123" },
				{ name: "theme", value: "dark" },
			],
		});
	});

	// 空入力は reason=empty（無駄な setCookie を避ける）
	it("空文字・空白のみ・空配列は reason=empty で弾く", () => {
		expect(parseCookiePairs("")).toEqual({ ok: false, reason: "empty" });
		expect(parseCookiePairs("   ")).toEqual({ ok: false, reason: "empty" });
		expect(parseCookiePairs([])).toEqual({ ok: false, reason: "empty" });
	});

	// "=" を含まない要素・空 name は分解不能として弾く
	it("= を含まない要素や空 name は reason=invalid で弾く", () => {
		expect(parseCookiePairs("session")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(parseCookiePairs("=abc123")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	// 制御文字・不正な value は拒否する（注入・漏洩経路の遮断）
	it("制御文字や不正な value を含む入力は reason=invalid で弾く", () => {
		expect(parseCookiePairs("session=abc123\r\nX-Evil: 1")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(parseCookiePairs("session=abc123\x00")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	// 失敗時は理由だけを返し、生値を戻り値に載せない（最小保持）
	it("失敗時に生 Cookie 値を戻り値へ載せない", () => {
		const result = parseCookiePairs(`session=${SECRET}\x00`);
		expect(result.ok).toBe(false);
		assertNoSecret(result);
	});
});

describe("fetchAuthedHtml", () => {
	// Cookie ヘッダを付与して取得し、成功時は本文をそのまま返す
	it("Cookie ヘッダを付与して取得し HTML を返す", async () => {
		const html = "<html><body>authed job</body></html>";
		const fetcher = vi.fn<Fetcher>(
			async () => new Response(html, { status: 200 }),
		);

		const result = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, { fetcher });

		expect(result).toEqual({ url: TARGET, status: 200, html });
		const [, init] = fetcher.mock.calls[0];
		// 取得リクエストには Cookie ヘッダが載る（大文字小文字を問わず検査）
		const headers = new Headers(init?.headers);
		expect(headers.get("cookie")).toBe("session=abc123; theme=dark");
	});

	// 401/403 は認証失敗として AuthFetchError(kind=auth) に分類する（#26 が失効を判別できる）
	it("401 は kind=auth の AuthFetchError へ分類する", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("unauthorized", { status: 401 }),
		);

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("auth");
		expect(error.status).toBe(401);
		expect(error.url).toBe(TARGET);
	});

	it("403 も kind=auth の AuthFetchError へ分類する", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("forbidden", { status: 403 }),
		);

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("auth");
		expect(error.status).toBe(403);
	});

	// 401/403 以外の HTTP エラーは取得層の FetchHtmlError をそのまま透過する
	it("404 は FetchHtmlError(kind=http) のまま透過する", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("not found", { status: 404 }),
		);

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(FetchHtmlError);
		expect(error).not.toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("http");
		expect(error.status).toBe(404);
	});

	// 不正な Cookie 入力は取得前に弾く（無駄な認証付き取得・インジェクション防止）
	it("不正な Cookie 入力は取得を呼ばず AuthFetchError(kind=invalid-credential) を投げる", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("ok", { status: 200 }),
		);

		const error = await fetchAuthedHtml(TARGET, "bad=cookie\r\ninject", {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("invalid-credential");
		expect(fetcher).not.toHaveBeenCalled();
	});

	// 最小保持: 取得結果に Cookie を一切含めない
	it("取得結果オブジェクトに Cookie 値を含めない（最小保持）", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("<html></html>", { status: 200 }),
		);

		const result = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, { fetcher });

		expect(JSON.stringify(result)).not.toContain("abc123");
	});

	// 最小保持: 認証失敗エラーの message / 直列化に Cookie 値を含めない（ログ漏洩防止）
	it("AuthFetchError は Cookie 値を message に埋め込まない（ログ漏洩防止）", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("unauthorized", { status: 401 }),
		);

		const error: AuthFetchError = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error.message).not.toContain(SECRET);
		// cause 連鎖まで含めて秘匿値が残らないことを検査する
		assertNoSecret(error);
	});

	// 最小保持: ネットワーク失敗時の例外にも Cookie 値を含めない
	it("ネットワーク失敗の例外にも Cookie 値を含めない（最小保持）", async () => {
		const cause = new TypeError("dns failure");
		const fetcher = vi.fn<Fetcher>(async () => {
			throw cause;
		});

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(FetchHtmlError);
		// cause 連鎖まで含めて秘匿値が残らないことを検査する
		assertNoSecret(error);
	});

	// 最小保持の回帰防止: 制御文字入り Cookie は取得前に弾き、秘匿値を例外へ載せない。
	// （素通しすると fetch の TypeError.message に Cookie 生値が載り cause 経由で漏れる）
	it("制御文字入り Cookie は取得を呼ばず秘匿値を漏らさない", async () => {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response("ok", { status: 200 }),
		);

		const error = await fetchAuthedHtml(TARGET, `session=${SECRET}\x00`, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("invalid-credential");
		expect(fetcher).not.toHaveBeenCalled();
		assertNoSecret(error);
	});

	// 取得層へタイムアウト等のオプションを委譲する
	it("timeoutMs を取得層へ委譲する", async () => {
		const fetcher: Fetcher = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
			timeoutMs: 5,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(FetchHtmlError);
		expect(error.kind).toBe("timeout");
	});
});

// redirect セキュリティ: 認証下取得は Cookie を認可済みオリジン以外へ送ってはならない。
// 取得層の redirect:"follow" は 3xx で別ホストへ Cookie を再送しうるため、認証層では
// manual 追従し同一オリジンに限定する（cross-origin は追従せず Cookie を渡さない）。
describe("fetchAuthedHtml redirect 安全性", () => {
	const url = (input: string | URL): string =>
		typeof input === "string" ? input : input.toString();

	// 同一オリジンの redirect は認可済みなので Cookie を保持して追従し最終ページを返す
	it("同一オリジンの redirect を Cookie 付きで追従し最終 HTML を返す", async () => {
		const FINAL = "https://example.com/jobs/123/final";
		const fetcher = vi.fn<Fetcher>(async (input) =>
			url(input) === TARGET
				? new Response(null, { status: 302, headers: { location: FINAL } })
				: new Response("<html>final</html>", { status: 200 }),
		);

		const result = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, { fetcher });

		expect(result.status).toBe(200);
		expect(result.html).toBe("<html>final</html>");
		// 追従は手動制御（runtime 任せにせず origin を検査するため）
		expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
		// 同一オリジンの追従先には Cookie を再送する（認可済みオリジンなので安全）
		expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("cookie")).toBe(
			"session=abc123; theme=dark",
		);
	});

	// クロスオリジンの redirect では Cookie を渡さず、追従先を一度も fetch しない（漏洩防止）
	it("クロスオリジンの redirect は Cookie を送らず追従せず kind=redirect で弾く", async () => {
		const EVIL = "https://evil.example.org/steal";
		const fetcher = vi.fn<Fetcher>(
			async () =>
				new Response(null, { status: 302, headers: { location: EVIL } }),
		);

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("redirect");
		// 別オリジンの追従先へは一度も fetch しない＝Cookie を渡さない
		expect(fetcher).toHaveBeenCalledTimes(1);
		assertNoSecret(error);
	});

	// scheme 差（https→http ダウングレード）も別オリジンとして弾く
	it("scheme ダウングレードの redirect も Cookie を送らず弾く", async () => {
		const DOWNGRADE = "http://example.com/jobs/123";
		const fetcher = vi.fn<Fetcher>(
			async () =>
				new Response(null, { status: 302, headers: { location: DOWNGRADE } }),
		);

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("redirect");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	// 同一オリジンでも redirect が上限を超えたら打ち切る（無限ループ防止）
	it("redirect が上限を超えたら kind=redirect で打ち切る", async () => {
		let n = 0;
		const fetcher = vi.fn<Fetcher>(async () => {
			n += 1;
			return new Response(null, {
				status: 302,
				headers: { location: `https://example.com/hop/${n}` },
			});
		});

		const error = await fetchAuthedHtml(TARGET, DUMMY_COOKIE, {
			fetcher,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(AuthFetchError);
		expect(error.kind).toBe("redirect");
		assertNoSecret(error);
	});
});
