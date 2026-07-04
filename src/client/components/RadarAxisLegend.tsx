import type { JSX } from "react";
import { cn } from "@/lib/utils";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
} from "../../shared/categories";

// レーダー軸番号 → カテゴリ名の凡例（設計書 §5.2 ラベル正規化 / #203）。
//
// なぜこのコンポーネントか:
// - ScoreRadar は狭枠でのラベル重なりを避けるため軸を番号（1〜5）で表示する。番号↔カテゴリ名の
//   対応は CATEGORY_KEYS 順で全カード共通・不変のため、カードごとに繰り返さずダッシュボード単位で
//   1 箇所だけ表示する（orchestrator 確定・#203）。
// - `ui/chart.tsx` の ChartLegend/ChartLegendContent は Recharts の系列凡例（dataKey/color の
//   ChartConfig 前提）であり、単一系列の ScoreRadar における「軸番号→軸名」対応とは目的が異なるため
//   流用せず、CATEGORY_KEYS/CATEGORY_AXIS_NUMBERS/CATEGORY_LABELS のみに依存する独立コンポーネントにする。

export interface RadarAxisLegendProps {
	className?: string;
}

export function RadarAxisLegend({
	className,
}: RadarAxisLegendProps): JSX.Element {
	return (
		<dl
			data-testid="radar-axis-legend"
			className={cn(
				"flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground",
				className,
			)}
		>
			{CATEGORY_KEYS.map((key) => (
				<div key={key} className="flex items-baseline gap-1">
					<dt className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-foreground">
						{CATEGORY_AXIS_NUMBERS[key]}
					</dt>
					<dd>{CATEGORY_LABELS[key]}</dd>
				</div>
			))}
		</dl>
	);
}
