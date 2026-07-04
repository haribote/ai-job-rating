import { expect, test } from "@playwright/test";
import {
	MOCK_RANKING_SCORED,
	MOCK_RANKING_UNSCORED,
} from "./fixtures/mockRanking";

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

// モックデータによるダッシュボードのレイアウト検証（#204）。
//
// なぜ page.route か: 取得〜AI抽出パイプラインや実データ（永続 D1）を回さずに、GET /api/ranking の
// レスポンスだけを差し替えてダッシュボードの各状態（スコア済み／未算出／取得中／失敗）を決定的に
// 再現できる。webServer（wrangler dev 実起動）・baseURL は変更不要（ネットワーク層のみ intercept）。
// レーダーは RankingCard が PLACEHOLDER_SCORES（全軸 null）を常時使うため（#202 未実装）、
// 本テストでは「現状のプレースホルダ描画を含むダッシュボード全体のレイアウト」を確認する。

test("@screenshot ダッシュボード（モック: スコア済みベスト3+一覧）", async ({
	page,
}) => {
	await page.route("**/api/ranking", (route) =>
		route.fulfill({ json: MOCK_RANKING_SCORED }),
	);

	await page.goto("/");
	await expect(page.getByTestId("dashboard-view")).toBeVisible();
	// 1位ヒーロー＋2/3位が同一領域、4位以下は別のグリッド領域に分かれる（#201）。
	const heroRegion = page.getByTestId("ranking-hero-region");
	await expect(heroRegion).toBeVisible();
	await expect(heroRegion.getByTestId("ranking-podium")).toHaveCount(3);
	await expect(page.getByTestId("ranking-grid-region")).toBeVisible();

	await page.screenshot({
		path: "screenshots/dashboard-mock-scored.png",
		fullPage: true,
	});
});

test("@screenshot ダッシュボード（モック: スコア未算出）", async ({ page }) => {
	await page.route("**/api/ranking", (route) =>
		route.fulfill({ json: MOCK_RANKING_UNSCORED }),
	);

	await page.goto("/");
	await expect(page.getByTestId("dashboard-view")).toBeVisible();
	// 未算出（total: null）は「—」表示になる（RankingCard.formatScore）。
	await expect(page.getByTestId("card-score").first()).toHaveText("—");

	await page.screenshot({
		path: "screenshots/dashboard-mock-unscored.png",
		fullPage: true,
	});
});

test("@screenshot ダッシュボード（モック: 取得中）", async ({ page }) => {
	await page.route("**/api/ranking", async (route) => {
		// useRanking の loading 状態はフェッチそのものの状態のため、意図的に遅延させて
		// ranking-loading（role="status"）が見えるタイミングを作る（expect は自動リトライするため
		// 短い遅延でも安定して捕捉できる）。
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.fulfill({ json: MOCK_RANKING_SCORED });
	});

	await page.goto("/");
	await expect(page.getByTestId("ranking-loading")).toBeVisible();
	await expect(page.getByRole("status")).toBeVisible();

	await page.screenshot({
		path: "screenshots/dashboard-mock-loading.png",
		fullPage: true,
	});
});

test("@screenshot ダッシュボード（モック: 取得失敗）", async ({ page }) => {
	await page.route("**/api/ranking", (route) => route.fulfill({ status: 500 }));

	await page.goto("/");
	await expect(page.getByTestId("dashboard-view")).toBeVisible();
	await expect(page.getByRole("alert")).toBeVisible();

	await page.screenshot({
		path: "screenshots/dashboard-mock-error.png",
		fullPage: true,
	});
});
