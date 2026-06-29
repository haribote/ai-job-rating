import { type JSX, useState } from "react";
import { JobDetailSheet } from "../components/JobDetailSheet";
import {
	type RankingFetcher,
	type RankingItem,
	useRanking,
} from "../lib/useRanking";

// ダッシュボード（設計書 §4.3）。GET /api/ranking を取得し一覧表示、行選択で右ドロワーを開く。
//
// なぜシェルか:
// - #108 では「取得 → 一覧 → 行クリックで詳細ドロワー」の骨格を成立させる。
//   ベスト3強調カード（#109）・レーダー（#110）・Skeleton（#112）は後続が差し替える。
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
				<ul className="flex flex-col gap-2">
					{ranking.jobs.map((job) => (
						<li key={job.jobId}>
							{/* 暫定の行。RankingCard（#109）が差し替える。 */}
							<button
								type="button"
								data-testid="ranking-row"
								onClick={() => setSelected(job)}
								className="w-full rounded-lg border p-4 text-left hover:bg-accent"
							>
								<span className="block truncate font-medium">
									{job.title ?? job.company ?? job.sourceUrl}
								</span>
								<span className="text-sm text-muted-foreground">
									総合スコア: {job.total ?? "—"}
								</span>
							</button>
						</li>
					))}
				</ul>
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
