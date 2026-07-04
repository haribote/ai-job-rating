import { useEffect, useState } from "react";
import {
	fetchJobDetail,
	type JobDetailFetcher,
	type JobDetailResponse,
} from "./jobDetail";

// 単一求人の抽出状態をポーリングする React フック（#112 / Task 19）。
//
// なぜ存在するか:
// - 投入直後の求人は scored になるまでランキング（GET /api/ranking）に現れない。jobId を起点に
//   GET /api/jobs/:id をポーリングし、抽出完了で楽観的にカードへ差し替える材料（phase + detail）を供給する。
// - ポーリングの状態遷移は決定的ロジックなのでユニットテストで担保する（fetcher 注入・interval 短縮）。
// - 契約消費のみ。抽出↔スコア分離・unknown 中立・正規化はサーバ責務（本フックは再実装しない）。

// 抽出ポーリングの表示フェーズ（#199: fetched/extracted を取得中/採点中に細分）。
// fetching: 取得済み・抽出未着手（サーバ JobStatus "fetched" または未永続）。Skeleton + 取得中バッジ。
// scoring: 抽出済み・採点未着手（サーバ JobStatus "extracted"）。Skeleton + 採点中バッジ。
// ready: scored 完了。カードへ差し替える。
// failed: 取得/抽出が恒久失敗。
export type JobPhase = "fetching" | "scoring" | "ready" | "failed";

// pending（未終端）なフェーズの集合。isPendingPhase の型ガードと単一ソースを共有する
// （JobPhaseBadge 等の consumer が別々に定義して定義がずれるのを防ぐ）。
export type PendingJobPhase = Extract<JobPhase, "fetching" | "scoring">;

// pending（未終端）なフェーズか。終端（ready/failed）はポーリング停止・Skeleton 非表示の判定に使う。
export function isPendingPhase(phase: JobPhase): phase is PendingJobPhase {
	return phase === "fetching" || phase === "scoring";
}

// サーバ JobStatus 文字列から表示フェーズを決める純関数（決定的）。
// scored=完了 / failed=失敗 / extracted=採点中 / それ以外（fetched・未知値）=取得中。
export function deriveJobPhase(jobStatus: string): JobPhase {
	switch (jobStatus) {
		case "scored":
			return "ready";
		case "failed":
			return "failed";
		case "extracted":
			return "scoring";
		default:
			return "fetching";
	}
}

export interface JobStatusState {
	readonly phase: JobPhase;
	// 直近に取得した詳細（未取得は null）。ready 時はこれを使ってカードを描く。
	readonly detail: JobDetailResponse | null;
}

export interface UseJobStatusOptions {
	// 詳細取得関数（既定は GET /api/jobs/:id）。テストはフェイクを注入する（安定参照前提）。
	readonly fetcher?: JobDetailFetcher;
	// ポーリング間隔（ms）。
	readonly intervalMs?: number;
}

// 既定ポーリング間隔（ms）。抽出は数秒〜十数秒かかるため過剰な負荷を避ける。
const DEFAULT_INTERVAL_MS = 2000;

export function useJobStatus(
	jobId: string | null,
	options: UseJobStatusOptions = {},
): JobStatusState {
	const { fetcher = fetchJobDetail, intervalMs = DEFAULT_INTERVAL_MS } =
		options;
	const [state, setState] = useState<JobStatusState>({
		phase: "fetching",
		detail: null,
	});

	useEffect(() => {
		if (jobId === null) {
			setState({ phase: "fetching", detail: null });
			return;
		}
		// アンマウント後／jobId 変更後の setState・再ポーリングを防ぐガード。
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 直近の確定状態（#199: 取得中/採点中を細分した結果、transient エラーで単純に
		// "fetching" へ戻すと採点中→取得中のようにフェーズが後退して見える。エラーは
		// 直前の状態を保って再試行するだけにし、既に進んだフェーズを後退させない）。
		let lastState: JobStatusState = { phase: "fetching", detail: null };
		setState(lastState);

		const poll = async (): Promise<void> => {
			let next: JobStatusState;
			try {
				const detail = await fetcher(jobId);
				next = { phase: deriveJobPhase(detail.job.status), detail };
			} catch {
				// 未永続（404）・transient は直前の状態を保ったまま再試行する。
				next = lastState;
			}
			if (!active) return;
			lastState = next;
			setState(next);
			// 終端（ready/failed）に達したらポーリングを止める。
			if (isPendingPhase(next.phase)) {
				timer = setTimeout(poll, intervalMs);
			}
		};
		void poll();

		return () => {
			active = false;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [jobId, fetcher, intervalMs]);

	return state;
}
