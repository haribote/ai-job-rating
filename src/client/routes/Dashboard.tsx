import { type JSX, useState } from "react";
import { JobDetailSheet } from "../components/JobDetailSheet";
import { RankingCard } from "../components/RankingCard";
import { type MedalRank, RankingPodium } from "../components/RankingPodium";
import {
	type RankingFetcher,
	type RankingItem,
	useRanking,
} from "../lib/useRanking";

// ダッシュボード（設計書 §4.3）。GET /api/ranking を取得し一覧表示、カード選択で右ドロワーを開く。
//
// なぜこの構成か:
// - スコア順に並んだ求人を、ベスト3は RankingPodium（金銀銅枠＋lucide アイコン）、4位以降は
//   RankingCard（通常）で描く。順位は配列順（index+1）で決まる（スコアリングはサーバ責務）。
// - fetcher を注入可能にしてテストをネットワーク非依存に保つ（既定は本番 /api/ranking）。

export interface DashboardProps {
	// テスト用に取得関数を注入する（既定は useRanking 既定の /api/ranking）。
	rankingFetcher?: RankingFetcher;
}

export function Dashboard({ rankingFetcher }: DashboardProps): JSX.Element {
	const ranking = useRanking(rankingFetcher);
	// 選択中の求人。null なら詳細ドロワーは閉じる。
	const [selected, setSelected] = useState<RankingItem | null>(null);

	return (
		<section data-testid="dashboard-view" className="p-4">
			<h2 className="sr-only">ランキング</h2>

			{ranking.status === "loading" && (
				<p data-testid="ranking-loading">読み込み中...</p>
			)}

			{ranking.status === "error" && (
				<p role="alert">ランキングの取得に失敗しました。</p>
			)}

			{ranking.status === "success" && (
				<ol className="flex flex-col gap-3">
					{ranking.jobs.map((job, index) => {
						const rank = index + 1;
						return (
							<li key={job.jobId}>
								{rank <= 3 ? (
									<RankingPodium
										item={job}
										rank={rank as MedalRank}
										onSelect={() => setSelected(job)}
									/>
								) : (
									<RankingCard
										item={job}
										rank={rank}
										onSelect={() => setSelected(job)}
									/>
								)}
							</li>
						);
					})}
				</ol>
			)}

			<JobDetailSheet
				job={selected}
				open={selected !== null}
				onOpenChange={(open) => {
					// 閉じる操作（オーバーレイ／Esc／閉じるボタン）で選択を解除する。
					if (!open) {
						setSelected(null);
					}
				}}
			/>
		</section>
	);
}
