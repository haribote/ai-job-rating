import { expect, test } from "@playwright/test";

// React SPA シェル（#96）の最小スモーク＋スクリーンショット撮影。
// 本格 UI（ランキング・詳細・設定フォーム）は Wave 3（#108–#114）で実装するため、
// ここでは「SPA が assets から配信されマウントされる」「未知ルートの直接アクセス（リロード相当）が
// 404 にならず index.html へフォールバックしクライアントルーティングで描画される」ことだけを検証する。
//
// 撮影 PNG は /screenshots（.gitignore 済）へ出力し PII もコミットもしない。

test("@screenshot ダッシュボード（/）が SPA としてマウントされる", async ({
	page,
}) => {
	const response = await page.goto("/");
	expect(response?.status()).toBe(200);

	await expect(page.locator("[data-app-shell]")).toBeVisible();
	await expect(page.getByTestId("dashboard-view")).toBeVisible();

	await page.screenshot({ path: "screenshots/dashboard.png", fullPage: true });
});

test("@screenshot 設定ルート（/settings）の直接アクセスが 404 にならずフォールバックする", async ({
	page,
}) => {
	// SPA フォールバックの実証: assets に /settings の実体は無いが、
	// not_found_handling=single-page-application により index.html が 200 で返り、
	// クライアントルーターが設定ビューを描画する（リロードで 404 にならない）。
	const response = await page.goto("/settings");
	expect(response?.status()).toBe(200);

	await expect(page.getByTestId("settings-view")).toBeVisible();

	await page.screenshot({ path: "screenshots/settings.png", fullPage: true });
});
