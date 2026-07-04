import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobPhaseBadge, pendingPhaseLabel } from "./JobPhaseBadge";

describe("pendingPhaseLabel", () => {
	it("fetching/scoring を判別可能な文言に決定的にマッピングする", () => {
		expect(pendingPhaseLabel("fetching")).toBe("取得中");
		expect(pendingPhaseLabel("scoring")).toBe("採点中");
	});
});

describe("JobPhaseBadge", () => {
	it("取得中バッジを role=status で読み上げ可能に表示する", () => {
		render(<JobPhaseBadge phase="fetching" />);

		const badge = screen.getByRole("status");
		expect(badge).toHaveTextContent("取得中");
	});

	it("採点中バッジを role=status で読み上げ可能に表示する", () => {
		render(<JobPhaseBadge phase="scoring" />);

		const badge = screen.getByRole("status");
		expect(badge).toHaveTextContent("採点中");
	});
});
