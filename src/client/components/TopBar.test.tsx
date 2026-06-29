import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

// シェルのトップバー。投入・設定はナビゲーションを直接持たずコールバックで親へ委ねる（テスト可能・疎結合）。
describe("TopBar", () => {
	function noop() {}

	it("ブランド名と投入・設定のアクションを描画する", () => {
		render(
			<TopBar onNavigateHome={noop} onSubmitJob={noop} onOpenSettings={noop} />,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "ai-job-rating" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "求人を投入" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
	});

	it("投入ボタンで onSubmitJob を呼ぶ", () => {
		const onSubmitJob = vi.fn();
		render(
			<TopBar
				onNavigateHome={noop}
				onSubmitJob={onSubmitJob}
				onOpenSettings={noop}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "求人を投入" }));

		expect(onSubmitJob).toHaveBeenCalledOnce();
	});

	it("設定ボタンで onOpenSettings を呼ぶ", () => {
		const onOpenSettings = vi.fn();
		render(
			<TopBar
				onNavigateHome={noop}
				onSubmitJob={noop}
				onOpenSettings={onOpenSettings}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "設定" }));

		expect(onOpenSettings).toHaveBeenCalledOnce();
	});

	it("ブランド名で onNavigateHome を呼ぶ", () => {
		const onNavigateHome = vi.fn();
		render(
			<TopBar
				onNavigateHome={onNavigateHome}
				onSubmitJob={noop}
				onOpenSettings={noop}
			/>,
		);

		fireEvent.click(screen.getByRole("link", { name: "ai-job-rating" }));

		expect(onNavigateHome).toHaveBeenCalledOnce();
	});
});
