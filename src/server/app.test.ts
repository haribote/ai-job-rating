import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
