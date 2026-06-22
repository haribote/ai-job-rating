import { expect, test } from "@playwright/test";

// GET /ranking（#18）の SSR 描画を実ブラウザで検証する。
// 永続スコアが空でも一覧ページが成立すること（空状態の導線）までを担保する。
// AI 抽出・再スコアリングは呼ばれない経路のため、決定的に検証できる（§5.3）。

test.describe("GET /ranking 一覧ページ", () => {
	test("ページタイトルと見出しが描画される", async ({ page }) => {
		const response = await page.goto("/ranking");
		expect(response?.status()).toBe(200);

		await expect(page).toHaveTitle(/ランキング — ai-job-rating/);
		await expect(
			page.getByRole("heading", { level: 1, name: "求人ランキング" }),
		).toBeVisible();
	});

	test("スタイルシートが読み込まれている", async ({ page }) => {
		await page.goto("/ranking");
		// --ajr-* トークンを持つ /styles.css がリンクされていることを確認する（#18 のスタイル契約）。
		const href = await page
			.locator('link[rel="stylesheet"]')
			.getAttribute("href");
		expect(href).toBe("/styles.css");
	});

	test("スコアが空でも空状態メッセージで成立する", async ({ page }) => {
		// E2E の隔離 D1 は投入求人を持たないため、空状態の文言が出るのが期待動作。
		await page.goto("/ranking");
		await expect(page.getByText("求人がありません。")).toBeVisible();
	});
});
