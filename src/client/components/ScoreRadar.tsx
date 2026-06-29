import type { JSX } from "react";
import {
	PolarAngleAxis,
	PolarGrid,
	PolarRadiusAxis,
	Radar,
	RadarChart,
} from "recharts";
import { cn } from "@/lib/utils";
import {
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { type ChartConfig, ChartContainer } from "./ui/chart";

// 5軸スコアレーダー（設計書 §4.2 / 実装計画 Task 17 / #110）。
//
// なぜこのコンポーネントか:
// - カード（#109）と詳細ドロワー（#111）が同一のレーダー表現を再利用できるよう、
//   `Record<CategoryKey, number|null>` だけを受け取る純表示部品にする（取得・集約は呼び出し側）。
// - 軸の集合・順序・表示名は categories.ts を単一ソースに連動させ、ここでは重複定義しない（#101 申し送り）。
// - unknown（値なし）軸は 0 点に潰さず中立表示する（要件 §5.2）。塗りは単一アクセント色で統一する（設計書 §4.1）。

// スコアの取りうる最大値。サブスコア・カテゴリスコアは 0..1（score.ts の clamp01）。
const SCORE_MAX = 1;

// 単一アクセント系列の config キー。色は design-tokens 由来の chart-1（順位非依存の統一色）。
const SERIES_KEY = "score";

// レーダー系列の config（単一アクセント）。ChartContainer が --color-score を chart-1 に束ねる。
// design-tokens は --chart-1 を RGB チャンネル（"R G B"）で持つため rgb() で包んで有効な paint にする。
export const SCORE_RADAR_CONFIG: ChartConfig = {
	[SERIES_KEY]: { label: "スコア", color: "rgb(var(--chart-1))" },
};

// レーダー 1 軸ぶんの整形済みデータ。
export interface RadarDatum {
	readonly key: CategoryKey;
	readonly label: string;
	// 軸スコア（0..1）。unknown は 0 と区別するため null（中立）。
	readonly value: number | null;
	readonly unknown: boolean;
}

// スコア record を categories.ts の順序どおりのレーダーデータへ整形する（決定的）。
// unknown（null）は value=null・unknown=true として残し、0 点扱いにしない（§5.2）。
export function buildRadarData(
	scores: Record<CategoryKey, number | null>,
): RadarDatum[] {
	return CATEGORY_KEYS.map((key) => {
		const value = scores[key];
		return {
			key,
			label: CATEGORY_LABELS[key],
			value: value ?? null,
			unknown: value === null || value === undefined,
		};
	});
}

// recharts が PolarAngleAxis の各目盛りへ渡す props（型変動に依存しない最小形・広めに受ける）。
interface AxisTickProps {
	x?: string | number;
	y?: string | number;
	textAnchor?: string;
	payload?: { value?: string | number };
}

type SvgTextAnchor = React.SVGProps<SVGTextElement>["textAnchor"];

// 軸目盛りラベル。unknown 軸は中立（muted・破線下線）で表示し、data-unknown でマークする。
function makeAxisTick(unknownByLabel: Map<string, boolean>) {
	return function AxisTick({ x, y, textAnchor, payload }: AxisTickProps) {
		const label = String(payload?.value ?? "");
		const unknown = unknownByLabel.get(label) ?? false;
		return (
			<text
				x={x}
				y={y}
				textAnchor={textAnchor as SvgTextAnchor}
				dominantBaseline="central"
				data-unknown={unknown}
				className={cn(
					"text-xs",
					unknown
						? "fill-muted-foreground [text-decoration:underline_dashed]"
						: "fill-foreground",
				)}
			>
				{label}
			</text>
		);
	};
}

export interface ScoreRadarProps {
	// 軸ごとのスコア（0..1）。値なしは null（中立）。
	scores: Record<CategoryKey, number | null>;
	className?: string;
}

export function ScoreRadar({
	scores,
	className,
}: ScoreRadarProps): JSX.Element {
	const data = buildRadarData(scores);
	const unknownByLabel = new Map(data.map((d) => [d.label, d.unknown]));

	return (
		<ChartContainer
			config={SCORE_RADAR_CONFIG}
			className={cn("mx-auto aspect-square", className)}
		>
			<RadarChart data={data} outerRadius="70%">
				<PolarGrid className="stroke-border" />
				<PolarAngleAxis dataKey="label" tick={makeAxisTick(unknownByLabel)} />
				<PolarRadiusAxis
					domain={[0, SCORE_MAX]}
					tick={false}
					axisLine={false}
				/>
				<Radar
					dataKey="value"
					// 単一アクセント（chart-1）。unknown 軸は value=null で頂点を描かず中立を保つ。
					stroke={`var(--color-${SERIES_KEY})`}
					fill={`var(--color-${SERIES_KEY})`}
					fillOpacity={0.3}
					// 既知軸の谷を unknown の穴とつながず、データのある軸だけを結ぶ。
					connectNulls={false}
					isAnimationActive={false}
				/>
			</RadarChart>
		</ChartContainer>
	);
}
