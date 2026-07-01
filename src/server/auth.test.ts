import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "./auth";

// createAuthMiddleware の分岐を app から切り離して検証する（責務分離・#183）。
// ミニ Hono に middleware を挿し app.request() で env（AUTH_USER/AUTH_PASS）を差し替える。
function buildApp() {
	const app = new Hono<{
		Bindings: { AUTH_USER?: string; AUTH_PASS?: string };
	}>();
	app.use("*", createAuthMiddleware());
	// 全ルート保護を確認するため health もフォールスルーも両方生やす。
	app.get("/api/health", (c) => c.json({ status: "ok" }));
	app.get("/", (c) => c.text("spa"));
	return app;
}

// btoa は workerd・node 双方でグローバル。Basic 認証ヘッダを組む。
const basic = (user: string, pass: string) =>
	`Basic ${btoa(`${user}:${pass}`)}`;

describe("createAuthMiddleware", () => {
	it("AUTH_USER/AUTH_PASS 未設定なら素通り（fail-open）", async () => {
		const app = buildApp();
		const res = await app.request("/api/health", {}, {});
		expect(res.status).toBe(200);
	});

	it("片方のみ設定でも素通り（両方揃わなければ無効）", async () => {
		const app = buildApp();
		const res = await app.request("/api/health", {}, { AUTH_USER: "owner" });
		expect(res.status).toBe(200);
	});

	it("両方設定＋正しい credential なら通過（health も保護対象）", async () => {
		const app = buildApp();
		const res = await app.request(
			"/api/health",
			{ headers: { authorization: basic("owner", "s3cret") } },
			{ AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});

	it("両方設定＋credential 無しは 401 で WWW-Authenticate を返す", async () => {
		const app = buildApp();
		const res = await app.request(
			"/api/health",
			{},
			{ AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Basic");
	});

	it("両方設定＋誤 credential は 401", async () => {
		const app = buildApp();
		const res = await app.request(
			"/",
			{ headers: { authorization: basic("owner", "wrong") } },
			{ AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);
		expect(res.status).toBe(401);
	});

	it("未設定時の警告は isolate 単位で 1 回だけ（過剰ログ回避）", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const app = buildApp();
			await app.request("/api/health", {}, {});
			await app.request("/api/health", {}, {});
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
