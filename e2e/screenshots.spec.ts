import { test } from "@playwright/test";

// 主要 UI のスクリーンショット撮影は React SPA 本体に依存する。
// 本 PR(#95) で旧 SSR HTML ページ（/ranking ・ /config ・ /fetch ・ /paste）は撤去され、
// SPA 本体は #96 で新設予定のため、UI 描画に依存する本スイートは #96 まで保留する。
// #96 で React ルート（/ ダッシュボード・/settings 等）に対する @screenshot 撮影を再導入する。
test.skip("@screenshot 主要 UI 撮影は #96 の SPA 実装まで保留する", () => {});
