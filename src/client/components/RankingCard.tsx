import type { JSX, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CATEGORY_KEYS, type CategoryKey } from "../../shared/categories";
import type { RankingItem } from "../lib/useRanking";
import { ScoreRadar } from "./ScoreRadar";

// ランキング 1 件のカード（設計書 §4.3 / 実装計画 Task 16 / #109）。
//
// なぜこの構造か:
// - 通常カード（4位以降）とベスト3強調（RankingPodium）が同一の本体（順位・タイトル・スコア・レーダー）を
//   共有できるよう、強調差分（枠色・アイコン）だけを accent prop に切り出した純表示部品にする。
// - 受け入れ条件の核: スコア／チャートの文字色は順位非依存で統一し、順位差は accent（枠色＋lucide アイコン）
//   のみで表す。よってスコア色クラスは accent と無関係にここで固定する（順位で分岐しない）。
// - 軸スコアは GET /api/ranking の RankingItem にまだ無い（total のみ）。全軸 unknown（中立）で
//   ScoreRadar を描画し、実データ配線は API 拡張時の follow-up とする（#110 申し送り）。

// RankingItem は軸スコアを持たないため、全カテゴリ unknown（null・中立）でレーダーを描く。
const PLACEHOLDER_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

// ベスト3強調の差分。枠色クラスと lucide アイコン、a11y 用の順位ラベルだけを受け取る。
export interface RankingCardAccent {
	readonly icon: ReactNode;
	readonly borderClassName: string;
	readonly rankLabel: string;
}

export interface RankingCardProps {
	readonly item: RankingItem;
	// 1 始まりの表示順位。
	readonly rank: number;
	readonly onSelect: () => void;
	// ベスト3のみ指定。通常カードは undefined（枠色・アイコン無し）。
	readonly accent?: RankingCardAccent;
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
	testId = "ranking-card",
	className,
}: RankingCardProps): JSX.Element {
	// company/title は契約上まだ null（#95）。暫定で sourceUrl をタイトル代替にする。
	const heading = item.title ?? item.company ?? item.sourceUrl;

	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onSelect}
			className={cn("block w-full text-left", className)}
		>
			<Card
				className={cn(
					"transition-colors hover:bg-accent",
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
					<CardTitle className="truncate text-base">{heading}</CardTitle>
				</CardHeader>
				<CardContent className="flex items-center gap-4 p-4 pt-0">
					<div className="flex flex-col">
						<span className="text-xs text-muted-foreground">総合スコア</span>
						{/* スコア文字色は順位非依存で統一（text-foreground 固定）。 */}
						<span
							data-testid="card-score"
							className="text-2xl font-bold tabular-nums text-foreground"
						>
							{formatScore(item.total)}
						</span>
					</div>
					<div data-testid="card-radar" className="ml-auto w-28 shrink-0">
						<ScoreRadar scores={PLACEHOLDER_SCORES} />
					</div>
				</CardContent>
			</Card>
		</button>
	);
}
