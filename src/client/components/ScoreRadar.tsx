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
	CATEGORY_AXIS_NUMBERS,
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

// 1〜3位のみ枠色（RankingPodium の金銀銅）にレーダー色を合わせるための accent 色。
// design-tokens の medalColorMap が --medal-gold 等を :root へ既に生成しているため新規トークンは不要。
export type RadarAccentColor = "medal-gold" | "medal-silver" | "medal-bronze";

// accentColor 指定時はその順位色、未指定時は既定の SCORE_RADAR_CONFIG（chart-1）を返す（決定的）。
function radarConfigFor(accentColor?: RadarAccentColor): ChartConfig {
	if (accentColor === undefined) {
		return SCORE_RADAR_CONFIG;
	}
	return {
		[SERIES_KEY]: { label: "スコア", color: `rgb(var(--${accentColor}))` },
	};
}

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

// 軸目盛りの表示に必要な補助情報。label（PolarAngleAxis の dataKey）から引く。
interface AxisTickInfo {
	readonly number: number;
	readonly unknown: boolean;
}

// 軸目盛りラベル。狭枠でのラベル重なりを避けるため番号（CATEGORY_AXIS_NUMBERS）を描画し、
// 番号→軸名の対応は凡例（RadarAxisLegend）に委ねる（#203）。unknown 軸は中立（muted）で
// 表示し、data-unknown でマークする。軸名は <title> に残し、視覚的に消えた軸名を a11y でも引ける。
function makeAxisTick(tickInfoByLabel: Map<string, AxisTickInfo>) {
	return function AxisTick({ x, y, textAnchor, payload }: AxisTickProps) {
		const label = String(payload?.value ?? "");
		const info = tickInfoByLabel.get(label);
		const unknown = info?.unknown ?? false;
		return (
			<text
				x={x}
				y={y}
				textAnchor={textAnchor as SvgTextAnchor}
				dominantBaseline="central"
				data-unknown={unknown}
				className={cn(
					"text-xs",
					unknown ? "fill-muted-foreground" : "fill-foreground",
				)}
			>
				<title>{label}</title>
				{info?.number ?? ""}
			</text>
		);
	};
}

export interface ScoreRadarProps {
	// 軸ごとのスコア（0..1）。値なしは null（中立）。
	scores: Record<CategoryKey, number | null>;
	// 1〜3位のみ指定。未指定（4位以下）は既定の単一アクセント色（chart-1）のまま。
	accentColor?: RadarAccentColor;
	className?: string;
}

export function ScoreRadar({
	scores,
	accentColor,
	className,
}: ScoreRadarProps): JSX.Element {
	const data = buildRadarData(scores);
	const tickInfoByLabel = new Map<string, AxisTickInfo>(
		data.map((d) => [
			d.label,
			{ number: CATEGORY_AXIS_NUMBERS[d.key], unknown: d.unknown },
		]),
	);

	return (
		<ChartContainer
			config={radarConfigFor(accentColor)}
			className={cn("mx-auto aspect-square", className)}
		>
			<RadarChart data={data} outerRadius="70%">
				<PolarGrid className="stroke-border" />
				<PolarAngleAxis
					dataKey="label"
					tick={makeAxisTick(tickInfoByLabel)}
					// 既定の tickLine（頂点から8px外へ伸びる目盛り線）と axisLine（PolarGrid の外周と
					// 重複する五角形の輪郭）がラベルに刺さって見えるため消す（あしらい調整）。
					axisLine={false}
					tickLine={false}
				/>
				<PolarRadiusAxis
					domain={[0, SCORE_MAX]}
					tick={false}
					axisLine={false}
					// allowDecimals 未指定だと [0,1] の2点しか nice tick が出ず中間グリッドが実質無くなる。
					// 20%刻み（6点）の同心グリッドにする（あしらい調整）。
					tickCount={6}
					allowDecimals={true}
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
