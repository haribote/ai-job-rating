import { type JSX, useEffect, useRef, useState } from "react";
import { aggregateCategoryScores } from "../../shared/categoryScores";
import { JobDetailSheet } from "../components/JobDetailSheet";
import { RankingCard } from "../components/RankingCard";
import { type MedalRank, RankingPodium } from "../components/RankingPodium";
import { ScoreSkeleton } from "../components/ScoreSkeleton";
import type { JobDetailFetcher, JobDetailResponse } from "../lib/jobDetail";
import { useJobStatus } from "../lib/useJobStatus";
import {
	type RankingFetcher,
	type RankingItem,
	useRanking,
} from "../lib/useRanking";

// ダッシュボード（設計書 §4.3 / #112 で抽出中 Skeleton・楽観的差し替えを追加）。
//
// なぜこの構成か:
// - スコア順に並んだ求人を、ベスト3は RankingPodium（金銀銅枠＋lucide アイコン）、4位以降は
//   RankingCard（通常）で描く。順位は配列順（index+1）で決まる（スコアリングはサーバ責務）。
// - 取得中・投入直後はカード形の Skeleton を出し、レイアウトを先に確保する（#112）。
// - fetcher を注入可能にしてテストをネットワーク非依存に保つ（既定は本番 /api/ranking）。

export interface DashboardProps {
	// テスト用に取得関数を注入する（既定は useRanking 既定の /api/ranking）。
	rankingFetcher?: RankingFetcher;
	// 投入直後でまだランキングに現れない求人 ID（#113 が投入フローから供給する）。
	// 各 ID は抽出完了まで Skeleton を出し、scored で楽観的にカードへ差し替える。
	pendingJobIds?: readonly string[];
	// 抽出状態のポーリング取得関数（既定は GET /api/jobs/:id）。テストはフェイクを注入する。
	jobStatusFetcher?: JobDetailFetcher;
	// ポーリング間隔（ms）。テストで短縮する。
	jobStatusIntervalMs?: number;
	// 求人が終端（ready/failed）に達したときの通知（親が pending から外す／再ランキングする契機）。
	onJobSettled?: (jobId: string) => void;
}

// 初期ロード時に並べる Skeleton の安定キー。確定後のカード数の目安に合わせて数件出す。
const LOADING_SKELETON_KEYS = ["s1", "s2", "s3"];

// JobDetailResponse から一覧行（RankingItem）へ寄せる。company/title は詳細応答の companyName/jobTitle を
// そのまま使う（#200）。確定ランキング再取得（onJobSettled 経由）を待たず楽観的カードにも実値を表示する。
// 軸別スコアは詳細応答の breakdown から集約する（次の /api/ranking 再取得を待たず反映・#202）。
// reputation は渡さない: サーバ側 toRankingItem（ranking-list.ts）も breakdown のみで集約する
// （企業評判の合流は #202 のスコープ外・follow-up #181 の課題）。ここで reputation を混ぜると
// 楽観カード→再取得後の確定カードで company 軸の値が変化なしに見た目だけ変わってしまう。
function toRankingItem(detail: JobDetailResponse): RankingItem {
	return {
		jobId: detail.job.jobId,
		sourceUrl: detail.job.sourceUrl,
		company: detail.job.companyName,
		title: detail.job.jobTitle,
		total: detail.total,
		status: detail.extraction.status,
		rejectedBy: null,
		categoryScores: aggregateCategoryScores(detail.breakdown),
	};
}

interface PendingJobProps {
	readonly jobId: string;
	// 暫定表示順位（確定ランキングの末尾へ続けて並べる）。
	readonly rank: number;
	readonly fetcher?: JobDetailFetcher;
	readonly intervalMs?: number;
	readonly onSelect: (item: RankingItem) => void;
	readonly onSettled?: (jobId: string) => void;
}

// 投入直後の 1 件。抽出中は Skeleton、scored で楽観的に通常カードへ差し替える（#112）。
function PendingJob({
	jobId,
	rank,
	fetcher,
	intervalMs,
	onSelect,
	onSettled,
}: PendingJobProps): JSX.Element {
	const { phase, detail } = useJobStatus(jobId, { fetcher, intervalMs });
	// 通知は jobId ごとに 1 回だけ。onSettled の参照が毎回変わっても重複発火させない。
	const settledRef = useRef(false);

	useEffect(() => {
		// 終端に達したら親へ通知（pending から外す／再ランキングの契機）。
		if (phase !== "extracting" && !settledRef.current) {
			settledRef.current = true;
			onSettled?.(jobId);
		}
	}, [phase, jobId, onSettled]);

	if (phase === "extracting" || detail === null) {
		return <ScoreSkeleton testId="pending-skeleton" />;
	}
	if (phase === "failed") {
		return (
			<p role="alert" data-testid="pending-failed">
				抽出に失敗しました。
			</p>
		);
	}
	const item = toRankingItem(detail);
	return (
		<RankingCard
			item={item}
			rank={rank}
			onSelect={() => onSelect(item)}
			testId="pending-card"
		/>
	);
}

export function Dashboard({
	rankingFetcher,
	pendingJobIds = [],
	jobStatusFetcher,
	jobStatusIntervalMs,
	onJobSettled,
}: DashboardProps): JSX.Element {
	const ranking = useRanking(rankingFetcher);
	// 選択中の求人。null なら詳細ドロワーは閉じる。
	const [selected, setSelected] = useState<RankingItem | null>(null);

	// 投入中カードは確定ランキングの末尾へ続けて並べる（再ランキングまでの暫定位置）。
	const rankedCount = ranking.status === "success" ? ranking.jobs.length : 0;

	return (
		<section data-testid="dashboard-view" className="p-4">
			<h2 className="sr-only">ランキング</h2>

			{ranking.status === "loading" && (
				<ol
					data-testid="ranking-loading"
					role="status"
					aria-label="ランキングを読み込み中"
					className="flex flex-col gap-3"
				>
					{LOADING_SKELETON_KEYS.map((key) => (
						<li key={key}>
							<ScoreSkeleton />
						</li>
					))}
				</ol>
			)}

			{ranking.status === "error" && (
				<p role="alert">ランキングの取得に失敗しました。</p>
			)}

			{ranking.status === "success" && (
				<>
					{ranking.jobs.length > 0 && (
						<ol
							data-testid="ranking-hero-region"
							className="grid grid-cols-1 gap-3 md:grid-cols-2"
						>
							<li className="md:row-span-2">
								<RankingPodium
									item={ranking.jobs[0]}
									rank={1}
									onSelect={() => setSelected(ranking.jobs[0])}
								/>
							</li>
							{ranking.jobs.slice(1, 3).map((job, index) => (
								<li key={job.jobId}>
									<RankingPodium
										item={job}
										rank={(index + 2) as MedalRank}
										onSelect={() => setSelected(job)}
									/>
								</li>
							))}
						</ol>
					)}
					{ranking.jobs.length > 3 && (
						<ol
							data-testid="ranking-grid-region"
							className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
						>
							{ranking.jobs.slice(3).map((job, index) => (
								<li key={job.jobId}>
									<RankingCard
										item={job}
										rank={index + 4}
										onSelect={() => setSelected(job)}
									/>
								</li>
							))}
						</ol>
					)}
				</>
			)}

			{pendingJobIds.length > 0 && (
				<ol
					data-testid="pending-list"
					aria-label="投入中の求人"
					className="mt-3 flex flex-col gap-3"
				>
					{pendingJobIds.map((jobId, index) => (
						<li key={jobId}>
							<PendingJob
								jobId={jobId}
								rank={rankedCount + index + 1}
								fetcher={jobStatusFetcher}
								intervalMs={jobStatusIntervalMs}
								onSelect={setSelected}
								onSettled={onJobSettled}
							/>
						</li>
					))}
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
