import { expect, test } from "@playwright/test";

// GET /config・POST /config（#19）の設定フォームを実ブラウザで検証する。
// 描画 → 値編集 → 保存 → 「再ランキングしました」通知までの基本操作を通す。
// 保存は決定的な rescoreAll 経路で AI を再実行しない（§5.3）。空 D1 でも保存自体は成立する。

test.describe("GET/POST /config 設定フォーム", () => {
	test("フォームのタイトル・見出し・保存ボタンが描画される", async ({
		page,
	}) => {
		const response = await page.goto("/config");
		expect(response?.status()).toBe(200);

		await expect(page).toHaveTitle(/評価条件の設定 — ai-job-rating/);
		await expect(
			page.getByRole("heading", { level: 1, name: "評価条件の設定" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "保存して再ランキング" }),
		).toBeVisible();
	});

	test("正規キーごとの重み入力が存在する", async ({ page }) => {
		await page.goto("/config");
		// 年収（annualSalary）の重み入力は name="weight__annualSalary" で安定的に特定できる。
		const annualSalaryWeight = page.locator(
			'input[name="weight__annualSalary"]',
		);
		await expect(annualSalaryWeight).toBeVisible();
	});

	test("重みを編集して保存すると再ランキング通知が表示される", async ({
		page,
	}) => {
		await page.goto("/config");

		// 年収の重みを編集 → 保存。決定的に再ランキングされ、保存通知が SSR で返る。
		const annualSalaryWeight = page.locator(
			'input[name="weight__annualSalary"]',
		);
		await annualSalaryWeight.fill("2");
		await page.getByRole("button", { name: "保存して再ランキング" }).click();

		await expect(page.locator(".ajr-config-saved")).toBeVisible();
		await expect(page.locator(".ajr-config-saved")).toContainText(
			"再ランキングしました",
		);
	});
});
