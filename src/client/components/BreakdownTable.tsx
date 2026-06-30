import { type JSX, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CoverageValue, NormalizedKey } from "../../shared/job-schema";
import type {
	BreakdownRow,
	HardFilterMode,
	JobReputation,
} from "../lib/jobDetail";

// フラット内訳表（設計書 §4.4 / 実装計画 Task 18 / #111）。
//
// なぜフラット表か:
// - 採点根拠は「カテゴリ別アコーディオン」にせず 1 枚のフラット表で一覧する（設計書 §4.4・複雑化回避）。
//   各行に 項目・抽出値・希望値・サブスコア・重み。unknown 中立は明示、ハードフィルタはバッジ。
// - benefitsCoverage のみ「充足度 NN%」1 行＋展開で signal 内訳を見せる（抽出は厚く・表示は 1 スコア・§5.2）。
// - スコア値・included・hardFilter は API が決定する（抽出↔スコア分離）。本表は表示するだけ。

// 正規キーの表示名（UI ラベル）。正規キー集合は job-schema が単一ソース、表示名のみここで持つ。
const KEY_LABELS: Record<NormalizedKey, string> = {
	annualSalary: "想定年収",
	bonus: "賞与",
	overtime: "残業",
	annualHolidays: "年間休日",
	benefitsCoverage: "福利厚生",
	remoteWork: "リモート",
	flexWork: "フレックス",
	skillMatch: "スキル適合",
	companySize: "企業規模",
	capital: "資本金",
};

// 値なし・未設定の表示。unknown 中立や空 raw は「—」で揃える。
const EMPTY_MARK = "—";

// 希望値（任意形の JSON）を 1 行のテキストへ整える（決定的）。
function formatDesired(desired: unknown): string {
	if (desired === null || desired === undefined) return EMPTY_MARK;
	if (typeof desired === "string")
		return desired.length > 0 ? desired : EMPTY_MARK;
	if (typeof desired === "number" || typeof desired === "boolean")
		return String(desired);
	if (Array.isArray(desired))
		return desired.length > 0 ? desired.join(", ") : EMPTY_MARK;
	if (typeof desired === "object") {
		const obj = desired as Record<string, unknown>;
		// レンジ希望値 {min,max} は範囲表記にする。
		if ("min" in obj || "max" in obj) {
			const min = obj.min ?? "";
			const max = obj.max ?? "";
			return `${min}〜${max}`;
		}
		return JSON.stringify(desired);
	}
	return EMPTY_MARK;
}

// 抽出値(raw) の表示。空文字は「—」に揃える。
function formatRaw(raw: string): string {
	return raw.trim().length > 0 ? raw : EMPTY_MARK;
}

// サブスコア表示。unknown 中立（null）は「—」、それ以外は 0..1 を 2 桁で表す。
function formatScore(score: number | null): string {
	return score === null ? EMPTY_MARK : score.toFixed(2);
}

// ハードフィルタのバッジ表記。none は表示しない。
const HARD_FILTER_LABELS: Record<Exclude<HardFilterMode, "none">, string> = {
	required: "必須",
	exclude: "除外",
};

function HardFilterBadge({
	mode,
}: {
	mode: HardFilterMode;
}): JSX.Element | null {
	if (mode === "none") return null;
	return (
		<Badge
			variant={mode === "exclude" ? "destructive" : "secondary"}
			data-testid="hard-filter-badge"
		>
			{HARD_FILTER_LABELS[mode]}
		</Badge>
	);
}

// 企業評判の出所 1 件の表記（出所名・ネイティブスコア・件数）。未取得値は「—」で揃える（#117）。
function formatReputationSource(
	source: JobReputation["sources"][number],
): string {
	const score = source.overallScore === null ? EMPTY_MARK : source.overallScore;
	const count = source.reviewCount === null ? "" : `・${source.reviewCount}件`;
	return `${source.source}（${score}${count}）`;
}

export interface BreakdownTableProps {
	// 内訳行（NORMALIZED_KEYS 順・全正規キー）。
	rows: readonly BreakdownRow[];
	// benefitsCoverage の signal 内訳（展開表示用）。kind!=="coverage" や未取得時は null。
	coverage?: CoverageValue | null;
	// 企業評判寄与（#117）。company 軸へ合流する出所・スコアを明示する。未取得・未設定は中立表示。
	reputation?: JobReputation | null;
	className?: string;
}

export function BreakdownTable({
	rows,
	coverage = null,
	reputation = null,
	className,
}: BreakdownTableProps): JSX.Element {
	// 福利厚生の signal 内訳の開閉。フラット表のうち benefits のみ「1 行＋展開」。
	const [coverageOpen, setCoverageOpen] = useState(false);
	const hasSignals = coverage !== null && (coverage.signals?.length ?? 0) > 0;

	return (
		<Table className={className} data-testid="breakdown-table">
			<TableHeader>
				<TableRow>
					<TableHead>項目</TableHead>
					<TableHead>抽出値</TableHead>
					<TableHead>希望値</TableHead>
					<TableHead>サブスコア</TableHead>
					<TableHead>重み</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => {
					const isCoverageRow = row.key === "benefitsCoverage";
					// unknown 中立（included=false / score=null）は分母から除外される行。視覚的に明示する。
					const neutral = !row.included || row.score === null;
					return (
						<TableRow
							key={row.key}
							data-testid={`breakdown-row-${row.key}`}
							data-included={String(row.included)}
							className={cn(neutral && "text-muted-foreground")}
						>
							<TableCell className="font-medium">
								<span className="flex items-center gap-2">
									{KEY_LABELS[row.key]}
									<HardFilterBadge mode={row.hardFilter} />
								</span>
							</TableCell>
							<TableCell>
								{isCoverageRow && coverage !== null ? (
									<span className="flex flex-col gap-1">
										<span>
											充足度{" "}
											{coverage.total > 0
												? `${Math.round((coverage.present / coverage.total) * 100)}%`
												: EMPTY_MARK}
										</span>
										{hasSignals && (
											<>
												<button
													type="button"
													data-testid="coverage-toggle"
													aria-expanded={coverageOpen}
													onClick={() => setCoverageOpen((v) => !v)}
													className="w-fit text-xs underline underline-offset-2"
												>
													{coverageOpen ? "内訳を隠す" : "内訳を表示"}
												</button>
												{coverageOpen && (
													<ul
														data-testid="coverage-signals"
														className="list-disc pl-4 text-xs"
													>
														{coverage.signals?.map((signal) => (
															<li key={signal}>{signal}</li>
														))}
													</ul>
												)}
											</>
										)}
									</span>
								) : (
									formatRaw(row.raw)
								)}
							</TableCell>
							<TableCell>{formatDesired(row.desired)}</TableCell>
							<TableCell>
								<span className="flex items-center gap-2">
									{formatScore(row.score)}
									{neutral && (
										<Badge variant="outline" data-testid="neutral-badge">
											中立
										</Badge>
									)}
								</span>
							</TableCell>
							<TableCell>{row.weight}</TableCell>
						</TableRow>
					);
				})}

				{reputation !== null && (
					// 企業評判は独立軸でなく company 軸へ合流する 1 項目（#117）。出所・スコアを明示し、
					// 中立（score=null＝データなし / APIキー未設定 / 低信頼除外）は分母から外れることを示す。
					<TableRow
						data-testid="breakdown-row-reputation"
						className={cn(reputation.score === null && "text-muted-foreground")}
					>
						<TableCell className="font-medium">
							<span className="flex items-center gap-2">
								企業評判
								{reputation.confidence === "low" && (
									<Badge
										variant="outline"
										data-testid="reputation-low-confidence"
									>
										低信頼
									</Badge>
								)}
							</span>
						</TableCell>
						<TableCell>
							{reputation.sources.length > 0 ? (
								<span
									data-testid="reputation-sources"
									className="flex flex-col gap-1 text-xs"
								>
									{reputation.sources.map((s) => (
										<span key={s.source}>{formatReputationSource(s)}</span>
									))}
								</span>
							) : (
								EMPTY_MARK
							)}
						</TableCell>
						<TableCell>{EMPTY_MARK}</TableCell>
						<TableCell>
							<span className="flex items-center gap-2">
								{formatScore(reputation.score)}
								{reputation.score === null && (
									<Badge
										variant="outline"
										data-testid="reputation-neutral-badge"
									>
										中立
									</Badge>
								)}
							</span>
						</TableCell>
						<TableCell>{reputation.weight}</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);
}
