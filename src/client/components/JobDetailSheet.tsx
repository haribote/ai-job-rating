import { type JSX, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { aggregateCategoryScores } from "../../shared/categoryScores";
import {
	fetchJobDetail,
	type JobDetailFetcher,
	type JobDetailResponse,
	type ReextractAction,
	reextractJob,
} from "../lib/jobDetail";
import type { RankingItem } from "../lib/useRanking";
import { BreakdownTable } from "./BreakdownTable";
import { RadarAxisLegend } from "./RadarAxisLegend";
import { formatScore, SCORE_UNAVAILABLE_NOTE } from "./RankingCard";
import { radarAccentColorForRank } from "./RankingPodium";
import { ScoreRadar } from "./ScoreRadar";

// 求人詳細の右ドロワー（設計書 §4.4 / 実装計画 Task 18 / #111）。
//
// 構成（ガワは #108・中身は本 issue）:
// - ヘッダ: 求人名・総合スコア・抽出メタ（モデル/機構/状態）。
// - サマリ レーダー: フラット内訳を 5 軸へ集約（categoryScores 純関数）し ScoreRadar で表示。
// - フラット内訳表: BreakdownTable（カテゴリ別アコーディオンにしない・§4.4）。
// - アクション 2 つ: 「再抽出」（POST /api/jobs/:id/reextract）・「評判取得」（前提未設定なら無効＋案内文）。
//
// なぜ詳細を遅延取得するか:
// - 一覧（GET /api/ranking）は軽量行のみ。内訳・抽出メタは開いたときに GET /api/jobs/:id で取得する。
// - 取得関数・再抽出関数は注入可能にし、jsdom テストをネットワーク非依存・決定的に保つ。

// 詳細取得の状態機械。
type DetailState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "success"; readonly detail: JobDetailResponse };

// 再抽出ボタンの状態。
type ReextractState = "idle" | "running" | "done" | "error";

export interface JobDetailSheetProps {
	// 選択中の求人（未選択は null）。
	job: RankingItem | null;
	// 選択中の求人の表示順位（未選択は null）。1〜3位はレーダー色を枠色に合わせる（あしらい調整）。
	rank?: number | null;
	// ドロワーの開閉。
	open: boolean;
	// 開閉変更（オーバーレイ／閉じるボタン／Esc を含む）。
	onOpenChange: (open: boolean) => void;
	// 詳細取得関数（既定は GET /api/jobs/:id）。テストはフェイクを注入する。
	detailFetcher?: JobDetailFetcher;
	// 再抽出関数（既定は POST /api/jobs/:id/reextract）。テストはフェイクを注入する。
	reextract?: ReextractAction;
	// 企業評判の前提（ANTHROPIC_API_KEY 等）が満たされているか。
	// 未設定（既定 false）は実行ボタン無効＋設定への案内文（実 API 配線は評判 issue 群の follow-up）。
	reputationAvailable?: boolean;
}

export function JobDetailSheet({
	job,
	rank = null,
	open,
	onOpenChange,
	detailFetcher = fetchJobDetail,
	reextract = reextractJob,
	reputationAvailable = false,
}: JobDetailSheetProps): JSX.Element {
	const [detail, setDetail] = useState<DetailState>({ status: "idle" });
	const [reextractState, setReextractState] = useState<ReextractState>("idle");

	const jobId = job?.jobId ?? null;

	// 開いている間だけ詳細を取得する。閉じる／別求人へ切替で状態をリセットする。
	useEffect(() => {
		if (!open || jobId === null) {
			setDetail({ status: "idle" });
			setReextractState("idle");
			return;
		}
		let active = true;
		setDetail({ status: "loading" });
		detailFetcher(jobId)
			.then((data) => {
				if (active) setDetail({ status: "success", detail: data });
			})
			.catch(() => {
				if (active) setDetail({ status: "error" });
			});
		return () => {
			active = false;
		};
	}, [open, jobId, detailFetcher]);

	// company/title は契約上 null のことがある。sourceUrl をタイトル代替にする。
	const heading = job?.title ?? job?.company ?? job?.sourceUrl ?? "求人詳細";

	function onReextractClick(): void {
		if (jobId === null) return;
		setReextractState("running");
		reextract(jobId)
			.then(() => setReextractState("done"))
			.catch(() => setReextractState("error"));
	}

	const successDetail = detail.status === "success" ? detail.detail : null;
	// 旧抽出は benefitsCoverage を欠くことがあるため optional chain で防御する（描画クラッシュ回避）。
	const coverage =
		successDetail?.extraction.structured.benefitsCoverage?.kind === "coverage"
			? successDetail.extraction.structured.benefitsCoverage
			: null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				data-testid="job-detail-sheet"
				className="w-full overflow-y-auto sm:max-w-2xl"
			>
				<SheetHeader>
					<SheetTitle>{heading}</SheetTitle>
					<SheetDescription>
						採点根拠（フラット内訳）と再抽出・評判取得を行います。
					</SheetDescription>
				</SheetHeader>

				{detail.status === "loading" && (
					<p data-testid="detail-loading" className="py-4 text-sm">
						読み込み中...
					</p>
				)}

				{detail.status === "error" && (
					<p role="alert" className="py-4 text-sm">
						詳細の取得に失敗しました。
					</p>
				)}

				{successDetail !== null && (
					<div className="flex flex-col gap-6 py-4">
						<div className="flex flex-wrap items-center gap-3 text-sm">
							<Badge variant="outline">
								状態: {successDetail.extraction.status}
							</Badge>
							<span className="text-muted-foreground">
								総合スコア: {formatScore(successDetail.total)}
								{successDetail.total === null && (
									// ready なのに未算出（設定不足等）を一覧カードと同じ文言・条件で明示する
									// （#199: RankingCard の score-unavailable-note と単一ソース）。
									<span
										role="status"
										data-testid="detail-score-unavailable-note"
										className="ml-1"
									>
										・{SCORE_UNAVAILABLE_NOTE}
									</span>
								)}
							</span>
							<span className="text-muted-foreground">
								モデル: {successDetail.extraction.model}
							</span>
							<span className="text-muted-foreground">
								機構: {successDetail.extraction.mechanism}
							</span>
							{/* 貼り付け取込は sourceUrl が合成値（paste:<id>）で外部URLでないため出さない。 */}
							{!successDetail.job.sourceUrl.startsWith("paste:") && (
								<a
									href={successDetail.job.sourceUrl}
									target="_blank"
									rel="noreferrer"
									data-testid="source-url-link"
									className="text-muted-foreground underline"
								>
									元の求人ページ
								</a>
							)}
						</div>

						<ScoreRadar
							scores={aggregateCategoryScores(
								successDetail.breakdown,
								successDetail.reputation,
							)}
							accentColor={
								rank !== null ? radarAccentColorForRank(rank) : undefined
							}
							className="max-w-xs"
						/>
						{/* レーダーの軸は番号（1〜5）表示のため、単体の詳細ドロワーでも番号↔カテゴリ名の
						対応を引けるよう凡例を併設する（Dashboard と同じ RadarAxisLegend・#203）。 */}
						<RadarAxisLegend />

						<BreakdownTable
							rows={successDetail.breakdown}
							coverage={coverage}
							reputation={successDetail.reputation}
						/>
					</div>
				)}

				<SheetFooter className="flex-col items-stretch gap-3 sm:flex-col">
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							onClick={onReextractClick}
							disabled={reextractState === "running" || jobId === null}
							data-testid="reextract-button"
						>
							{reextractState === "running" ? "再抽出中..." : "再抽出"}
						</Button>

						<Button
							type="button"
							variant="secondary"
							disabled={!reputationAvailable}
							data-testid="reputation-button"
						>
							評判取得
						</Button>
					</div>

					{reextractState === "done" && (
						<p
							data-testid="reextract-done"
							className="text-sm text-muted-foreground"
						>
							再抽出を開始しました。完了後に再度開くと反映されます。
						</p>
					)}
					{reextractState === "error" && (
						<p role="alert" className="text-sm">
							再抽出の開始に失敗しました。
						</p>
					)}

					{!reputationAvailable && (
						<p
							data-testid="reputation-hint"
							className="text-sm text-muted-foreground"
						>
							企業評判の取得には ANTHROPIC_API_KEY
							の設定が必要です。設定画面から登録してください。
						</p>
					)}
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
