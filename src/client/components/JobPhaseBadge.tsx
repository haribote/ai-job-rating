import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { JobPhase } from "../lib/useJobStatus";

// 取得中・採点中バッジ（#199）。
//
// なぜ独立コンポーネントか:
// - Skeleton（ScoreSkeleton）は装飾専用（aria-hidden）で状態を読み上げないため、
//   「処理中なのか」をユーザーが判別できるよう文言＋role="status" の実体をここへ集約する。
// - fetching/scoring の文言マッピングは決定的なので純関数（pendingPhaseLabel）へ切り出し単体テスト可能にする。

// 終端でないフェーズ（deriveJobPhase の isPendingPhase と同じ集合）だけを受け取る。
export type PendingJobPhase = Extract<JobPhase, "fetching" | "scoring">;

// フェーズ → 表示文言の決定的マッピング。
const PENDING_PHASE_LABELS: Record<PendingJobPhase, string> = {
	fetching: "取得中",
	scoring: "採点中",
};

export function pendingPhaseLabel(phase: PendingJobPhase): string {
	return PENDING_PHASE_LABELS[phase];
}

export interface JobPhaseBadgeProps {
	readonly phase: PendingJobPhase;
	readonly className?: string;
}

// role="status" で、処理中であることをスクリーンリーダーにも伝える（既存の
// ranking-loading / pending-failed と同じ role 付与の流儀）。
export function JobPhaseBadge({
	phase,
	className,
}: JobPhaseBadgeProps): JSX.Element {
	return (
		<Badge
			variant="outline"
			role="status"
			data-testid="job-phase-badge"
			data-phase={phase}
			className={cn("bg-background", className)}
		>
			{pendingPhaseLabel(phase)}
		</Badge>
	);
}
