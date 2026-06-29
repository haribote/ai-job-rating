import { render, screen, within } from "@testing-library/react";
import { Trophy } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { RankingItem } from "../lib/useRanking";
import {
	formatScore,
	RankingCard,
	type RankingCardAccent,
} from "./RankingCard";

// ランキング 1 件分の最小ダミー。company/title は契約上まだ null（#95 申し送り）。
function item(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-1",
		sourceUrl: "https://example.com/job-1",
		company: null,
		title: null,
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		...over,
	};
}

// ベスト3強調の差分（テスト用）。枠色＋lucide アイコン。
const goldAccent: RankingCardAccent = {
	icon: <Trophy aria-hidden />,
	borderClassName: "border-medal-gold",
	rankLabel: "1位",
};

describe("formatScore", () => {
	it("未スコア（null）は中立記号、それ以外は小数2桁（決定的）", () => {
		expect(formatScore(null)).toBe("—");
		expect(formatScore(0)).toBe("0.00");
		expect(formatScore(0.8)).toBe("0.80");
	});
});

describe("RankingCard", () => {
	it("通常カードはスコアと選択導線を持ち、強調差分（枠色・アイコン）を付けない", () => {
		const onSelect = vi.fn();
		const { container } = render(
			<RankingCard item={item({ total: 0.8 })} rank={5} onSelect={onSelect} />,
		);

		const card = screen.getByTestId("ranking-card");
		expect(card).toBeInTheDocument();
		expect(screen.getByTestId("card-score")).toHaveTextContent("0.80");
		// 通常カードは枠色・アイコン無し。
		expect(screen.queryByTestId("podium-icon")).not.toBeInTheDocument();
		expect(container.querySelector('[class*="border-medal"]')).toBeNull();

		card.click();
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("accent 指定時のみ枠色（メダル色）と lucide アイコンを付与する", () => {
		const { container } = render(
			<RankingCard
				item={item()}
				rank={1}
				onSelect={vi.fn()}
				accent={goldAccent}
				testId="ranking-podium"
			/>,
		);

		const icon = screen.getByTestId("podium-icon");
		// 絵文字ではなく lucide（svg）でアイコンを表す（#97）。
		expect(icon.querySelector("svg")).not.toBeNull();
		expect(container.querySelector(".border-medal-gold")).not.toBeNull();
	});

	it("スコア文字色は順位に依存せず統一する（順位差は枠色＋アイコンのみ）", () => {
		const podium = render(
			<RankingCard
				item={item()}
				rank={1}
				onSelect={vi.fn()}
				accent={goldAccent}
			/>,
		);
		const normal = render(
			<RankingCard item={item()} rank={5} onSelect={vi.fn()} />,
		);

		const podiumScore = within(podium.container).getByTestId("card-score");
		const normalScore = within(normal.container).getByTestId("card-score");
		// スコアの文字色クラスは順位（accent の有無）に依らず同一。
		expect(podiumScore.className).toBe(normalScore.className);
		// 順位差をスコア側のメダル色で表現していないこと。
		expect(podiumScore.className).not.toMatch(/medal/);
	});

	it("チャート（ScoreRadar）をカードへ埋め込む", () => {
		render(<RankingCard item={item()} rank={4} onSelect={vi.fn()} />);
		expect(screen.getByTestId("card-radar")).toBeInTheDocument();
	});
});
