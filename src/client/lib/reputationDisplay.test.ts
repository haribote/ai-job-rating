import { describe, expect, it } from "vitest";
import { describeReputationDisplay } from "./reputationDisplay";

// 評判の中立扱い・低信頼フラグの表示状態導出（#37）。データなし・APIキー未設定・低件数を中立/低信頼へ倒す。
describe("describeReputationDisplay", () => {
	it("APIキー未設定は中立・低信頼で、理由に ANTHROPIC_API_KEY を示す", () => {
		const got = describeReputationDisplay({ apiKeyConfigured: false });
		expect(got.neutral).toBe(true);
		expect(got.lowConfidence).toBe(true);
		expect(got.scoreText).toBe("—");
		expect(got.note).toMatch(/ANTHROPIC_API_KEY/);
	});

	it("設定済みでもデータなし（confidence 省略）は中立・低信頼", () => {
		const got = describeReputationDisplay({ apiKeyConfigured: true });
		expect(got.neutral).toBe(true);
		expect(got.lowConfidence).toBe(true);
		expect(got.scoreText).toBe("—");
	});

	it("設定済み・confidence none は中立・低信頼（score があっても中立）", () => {
		const got = describeReputationDisplay({
			apiKeyConfigured: true,
			score: null,
			confidence: "none",
		});
		expect(got.neutral).toBe(true);
		expect(got.lowConfidence).toBe(true);
	});

	it("設定済み・low はスコアを出すが低信頼フラグを立てる（中立ではない）", () => {
		const got = describeReputationDisplay({
			apiKeyConfigured: true,
			score: 0.55,
			confidence: "low",
		});
		expect(got.neutral).toBe(false);
		expect(got.lowConfidence).toBe(true);
		expect(got.scoreText).toBe("0.55");
	});

	it("設定済み・ok はスコアを出し低信頼フラグを立てない", () => {
		const got = describeReputationDisplay({
			apiKeyConfigured: true,
			score: 0.8,
			confidence: "ok",
		});
		expect(got.neutral).toBe(false);
		expect(got.lowConfidence).toBe(false);
		expect(got.scoreText).toBe("0.80");
	});

	it("スコアは 0..1 を 2 桁で整形する（BreakdownTable と同流儀）", () => {
		expect(
			describeReputationDisplay({
				apiKeyConfigured: true,
				score: 0.5,
				confidence: "ok",
			}).scoreText,
		).toBe("0.50");
	});
});
