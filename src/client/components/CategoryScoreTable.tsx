import type { JSX } from "react";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { formatScore } from "../lib/formatScore";

// 1位カードのカテゴリ別スコアテーブル（#203 方針転換）。
//
// なぜこのコンポーネントか:
// - 独立した凡例欄（ダッシュボード単位の RadarAxisLegend）を廃止した代わりに、1位カードの
//   テーブルへ番号列を残すことで番号→カテゴリ名の対応表を兼ねる（2位以下は引き続き番号のみの軸ラベル）。
// - スコアは categoryScores（0..1）を ×100 し、総合スコアと同じ formatScore を再利用して
//   スケール・精度（toFixed(2)・null→「—」）を統一する。

export interface CategoryScoreTableProps {
	readonly scores: Record<CategoryKey, number | null>;
	readonly className?: string;
}

export function CategoryScoreTable({
	scores,
	className,
}: CategoryScoreTableProps): JSX.Element {
	return (
		<Table data-testid="category-score-table" className={className}>
			<TableBody>
				{CATEGORY_KEYS.map((key) => {
					const score = scores[key];
					return (
						<TableRow key={key}>
							<TableCell className="p-1 text-xs tabular-nums text-muted-foreground">
								{CATEGORY_AXIS_NUMBERS[key]}
							</TableCell>
							<TableCell className="p-1 text-xs">
								{CATEGORY_LABELS[key]}
							</TableCell>
							<TableCell className="p-1 text-right text-xs tabular-nums">
								{formatScore(score === null ? null : score * 100)}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
