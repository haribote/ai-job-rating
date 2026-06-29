import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

// client（jsdom）プロジェクトの足場が機能することを示す最小スモーク。
// ビルド成果物に依存せず、App を直接レンダリングして既定ルートと骨格のみを検証する。
describe("App", () => {
	it("既定ルートでダッシュボードビューを描画する", () => {
		render(<App />);

		expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument();
	});

	it("トップバーのアプリ名と設定アクションを描画する", () => {
		render(<App />);

		expect(
			screen.getByRole("heading", { level: 1, name: "ai-job-rating" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
	});
});
