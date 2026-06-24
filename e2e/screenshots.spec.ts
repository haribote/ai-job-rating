import { expect, test } from "@playwright/test";

// PR 貼り付け用のスクリーンショット撮影。アサーションではなく成果物（PNG）生成が目的。
// `npm run e2e:screenshots`（--grep @screenshot）で本 describe のみ実行する。
// 出力先 screenshots/ は .gitignore 対象（生成物・PII を含み得るためコミットしない）。

const PAGES: ReadonlyArray<{ path: string; name: string; ready: RegExp }> = [
	{ path: "/", name: "home", ready: /ai-job-rating/ },
	{ path: "/ranking", name: "ranking", ready: /求人ランキング/ },
	{ path: "/config", name: "config", ready: /評価条件の設定/ },
	{ path: "/fetch", name: "fetch", ready: /求人 URL 入力/ },
	{ path: "/paste", name: "paste", ready: /HTML 貼り付け入力/ },
];

test.describe("@screenshot 主要 UI 撮影", () => {
	for (const { path, name, ready } of PAGES) {
		test(`${name} (${path}) を撮影する`, async ({ page }) => {
			await page.goto(path);
			// h1 の描画完了を待ってから撮ることで、ロード途中の不完全な画を避ける。
			await expect(
				page.getByRole("heading", { level: 1, name: ready }),
			).toBeVisible();
			await page.screenshot({
				path: `screenshots/${name}.png`,
				fullPage: true,
			});
		});
	}
});
