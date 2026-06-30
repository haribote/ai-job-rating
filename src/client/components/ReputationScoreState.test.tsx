import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReputationScoreState } from "./ReputationScoreState";

// 評判の中立扱い・低信頼フラグ表示（#37）。中立/低信頼バッジを既存パターンで描く。
describe("ReputationScoreState", () => {
	it("APIキー未設定は中立・低信頼バッジを出し、スコアは「—」", () => {
		render(<ReputationScoreState apiKeyConfigured={false} />);
		expect(screen.getByTestId("reputation-neutral-badge")).toBeInTheDocument();
		expect(
			screen.getByTestId("reputation-low-confidence-badge"),
		).toBeInTheDocument();
		expect(screen.getByTestId("reputation-score-value")).toHaveTextContent("—");
		expect(screen.getByTestId("reputation-score-note")).toHaveTextContent(
			/ANTHROPIC_API_KEY/,
		);
	});

	it("設定済み・データなしは中立・低信頼（実データ供給は #117）", () => {
		render(<ReputationScoreState apiKeyConfigured={true} />);
		const root = screen.getByTestId("reputation-score-state");
		expect(root).toHaveAttribute("data-neutral", "true");
		expect(root).toHaveAttribute("data-low-confidence", "true");
	});

	it("low はスコアを描き低信頼バッジを立てるが中立バッジは出さない", () => {
		render(
			<ReputationScoreState
				apiKeyConfigured={true}
				score={0.55}
				confidence="low"
			/>,
		);
		expect(screen.getByTestId("reputation-score-value")).toHaveTextContent(
			"0.55",
		);
		expect(
			screen.getByTestId("reputation-low-confidence-badge"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("reputation-neutral-badge"),
		).not.toBeInTheDocument();
	});

	it("ok はスコアのみでバッジを出さない", () => {
		render(
			<ReputationScoreState
				apiKeyConfigured={true}
				score={0.8}
				confidence="ok"
			/>,
		);
		expect(screen.getByTestId("reputation-score-value")).toHaveTextContent(
			"0.80",
		);
		expect(
			screen.queryByTestId("reputation-neutral-badge"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("reputation-low-confidence-badge"),
		).not.toBeInTheDocument();
	});
});
