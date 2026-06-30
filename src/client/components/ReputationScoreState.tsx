import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
	describeReputationDisplay,
	type ReputationConfidence,
} from "../lib/reputationDisplay";

// 評判の中立扱い・低信頼フラグの表示部品（#37）。
//
// なぜ独立コンポーネントか:
// - 設定 UI（ReputationApiKeySection の score placeholder 差替）と、将来 #117 が求人詳細へ実データを渡す
//   表示を、同一の中立/低信頼表現で再利用する純表示部品にする（取得・集約は呼び出し側）。
// - 中立/低信頼バッジは BreakdownTable の既存パターン（outline バッジ・text-muted-foreground）に合わせる。
//   勝手に新流儀を持ち込まない。
// - 実データ（score/confidence）の供給は #117。本部品は props を表示するだけ（抽出↔スコア分離）。

export interface ReputationScoreStateProps {
	// ANTHROPIC_API_KEY の構成状態。未設定なら評判は取得できず中立。
	readonly apiKeyConfigured: boolean;
	// 評判寄与スコア（0..1）。データなし・中立は null/省略。供給は #117。
	readonly score?: number | null;
	// 信頼度。省略時は none（データなし＝中立）。
	readonly confidence?: ReputationConfidence;
	readonly className?: string;
}

export function ReputationScoreState({
	apiKeyConfigured,
	score,
	confidence,
	className,
}: ReputationScoreStateProps): JSX.Element {
	const display = describeReputationDisplay({
		apiKeyConfigured,
		score,
		confidence,
	});

	return (
		<div
			data-testid="reputation-score-state"
			data-neutral={String(display.neutral)}
			data-low-confidence={String(display.lowConfidence)}
			className={cn(
				"space-y-1 text-sm",
				display.neutral && "text-muted-foreground",
				className,
			)}
		>
			<p className="flex items-center gap-2">
				<span className="font-medium">{display.statusLabel}:</span>
				<span data-testid="reputation-score-value">{display.scoreText}</span>
				{display.neutral && (
					<Badge variant="outline" data-testid="reputation-neutral-badge">
						中立
					</Badge>
				)}
				{display.lowConfidence && (
					<Badge
						variant="outline"
						data-testid="reputation-low-confidence-badge"
					>
						低信頼
					</Badge>
				)}
			</p>
			{display.note !== "" && (
				<p data-testid="reputation-score-note" className="text-gray-500">
					{display.note}
				</p>
			)}
		</div>
	);
}
