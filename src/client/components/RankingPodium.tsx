import { Medal, Trophy } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { RankingItem } from "../lib/useRanking";
import { RankingCard } from "./RankingCard";

// ベスト3強調カード（設計書 §4.3 / 実装計画 Task 16 / #109）。1〜3位を trophy/medal lucide と
// 金銀銅の枠色で強調する。
//
// なぜ RankingCard へ委譲するか:
// - 本体（順位・タイトル・スコア・レーダー）と「スコア色の順位非依存統一」を RankingCard に一元化し、
//   ここは順位 → 強調差分（枠色・アイコン）の決定的マッピングだけを担う（単一ソース）。
// - 絵文字は使わず lucide アイコンで表現する（#97）。順位差は枠色＋アイコンのみ。

export type MedalRank = 1 | 2 | 3;

// 順位 → 強調差分の決定的マッピング。枠色・アイコン色はメダル色トークン、iconName は lucide の種別。
export interface PodiumAccent {
	readonly borderClassName: string;
	readonly iconClassName: string;
	readonly iconName: "trophy" | "medal";
	readonly rankLabel: string;
}

const PODIUM_ACCENTS: Record<MedalRank, PodiumAccent> = {
	1: {
		borderClassName: "border-medal-gold",
		iconClassName: "text-medal-gold",
		iconName: "trophy",
		rankLabel: "1位",
	},
	2: {
		borderClassName: "border-medal-silver",
		iconClassName: "text-medal-silver",
		iconName: "medal",
		rankLabel: "2位",
	},
	3: {
		borderClassName: "border-medal-bronze",
		iconClassName: "text-medal-bronze",
		iconName: "medal",
		rankLabel: "3位",
	},
};

// 順位（1〜3）→ 強調差分を引く（決定的）。
export function podiumAccent(rank: MedalRank): PodiumAccent {
	return PODIUM_ACCENTS[rank];
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

	return (
		<RankingCard
			item={item}
			rank={rank}
			onSelect={onSelect}
			testId="ranking-podium"
			accent={{
				icon: (
					<Icon className={cn("size-5", accent.iconClassName)} aria-hidden />
				),
				borderClassName: accent.borderClassName,
				rankLabel: accent.rankLabel,
			}}
		/>
	);
}
