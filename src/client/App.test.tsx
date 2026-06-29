import { fireEvent, render, screen } from "@testing-library/react";
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

	it("投入ボタンで求人投入モーダルを開く", () => {
		render(<App />);

		// 既定ではモーダル（ダイアログ）は閉じている。
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "求人を投入" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByTestId("add-job-url-input")).toBeInTheDocument();
	});
});
