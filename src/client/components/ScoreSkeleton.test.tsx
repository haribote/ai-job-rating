import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreSkeleton } from "./ScoreSkeleton";

describe("ScoreSkeleton", () => {
	it("既定 testid でカード形の骨組みを描く", () => {
		render(<ScoreSkeleton />);

		const root = screen.getByTestId("score-skeleton");
		expect(root).toBeInTheDocument();
		// 順位・タイトル・スコア・レーダー枠の 4 つ以上のプレースホルダを含む。
		expect(
			root.querySelectorAll(".animate-pulse").length,
		).toBeGreaterThanOrEqual(4);
	});

	it("testid を上書きできる（楽観的差し替えの位置合わせ用）", () => {
		render(<ScoreSkeleton testId="pending-skeleton" />);

		expect(screen.getByTestId("pending-skeleton")).toBeInTheDocument();
	});

	it("装飾なので読み上げ対象から外す（aria-hidden）", () => {
		render(<ScoreSkeleton />);

		expect(screen.getByTestId("score-skeleton")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
