import { render, screen, within } from "@testing-library/react";
import { Trophy } from "lucide-react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_KEYS, type CategoryKey } from "../../shared/categories";
import type { RankingItem } from "../lib/useRanking";
import {
	formatScore,
	RankingCard,
	type RankingCardAccent,
} from "./RankingCard";

// jsdom では ResponsiveContainer の実測サイズが 0 になり中身が描画されない（ScoreRadar.test.tsx と同じ事情）。
// 固定サイズを注入して、item.categoryScores が実際に軸へ反映されることを検証可能にする。
vi.mock("recharts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("recharts")>();
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
			isValidElement<{ width?: number; height?: number }>(children)
				? cloneElement(children, { width: 480, height: 480 })
				: children,
	};
});

// 全軸 unknown（null・中立）の既定軸別スコア。
const NEUTRAL_CATEGORY_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

// ランキング 1 件分の最小ダミー。既定は company/title null（抽出失敗時の URL フォールバック回帰・#200）。
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

describe("RankingCard（ready + total===null: スコア未算出・#199）", () => {
	it("total===null を 0.00 と混同せず「スコア未算出」を明示する", () => {
		render(
			<RankingCard item={item({ total: null })} rank={5} onSelect={vi.fn()} />,
		);

		expect(screen.getByTestId("card-score")).toHaveTextContent("—");
		expect(screen.getByTestId("card-score")).not.toHaveTextContent("0.00");
		const note = screen.getByTestId("score-unavailable-note");
		expect(note).toHaveTextContent("スコア未算出");
		// a11y: 状態を role で読み上げ可能に。
		expect(note).toHaveAttribute("role", "status");
	});

	it("スコアがある（total!==null）ときは未算出ノートを出さない", () => {
		render(
			<RankingCard item={item({ total: 0.8 })} rank={5} onSelect={vi.fn()} />,
		);

		expect(
			screen.queryByTestId("score-unavailable-note"),
		).not.toBeInTheDocument();
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
		// grid セルの高さいっぱいに広がる（親 li のストレッチに追従し、2/3位の高さ揃えを成立させる）。
		expect(card.className).toContain("h-full");
		expect(container.querySelector('[class*="border"]')?.className).toContain(
			"h-full",
		);

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

	it("hero/podium（1〜3位）はレーダー→スコアの順で縦並びに表示する", () => {
		render(
			<RankingCard item={item()} rank={1} onSelect={vi.fn()} size="hero" />,
		);
		const radar = screen.getByTestId("card-radar");
		const score = screen.getByTestId("card-score");
		expect(
			radar.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(radar.parentElement?.className).toContain("flex-col");
		// 縦位置を中央に寄せる。
		expect(radar.parentElement?.className).toContain("justify-center");
	});

	it("既定（4位以下）はレーダー→スコアの順のまま横並びを維持する", () => {
		render(<RankingCard item={item()} rank={5} onSelect={vi.fn()} />);
		const radar = screen.getByTestId("card-radar");
		const score = screen.getByTestId("card-score");
		expect(
			radar.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(radar.parentElement?.className).not.toContain("flex-col");
		// 横方向は space-around で配置する。
		expect(radar.parentElement?.className).toContain("justify-around");
	});

	it("item.categoryScores を ScoreRadar へ実配線する（プレースホルダに固定しない・#202）", () => {
		const { container } = render(
			<RankingCard
				item={item({
					categoryScores: { ...NEUTRAL_CATEGORY_SCORES, compensation: 0.8 },
				})}
				rank={1}
				onSelect={vi.fn()}
			/>,
		);
		// 実データを持つ軸（compensation）は data-unknown=false、それ以外は中立 true のまま。
		const known = container.querySelector('text[data-unknown="false"]');
		const unknown = container.querySelectorAll('text[data-unknown="true"]');
		expect(known).not.toBeNull();
		expect(unknown.length).toBe(CATEGORY_KEYS.length - 1);
	});

	it("size 未指定は既定（4位以下相当）のサイズになる", () => {
		render(<RankingCard item={item()} rank={5} onSelect={vi.fn()} />);
		expect(screen.getByTestId("card-score").className).toContain("text-2xl");
	});

	it("size 指定でスコア・レーダーの表示サイズが変わる（順位や accent とは独立）", () => {
		const hero = render(
			<RankingCard item={item()} rank={1} onSelect={vi.fn()} size="hero" />,
		);
		const heroScore = within(hero.container).getByTestId("card-score");
		const heroRadar = within(hero.container).getByTestId("card-radar");
		expect(heroScore.className).toContain("text-4xl");
		expect(heroRadar.className).not.toContain("w-28");

		const podium = render(
			<RankingCard item={item()} rank={2} onSelect={vi.fn()} size="podium" />,
		);
		const podiumScore = within(podium.container).getByTestId("card-score");
		expect(podiumScore.className).toContain("text-3xl");
		// スコア文字色は size に依らず統一（順位非依存の既存契約を維持）。
		expect(podiumScore.className).toContain("text-foreground");
		expect(heroScore.className).toContain("text-foreground");
	});

	it("hero サイズのときだけカテゴリ別スコアテーブルを表示する（#203 方針転換）", () => {
		render(
			<RankingCard item={item()} rank={1} onSelect={vi.fn()} size="hero" />,
		);
		expect(screen.getByTestId("category-score-table")).toBeInTheDocument();
	});

	it("podium/default サイズではカテゴリ別スコアテーブルを表示しない", () => {
		const podium = render(
			<RankingCard item={item()} rank={2} onSelect={vi.fn()} size="podium" />,
		);
		expect(
			within(podium.container).queryByTestId("category-score-table"),
		).not.toBeInTheDocument();

		const defaultSize = render(
			<RankingCard item={item()} rank={5} onSelect={vi.fn()} />,
		);
		expect(
			within(defaultSize.container).queryByTestId("category-score-table"),
		).not.toBeInTheDocument();
	});
});
