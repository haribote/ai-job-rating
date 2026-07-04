import { Medal, Trophy } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { RankingItem } from "../lib/useRanking";
import { RankingCard, type RankingCardSize } from "./RankingCard";
import type { RadarAccentColor } from "./ScoreRadar";

// ベスト3強調カード（設計書 §4.3 / 実装計画 Task 16 / #109）。1〜3位を trophy/medal lucide と
// 金銀銅の枠色で強調する。
//
// なぜ RankingCard へ委譲するか:
// - 本体（順位・タイトル・スコア・レーダー）と「スコア色の順位非依存統一」を RankingCard に一元化し、
//   ここは順位 → 強調差分（枠色・アイコン）の決定的マッピングだけを担う（単一ソース）。
// - 絵文字は使わず lucide アイコンで表現する（#97）。順位差は枠色＋アイコンのみ。

export type MedalRank = 1 | 2 | 3;

// 順位 → 強調差分の決定的マッピング。枠色・アイコン色はメダル色トークン、iconName は lucide の種別。
// backgroundClassName は枠色と同系色の薄い（15%）グラデーション tint。text-foreground とのコントラストは
// 白背景に対する低不透明度合成のため十分に確保される（design-tokens.ts の色値で試算済み・#201）。
export interface PodiumAccent {
	readonly borderClassName: string;
	readonly iconClassName: string;
	readonly backgroundClassName: string;
	readonly iconName: "trophy" | "medal";
	readonly rankLabel: string;
	// レーダーチャートの色を枠色（金銀銅）に馴染ませるための accent 色（あしらい調整）。
	readonly radarColor: RadarAccentColor;
}

const PODIUM_ACCENTS: Record<MedalRank, PodiumAccent> = {
	1: {
		borderClassName: "border-medal-gold",
		iconClassName: "text-medal-gold",
		backgroundClassName: "bg-gradient-to-b from-transparent to-medal-gold/15",
		iconName: "trophy",
		rankLabel: "1位",
		radarColor: "medal-gold",
	},
	2: {
		borderClassName: "border-medal-silver",
		iconClassName: "text-medal-silver",
		backgroundClassName: "bg-gradient-to-b from-transparent to-medal-silver/15",
		iconName: "medal",
		rankLabel: "2位",
		radarColor: "medal-silver",
	},
	3: {
		borderClassName: "border-medal-bronze",
		iconClassName: "text-medal-bronze",
		backgroundClassName: "bg-gradient-to-b from-transparent to-medal-bronze/15",
		iconName: "medal",
		rankLabel: "3位",
		radarColor: "medal-bronze",
	},
};

// 順位（1〜3）→ 強調差分を引く（決定的）。
export function podiumAccent(rank: MedalRank): PodiumAccent {
	return PODIUM_ACCENTS[rank];
}

// 順位 → レーダー accent 色（決定的）。1〜3位以外（4位以下・投入中カード等）は undefined
// （ScoreRadar の既定色のまま）。JobDetailSheet からも同じマッピングを再利用する単一ソース。
export function radarAccentColorForRank(
	rank: number,
): RadarAccentColor | undefined {
	if (rank !== 1 && rank !== 2 && rank !== 3) {
		return undefined;
	}
	return PODIUM_ACCENTS[rank].radarColor;
}

// レイアウト区分（#201）。1位=hero（ヒーローカード）、2/3位=podium、4位以下=grid（3列）。
export type RankRegion = "hero" | "podium" | "grid";

// 順位 → レイアウト区分の決定的マッピング。Dashboard のグリッド分割と RankingPodium のサイズ選択の
// 単一ソース（#205 受け入れ: 決定的な順位→レイアウトのマッピング）。
export function rankRegion(rank: number): RankRegion {
	if (rank === 1) return "hero";
	if (rank === 2 || rank === 3) return "podium";
	return "grid";
}

const ICON_BY_NAME = { trophy: Trophy, medal: Medal } as const;

export interface RankingPodiumProps {
	readonly item: RankingItem;
	readonly rank: MedalRank;
	readonly onSelect: () => void;
}

export function RankingPodium({
	item,
	rank,
	onSelect,
}: RankingPodiumProps): JSX.Element {
	const accent = podiumAccent(rank);
	const Icon = ICON_BY_NAME[accent.iconName];
	const size: RankingCardSize = rankRegion(rank) === "hero" ? "hero" : "podium";

	return (
		<RankingCard
			item={item}
			rank={rank}
			onSelect={onSelect}
			testId="ranking-podium"
			size={size}
			accent={{
				icon: (
					<Icon className={cn("size-5", accent.iconClassName)} aria-hidden />
				),
				borderClassName: accent.borderClassName,
				backgroundClassName: accent.backgroundClassName,
				radarColor: accent.radarColor,
				rankLabel: accent.rankLabel,
			}}
		/>
	);
}
