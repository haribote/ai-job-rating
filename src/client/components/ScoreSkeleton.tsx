import type { JSX } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// 抽出中のカード プレースホルダ（#112 / Task 19）。
//
// なぜこの形か:
// - RankingCard と同じ枠（順位・タイトル・スコア・レーダー）の骨組みを Skeleton で描き、
//   抽出完了時に同じ位置でカードへ楽観的に差し替えてもレイアウトが跳ねないようにする。
// - プレースホルダは読み上げ不要なので aria-hidden。読み込み中の通知は親の領域が担う。

export interface ScoreSkeletonProps {
	// テスト／差し替え位置合わせ用の testid（既定は score-skeleton）。
	readonly testId?: string;
	readonly className?: string;
}

export function ScoreSkeleton({
	testId = "score-skeleton",
	className,
}: ScoreSkeletonProps): JSX.Element {
	return (
		<Card data-testid={testId} aria-hidden className={cn(className)}>
			<CardHeader className="flex-row items-center gap-3 space-y-0 p-4">
				{/* 順位・タイトルの骨組み。 */}
				<Skeleton className="h-4 w-4 shrink-0" />
				<Skeleton className="h-5 w-40 max-w-full" />
			</CardHeader>
			<CardContent className="flex items-center gap-4 p-4 pt-0">
				<div className="flex flex-col gap-2">
					{/* スコア ラベル＋値の骨組み。 */}
					<Skeleton className="h-3 w-16" />
					<Skeleton className="h-8 w-20" />
				</div>
				{/* レーダー枠の骨組み。 */}
				<Skeleton className="ml-auto h-24 w-24 shrink-0 rounded-full" />
			</CardContent>
		</Card>
	);
}
