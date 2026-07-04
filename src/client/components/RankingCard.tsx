import type { JSX, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RankingItem } from "../lib/useRanking";
import { ScoreRadar } from "./ScoreRadar";

// ランキング 1 件のカード（設計書 §4.3 / 実装計画 Task 16 / #109）。
//
// なぜこの構造か:
// - 通常カード（4位以降）とベスト3強調（RankingPodium）が同一の本体（順位・タイトル・スコア・レーダー）を
//   共有できるよう、強調差分（枠色・アイコン）だけを accent prop に切り出した純表示部品にする。
// - 受け入れ条件の核: スコア／チャートの文字色は順位非依存で統一し、順位差は accent（枠色＋lucide アイコン）
//   のみで表す。よってスコア色クラスは accent と無関係にここで固定する（順位で分岐しない）。
// - 軸スコアは GET /api/ranking の RankingItem.categoryScores を表示する（#202 で配線済み）。

// ベスト3強調の差分。枠色クラスと lucide アイコン、a11y 用の順位ラベルだけを受け取る。
export interface RankingCardAccent {
	readonly icon: ReactNode;
	readonly borderClassName: string;
	readonly rankLabel: string;
}

// 表示スケール（#201）。1位=hero, 2/3位=podium, 4位以下=既定。accent（枠色・アイコン）とは独立の軸。
export type RankingCardSize = "hero" | "podium" | "default";

interface RankingCardSizeStyle {
	readonly cardClassName: string;
	readonly titleClassName: string;
	readonly scoreClassName: string;
	readonly radarClassName: string;
}

// size → スケール用 className の決定的マッピング。スコアの文字色（text-foreground）は
// 全 size 共通で固定し、サイズ差は大きさのみで表す（accent との直交性を保つ）。
const CARD_SIZE_STYLES: Record<RankingCardSize, RankingCardSizeStyle> = {
	hero: {
		cardClassName: "md:aspect-square",
		titleClassName: "truncate text-xl",
		scoreClassName: "text-4xl font-bold tabular-nums text-foreground",
		radarClassName: "ml-auto w-44 shrink-0",
	},
	podium: {
		cardClassName: "",
		titleClassName: "truncate text-lg",
		scoreClassName: "text-3xl font-bold tabular-nums text-foreground",
		radarClassName: "ml-auto w-32 shrink-0",
	},
	default: {
		cardClassName: "",
		titleClassName: "truncate text-base",
		scoreClassName: "text-2xl font-bold tabular-nums text-foreground",
		radarClassName: "ml-auto w-28 shrink-0",
	},
};

// size → スケール用 className を引く（決定的、podiumAccent と同じ形）。
export function rankingCardSizeStyle(
	size: RankingCardSize,
): RankingCardSizeStyle {
	return CARD_SIZE_STYLES[size];
}

export interface RankingCardProps {
	readonly item: RankingItem;
	// 1 始まりの表示順位。
	readonly rank: number;
	readonly onSelect: () => void;
	// ベスト3のみ指定。通常カードは undefined（枠色・アイコン無し）。
	readonly accent?: RankingCardAccent;
	// 表示スケール。未指定は "default"（4位以下と同一）。
	readonly size?: RankingCardSize;
	// テスト／レイアウト用の testid（既定は通常カード）。
	readonly testId?: string;
	readonly className?: string;
}

// スコアの表示整形（決定的）。未スコア（null）は中立記号、それ以外は小数2桁。
export function formatScore(total: number | null): string {
	return total === null ? "—" : total.toFixed(2);
}

export function RankingCard({
	item,
	rank,
	onSelect,
	accent,
	size = "default",
	testId = "ranking-card",
	className,
}: RankingCardProps): JSX.Element {
	// 職種タイトル→会社名の順で優先表示し、抽出できなかった求人（両方 null）は
	// sourceUrl へフォールバックする（#200）。
	const heading = item.title ?? item.company ?? item.sourceUrl;
	const sizeStyle = rankingCardSizeStyle(size);

	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onSelect}
			className={cn("block h-full w-full text-left", className)}
		>
			<Card
				className={cn(
					"h-full transition-colors hover:bg-accent",
					sizeStyle.cardClassName,
					// 順位差は枠色のみで表す（accent 指定時だけ太枠＋メダル色）。
					accent && cn("border-2", accent.borderClassName),
				)}
			>
				<CardHeader className="flex-row items-center gap-3 space-y-0 p-4">
					<span className="text-sm font-semibold tabular-nums text-muted-foreground">
						{rank}
					</span>
					{accent ? (
						<span data-testid="podium-icon" className="shrink-0">
							{/* lucide アイコンは装飾。順位は sr-only テキストで読み上げる。 */}
							<span className="sr-only">{accent.rankLabel}</span>
							{accent.icon}
						</span>
					) : null}
					<CardTitle className={sizeStyle.titleClassName}>{heading}</CardTitle>
				</CardHeader>
				<CardContent className="flex items-center gap-4 p-4 pt-0">
					<div className="flex flex-col">
						<span className="text-xs text-muted-foreground">総合スコア</span>
						<span data-testid="card-score" className={sizeStyle.scoreClassName}>
							{formatScore(item.total)}
						</span>
					</div>
					<div data-testid="card-radar" className={sizeStyle.radarClassName}>
						<ScoreRadar scores={item.categoryScores} />
					</div>
				</CardContent>
			</Card>
		</button>
	);
}
