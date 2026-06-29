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

// 抽出ポーリングの表示フェーズ。
// extracting: scored 前（fetched/extracted）または未永続。Skeleton を出す。
// ready: scored 完了。カードへ差し替える。
// failed: 取得/抽出が恒久失敗。
export type JobPhase = "extracting" | "ready" | "failed";

// サーバ JobStatus 文字列から表示フェーズを決める純関数（決定的）。
// scored=完了 / failed=失敗 / それ以外（fetched・extracted）=抽出中。
export function deriveJobPhase(jobStatus: string): JobPhase {
	switch (jobStatus) {
		case "scored":
			return "ready";
		case "failed":
			return "failed";
		default:
			return "extracting";
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
		phase: "extracting",
		detail: null,
	});

	useEffect(() => {
		if (jobId === null) {
			setState({ phase: "extracting", detail: null });
			return;
		}
		// アンマウント後／jobId 変更後の setState・再ポーリングを防ぐガード。
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setState({ phase: "extracting", detail: null });

		const poll = async (): Promise<void> => {
			let next: JobStatusState;
			try {
				const detail = await fetcher(jobId);
				next = { phase: deriveJobPhase(detail.job.status), detail };
			} catch {
				// 未永続（404）・transient はまだ抽出中とみなし再試行する。
				next = { phase: "extracting", detail: null };
			}
			if (!active) return;
			setState(next);
			// 終端（ready/failed）に達したらポーリングを止める。
			if (next.phase === "extracting") {
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
