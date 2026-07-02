import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CookieKv,
	DEFAULT_AUTH_COOKIE_TTL_SECONDS,
	deleteAllCookies,
	deleteCookie,
	loadCookie,
	MIN_AUTH_COOKIE_TTL_SECONDS,
	originOf,
	resolveAuthCookieTtlSeconds,
	resolveJobCookie,
	saveCookie,
} from "./cookie-store";

// テストごとに Cookie ストアを空にする（miniflare 実 KV は run 間で残るため）。
async function clearCookies(): Promise<void> {
	const { keys } = await env.AUTH_COOKIES.list();
	for (const k of keys) await env.AUTH_COOKIES.delete(k.name);
}

beforeEach(clearCookies);

describe("originOf", () => {
	it("正常な URL は origin を返す（path/query は捨てる）", () => {
		expect(originOf("https://example.com/jobs/1?x=1")).toBe(
			"https://example.com",
		);
		expect(originOf("http://example.com:8080/a")).toBe(
			"http://example.com:8080",
		);
	});
	it("不正な入力は null（決定的・純関数）", () => {
		expect(originOf("not a url")).toBeNull();
		expect(originOf("")).toBeNull();
	});
});

describe("saveCookie / loadCookie（origin 単位・往復）", () => {
	it("保存した Cookie を同一 origin の別 path で引ける", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"https://example.com/jobs",
			"session=abc123",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		// 一覧 URL とは別 path の詳細 URL でも同一 origin なら同じキーで引ける。
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://example.com/jobs/42"),
		).toBe("session=abc123");
	});

	it("未保存 origin は null", async () => {
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://example.com/jobs/1"),
		).toBeNull();
	});

	it("別 origin では Cookie を引かない（cross-origin 再送防止）", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"https://example.com/jobs",
			"session=abc123",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://evil.example.net/jobs/1"),
		).toBeNull();
	});

	it("origin 解決不能な URL は保存も読み出しも no-op（例外を投げない）", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"not a url",
			"session=abc123",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(await loadCookie(env.AUTH_COOKIES, "not a url")).toBeNull();
	});
});

describe("saveCookie（TTL 指定）", () => {
	it("put に expirationTtl を渡す（失効挙動は live スモークで確認）", async () => {
		const put = vi.fn(async () => {});
		const kv: CookieKv = {
			get: async () => null,
			put,
			delete: async () => {},
			list: async () => ({ keys: [], list_complete: true }),
		};
		await saveCookie(kv, "https://example.com/jobs", "session=abc", 21600);
		expect(put).toHaveBeenCalledWith(
			"auth-cookie:https://example.com",
			"session=abc",
			{ expirationTtl: 21600 },
		);
	});
});

describe("deleteCookie / deleteAllCookies", () => {
	it("delete 後は null・実削除は 1 を返す", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"https://example.com/jobs",
			"session=abc123",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(
			await deleteCookie(env.AUTH_COOKIES, "https://example.com/jobs/1"),
		).toBe(1);
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://example.com/jobs/1"),
		).toBeNull();
	});

	it("未保存 origin・不正 URL の delete は 0（cleanup 応答の count を正直にする）", async () => {
		expect(
			await deleteCookie(env.AUTH_COOKIES, "https://none.example.com/x"),
		).toBe(0);
		expect(await deleteCookie(env.AUTH_COOKIES, "not a url")).toBe(0);
	});

	it("deleteAllCookies は KV list を cursor で辿り全ページ消す", async () => {
		// 実 KV で 1000 件超を作らず、2 ページに分かれる list をモックして cursor 追従を検証する。
		const deleted: string[] = [];
		const kv: CookieKv = {
			get: async () => null,
			put: async () => {},
			delete: async (key) => {
				deleted.push(key);
			},
			list: async (options) =>
				options?.cursor === undefined
					? {
							keys: [{ name: "auth-cookie:https://a.example.com" }],
							list_complete: false,
							cursor: "next",
						}
					: {
							keys: [{ name: "auth-cookie:https://b.example.com" }],
							list_complete: true,
						},
		};
		expect(await deleteAllCookies(kv)).toBe(2);
		expect(deleted).toEqual([
			"auth-cookie:https://a.example.com",
			"auth-cookie:https://b.example.com",
		]);
	});

	it("deleteAllCookies は prefix 全消し件数を返す", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"https://a.example.com/jobs",
			"s=1",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		await saveCookie(
			env.AUTH_COOKIES,
			"https://b.example.com/jobs",
			"s=2",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		const count = await deleteAllCookies(env.AUTH_COOKIES);
		expect(count).toBe(2);
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://a.example.com/x"),
		).toBeNull();
		expect(
			await loadCookie(env.AUTH_COOKIES, "https://b.example.com/x"),
		).toBeNull();
	});

	it("空ストアの deleteAllCookies は 0", async () => {
		expect(await deleteAllCookies(env.AUTH_COOKIES)).toBe(0);
	});
});

describe("resolveAuthCookieTtlSeconds", () => {
	it("未設定は既定", () => {
		expect(resolveAuthCookieTtlSeconds(undefined)).toBe(
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
	});
	it("正の整数はそのまま採用", () => {
		expect(resolveAuthCookieTtlSeconds("3600")).toBe(3600);
	});
	it("不正値は既定へフォールバック", () => {
		expect(resolveAuthCookieTtlSeconds("abc")).toBe(
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(resolveAuthCookieTtlSeconds("-1")).toBe(
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(resolveAuthCookieTtlSeconds("1.5")).toBe(
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
	});
	it("KV 最小 TTL 未満はクランプする", () => {
		expect(resolveAuthCookieTtlSeconds("10")).toBe(MIN_AUTH_COOKIE_TTL_SECONDS);
	});
});

describe("resolveJobCookie（consumer 用・null を undefined へ正規化）", () => {
	it("保存ありは string を返す", async () => {
		await saveCookie(
			env.AUTH_COOKIES,
			"https://example.com/jobs",
			"session=abc123",
			DEFAULT_AUTH_COOKIE_TTL_SECONDS,
		);
		expect(
			await resolveJobCookie(env.AUTH_COOKIES, "https://example.com/jobs/1"),
		).toBe("session=abc123");
	});
	it("未保存/失効は undefined（中立取得へ倒す）", async () => {
		expect(
			await resolveJobCookie(env.AUTH_COOKIES, "https://example.com/jobs/1"),
		).toBeUndefined();
	});
});
