import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";

// Hono アプリの最小ルートを検証する（責務分離: app をテスト対象に切り出す）。
// 詳細な API 契約は api.test.ts で固定し、ここでは health とフォールスルーのみ確認する。
describe("app", () => {
	// ヘルスチェックは死活監視の契約なので固定形式を担保する。
	it("GET /api/health は 200 と ok ステータスを返す", async () => {
		const res = await app.request("/api/health", {}, env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});

	// API 外の GET が ASSETS バインディングへ委譲される配線のみを検証する。
	// 実際の SPA 配信（public/index.html の中身・未知パスの 200 フォールバック）は Vite ビルド成果物に
	// 依存するため、ビルド前提が成立する e2e（playwright・webServer で npm run build 前置）で担保する。
	// ここでビルド物に依存すると CI（build artifact 無し）で非決定になるため ASSETS をスタブする。
	it("API 外の GET は ASSETS バインディング（SPA シェル）へフォールスルーする", async () => {
		let requestedPath: string | undefined;
		const assetsStub = {
			fetch: (input: RequestInfo | URL) => {
				requestedPath = new URL(
					typeof input === "string" ? input : (input as Request).url,
				).pathname;
				return Promise.resolve(
					new Response("spa-shell", {
						headers: { "content-type": "text/html" },
					}),
				);
			},
		} as unknown as Fetcher;

		const res = await app.request("/", {}, { ...env, ASSETS: assetsStub });

		// catch-all が ASSETS.fetch をリクエストのまま呼び、その応答をそのまま返すこと。
		expect(requestedPath).toBe("/");
		expect(res.status).toBe(200);
		await expect(res.text()).resolves.toBe("spa-shell");
	});

	// #183 サイトアクセス制限。middleware の分岐は auth.test.ts で網羅し、ここでは app へ配線されて
	// 全ルート（health 含む）が保護されることのみ統合確認する。既定 env は AUTH 系が無く fail-open。
	it("AUTH_USER/AUTH_PASS 設定時は /api/health も credential 無しで 401", async () => {
		const res = await app.request(
			"/api/health",
			{},
			{ ...env, AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);
		expect(res.status).toBe(401);
	});

	it("AUTH_USER/AUTH_PASS 設定時は正しい credential で通過する", async () => {
		const res = await app.request(
			"/api/health",
			{ headers: { authorization: `Basic ${btoa("owner:s3cret")}` } },
			{ ...env, AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "ok" });
	});

	// #185 回帰ガード。SPA(HTML) の catch-all も認証で守られる配線を固定する。実バグは wrangler の
	// run_worker_first が SPA を Worker 迂回させていた点だが（本テストは app 層で再現不能）、middleware
	// 順序や catch-all 位置の変更で SPA 保護が抜けないよう app レベルで担保する。ASSETS は呼ばれないこと。
	it("AUTH_USER/AUTH_PASS 設定時は SPA(catch-all) も credential 無しで 401", async () => {
		let assetsCalled = false;
		const assetsStub = {
			fetch: () => {
				assetsCalled = true;
				return Promise.resolve(new Response("spa-shell"));
			},
		} as unknown as Fetcher;

		const res = await app.request(
			"/",
			{},
			{ ...env, ASSETS: assetsStub, AUTH_USER: "owner", AUTH_PASS: "s3cret" },
		);

		expect(res.status).toBe(401);
		// 認証前に ASSETS へ抜けない（保護の実効性）。
		expect(assetsCalled).toBe(false);
	});
});

// 認証下 Cookie ストアの明示削除（cleanup 導線・#190）。実 KV（env.AUTH_COOKIES）で往復を確認する。
describe("DELETE /api/auth/cookies", () => {
	// 他テストの残留に依存しないよう Cookie ストアを空にする。
	beforeEach(async () => {
		const { keys } = await env.AUTH_COOKIES.list({ prefix: "auth-cookie:" });
		for (const k of keys) await env.AUTH_COOKIES.delete(k.name);
	});

	async function seed(origin: string, cookie: string): Promise<void> {
		await env.AUTH_COOKIES.put(`auth-cookie:${origin}`, cookie);
	}

	it("?url= 指定はその origin 1 件だけ削除する（値は返さない）", async () => {
		await seed("https://a.example.com", "s=1");
		await seed("https://b.example.com", "s=2");
		const res = await app.request(
			"/api/auth/cookies?url=https://a.example.com/jobs/1",
			{ method: "DELETE" },
			env,
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "deleted", count: 1 });
		expect(
			await env.AUTH_COOKIES.get("auth-cookie:https://a.example.com"),
		).toBeNull();
		// 別 origin は残る。
		expect(
			await env.AUTH_COOKIES.get("auth-cookie:https://b.example.com"),
		).toBe("s=2");
	});

	it("?url= が未保存 origin なら count 0（削除の有無を正直に返す）", async () => {
		const res = await app.request(
			"/api/auth/cookies?url=https://none.example.com/x",
			{ method: "DELETE" },
			env,
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "deleted", count: 0 });
	});

	it("url 未指定は全消しし件数を返す", async () => {
		await seed("https://a.example.com", "s=1");
		await seed("https://b.example.com", "s=2");
		const res = await app.request(
			"/api/auth/cookies",
			{ method: "DELETE" },
			env,
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ status: "deleted", count: 2 });
		const { keys } = await env.AUTH_COOKIES.list({ prefix: "auth-cookie:" });
		expect(keys.length).toBe(0);
	});
});
