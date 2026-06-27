import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// client（jsdom）プロジェクト共通のセットアップ。
// - jest-dom のマッチャ（toBeInTheDocument 等）を vitest の expect へ拡張する。
// - 各テスト後に DOM を破棄し、レンダリング結果がテスト間で混ざらないようにする。
afterEach(() => {
	cleanup();
});
