import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_KEYS, type CategoryKey } from "../../shared/categories";
import type { RankingItem } from "../lib/useRanking";
import { podiumAccent, RankingPodium, rankRegion } from "./RankingPodium";

// 全軸 unknown（null・中立）の既定軸別スコア。
const NEUTRAL_CATEGORY_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

function item(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-1",
		sourceUrl: "https://example.com/job-1",
		company: null,
		title: null,
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		categoryScores: NEUTRAL_CATEGORY_SCORES,
		...over,
	};
}

describe("podiumAccent", () => {
	it("順位 → 金銀銅の枠色・アイコン種別を決定的に対応づける", () => {
		expect(podiumAccent(1)).toEqual({
			borderClassName: "border-medal-gold",
			iconClassName: "text-medal-gold",
			iconName: "trophy",
			rankLabel: "1位",
		});
		expect(podiumAccent(2)).toEqual({
			borderClassName: "border-medal-silver",
			iconClassName: "text-medal-silver",
			iconName: "medal",
			rankLabel: "2位",
		});
		expect(podiumAccent(3)).toEqual({
			borderClassName: "border-medal-bronze",
			iconClassName: "text-medal-bronze",
			iconName: "medal",
			rankLabel: "3位",
		});
	});
});

describe("RankingPodium", () => {
	it("ベスト3カードを枠色＋lucide アイコンで描画し選択導線を持つ", () => {
		const onSelect = vi.fn();
		const { container } = render(
			<RankingPodium item={item()} rank={1} onSelect={onSelect} />,
		);

		const card = screen.getByTestId("ranking-podium");
		expect(container.querySelector(".border-medal-gold")).not.toBeNull();
		// 絵文字ではなく lucide（svg）。
		expect(
			screen.getByTestId("podium-icon").querySelector("svg"),
		).not.toBeNull();

		card.click();
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("2位・3位はメダルアイコンで銀・銅枠色を付ける", () => {
		const silver = render(
			<RankingPodium item={item()} rank={2} onSelect={vi.fn()} />,
		);
		expect(
			silver.container.querySelector(".border-medal-silver"),
		).not.toBeNull();

		const bronze = render(
			<RankingPodium item={item()} rank={3} onSelect={vi.fn()} />,
		);
		expect(
			bronze.container.querySelector(".border-medal-bronze"),
		).not.toBeNull();
	});

	it("1位は hero、2/3位は podium サイズで RankingCard へ委譲する（#201）", () => {
		const hero = render(
			<RankingPodium item={item()} rank={1} onSelect={vi.fn()} />,
		);
		const heroScore = within(hero.container).getByTestId("card-score");
		expect(heroScore.className).toContain("text-4xl");

		const podium = render(
			<RankingPodium item={item()} rank={2} onSelect={vi.fn()} />,
		);
		const podiumScore = within(podium.container).getByTestId("card-score");
		expect(podiumScore.className).toContain("text-3xl");
	});
});

describe("rankRegion", () => {
	it("1位はhero、2・3位はpodium、4位以上はgridへ決定的に対応づける", () => {
		expect(rankRegion(1)).toBe("hero");
		expect(rankRegion(2)).toBe("podium");
		expect(rankRegion(3)).toBe("podium");
		expect(rankRegion(4)).toBe("grid");
		expect(rankRegion(10)).toBe("grid");
	});
});
