import { defineConfig, devices } from "@playwright/test";

// E2E は wrangler dev（本番と同じ Worker ランタイム・assets・D1 バインディング）に対して実描画を検証する。
// vitest（pool-workers）は SSR 出力の単体テスト、Playwright は実ブラウザでの描画・基本操作を担う棲み分け。
// 不安定要因（時間依存・並列 DB 競合）を避けるため workers=1・retries は CI のみとする。

// /ranking・/config は D1 を読むため、webServer 起動前にローカル D1 へ本番マイグレーションを適用する。
// `--persist-to .wrangler-e2e` で E2E 専用の隔離ストレージに閉じ、開発用 .wrangler を汚さない。
const PERSIST_DIR = ".wrangler-e2e";
const PORT = 8788;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	// 同一 wrangler dev を複数 spec が共有するため、ファイル単位の並列のみ許可し DB 競合を避ける。
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
	use: {
		baseURL: BASE_URL,
		// 失敗再現用にリトライ時のみ trace を残す（常時取得は不安定・重量のため避ける）。
		trace: "on-first-retry",
		locale: "ja-JP",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	// マイグレーション適用 → wrangler dev を 1 コマンドで前段起動する。
	// remote bindings は credentials を要するため --local（miniflare）に閉じてオフライン・決定的に保つ。
	webServer: {
		command: `npx wrangler d1 migrations apply ai-job-rating --local --persist-to ${PERSIST_DIR} && npx wrangler dev --port ${PORT} --local --persist-to ${PERSIST_DIR}`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120 * 1000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
