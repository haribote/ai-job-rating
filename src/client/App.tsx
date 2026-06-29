import { type JSX, useState, useSyncExternalStore } from "react";
import {
	AddJobModal,
	type SubmitJob,
	type SubmitJobResponse,
} from "./components/AddJobModal";
import { TopBar } from "./components/TopBar";
import { fetchJobDetail, type JobDetailFetcher } from "./lib/jobDetail";
import type { RankingFetcher } from "./lib/useRanking";
import { Dashboard } from "./routes/Dashboard";
import { Settings } from "./routes/Settings";

// 最小 router: History API の pathname を購読し、`/`（ダッシュボード）と `/settings`（設定）を出し分ける。
// Wave 3（#108–#114）が本格 UI（ランキングカード・詳細ドロワー・設定ビュー）を載せるための足場であり、
// react-router 等の外部依存は持ち込まずに最小の責務（ルート判定とナビゲーション）だけを提供する。

type Route = "dashboard" | "settings";

function pathToRoute(pathname: string): Route {
	return pathname === "/settings" ? "settings" : "dashboard";
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener("popstate", onChange);
	return () => {
		window.removeEventListener("popstate", onChange);
	};
}

// pushState は popstate を発火しないため、ナビゲーション後に手動でイベントを流して購読側を更新する。
export function navigate(path: string): void {
	if (path === window.location.pathname) {
		return;
	}
	window.history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePathname(): string {
	return useSyncExternalStore(
		subscribe,
		() => window.location.pathname,
		() => "/",
	);
}

// 投入応答から pending に積む jobId を決める（決定的・#169）。
// 201 詳細/貼付は {jobId,status} で個別 ID を持つので楽観表示の対象。
// 202 一覧 URL は {status:"queued",count} で個別 ID を持たないので積まない（従来どおり ranking 再取得で反映）。
export function pendingIdFromResponse(
	response: SubmitJobResponse,
): string | null {
	return "jobId" in response ? response.jobId : null;
}

// pending リストへ jobId を積む（重複は積まない）。
export function addPendingId(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? [...ids] : [...ids, id];
}

// pending リストから jobId を外す。
export function removePendingId(ids: readonly string[], id: string): string[] {
	return ids.filter((existing) => existing !== id);
}

export interface AppProps {
	// ランキング取得関数（既定は GET /api/ranking）。テストはフェイクを注入する。
	rankingFetcher?: RankingFetcher;
	// 抽出状態のポーリング取得関数（既定は GET /api/jobs/:id・module-level で安定参照）。
	jobStatusFetcher?: JobDetailFetcher;
	// ポーリング間隔（ms）。テストで短縮する。
	jobStatusIntervalMs?: number;
	// 投入関数（既定は POST /api/jobs）。テストはフェイクを注入する。
	submitJob?: SubmitJob;
}

export function App({
	rankingFetcher,
	jobStatusFetcher = fetchJobDetail,
	jobStatusIntervalMs,
	submitJob,
}: AppProps = {}): JSX.Element {
	const route = pathToRoute(usePathname());
	// 投入モーダルの開閉（#113）。状態は親が持ち、TopBar は純粋な表示部品に保つ。
	const [addJobOpen, setAddJobOpen] = useState(false);
	// 投入直後でまだランキングに現れない求人 ID（#169 で投入フローから供給）。
	// 各 ID は #112 の seam（useJobStatus ポーリング）で Skeleton→楽観カードへ差し替わる。
	const [pendingJobIds, setPendingJobIds] = useState<readonly string[]>([]);
	// ranking 再取得用の nonce。Dashboard の key に渡して再マウントさせ GET /api/ranking を再取得する。
	// 投入時ではなく「必要時のみ」増やす: 202 一覧投入時と、pending が scored で終端したとき（settle）。
	// 201 投入は pending 楽観表示に任せ、即時の再取得はしない（二重発火を避ける）。
	const [reloadKey, setReloadKey] = useState(0);

	// 投入成功（POST /api/jobs の応答）を pending seam へ配線する（#169）。
	function handleSubmitted(response: SubmitJobResponse): void {
		const jobId = pendingIdFromResponse(response);
		if (jobId !== null) {
			// 201: その求人だけ pending で楽観表示する（settle まで ranking は再取得しない）。
			setPendingJobIds((ids) => addPendingId(ids, jobId));
		} else {
			// 202 queued: 個別 ID がないので従来どおり ranking 再取得で反映する。
			setReloadKey((key) => key + 1);
		}
		// 投入後は一覧（ダッシュボード）へ戻す。
		navigate("/");
	}

	// pending の求人が終端（scored/failed）に達したときの整合（#169）。
	// pending から外し、ranking を 1 回だけ再取得して確定カードへ統合する（二重取得しない）。
	function handleJobSettled(jobId: string): void {
		setPendingJobIds((ids) => removePendingId(ids, jobId));
		setReloadKey((key) => key + 1);
	}

	return (
		<div data-app-shell>
			<TopBar
				onNavigateHome={() => navigate("/")}
				onSubmitJob={() => setAddJobOpen(true)}
				onOpenSettings={() => navigate("/settings")}
			/>
			<main>
				{route === "settings" ? (
					<Settings />
				) : (
					<Dashboard
						key={reloadKey}
						rankingFetcher={rankingFetcher}
						pendingJobIds={pendingJobIds}
						jobStatusFetcher={jobStatusFetcher}
						jobStatusIntervalMs={jobStatusIntervalMs}
						onJobSettled={handleJobSettled}
					/>
				)}
			</main>
			<AddJobModal
				open={addJobOpen}
				onOpenChange={setAddJobOpen}
				submit={submitJob}
				onSubmitted={handleSubmitted}
			/>
		</div>
	);
}
