import { expect, test } from "@playwright/test";

// 既存の入力導線（/ ・ /fetch ・ /paste）の SSR 描画と相互リンクを検証する。
// これらは AI・D1 を読まない純 SSR ルートのため、最も決定的に確認できる回帰防止網。

test.describe("トップと入力ページ", () => {
	test("トップページから各入力ページへの導線が描画される", async ({ page }) => {
		const response = await page.goto("/");
		expect(response?.status()).toBe(200);

		await expect(
			page.getByRole("heading", { level: 1, name: "ai-job-rating" }),
		).toBeVisible();
		await expect(
			page.getByRole("link", { name: "求人 URL 入力" }),
		).toHaveAttribute("href", "/fetch");
		await expect(
			page.getByRole("link", { name: /HTML 貼り付け入力/ }),
		).toHaveAttribute("href", "/paste");
		await expect(
			page.getByRole("link", { name: /評価条件の設定/ }),
		).toHaveAttribute("href", "/config");
	});

	test("GET /fetch は URL 入力フォームを描画する", async ({ page }) => {
		await page.goto("/fetch");
		await expect(page).toHaveTitle(/URL 入力 — ai-job-rating/);
		await expect(
			page.getByRole("heading", { level: 1, name: "求人 URL 入力" }),
		).toBeVisible();
		// type="url" の必須入力と投入ボタンが揃っていることを確認する。
		await expect(page.locator('input[name="url"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "投入" })).toBeVisible();
	});

	test("GET /paste は HTML 貼り付けフォームを描画する", async ({ page }) => {
		await page.goto("/paste");
		await expect(page).toHaveTitle(/HTML 貼り付け入力 — ai-job-rating/);
		await expect(
			page.getByRole("heading", { level: 1, name: "HTML 貼り付け入力" }),
		).toBeVisible();
		await expect(page.locator('textarea[name="html"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "投入" })).toBeVisible();
	});
});
