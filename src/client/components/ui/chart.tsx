import type {
	ComponentProps,
	CSSProperties,
	HTMLAttributes,
	ReactNode,
} from "react";
import { createContext, forwardRef, useContext, useId } from "react";
import {
	Legend as RechartsLegend,
	Tooltip as RechartsTooltip,
	ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";

// shadcn Chart プリミティブ（Wave 3 #110 ScoreRadar 等が利用）。
// config から系列ごとの色を CSS 変数（--color-<key>）として注入し、Recharts を薄くラップする。
// 色は単一アクセント方針（design-tokens の chart-* / 任意の token 値）に従って呼び出し側が指定する。

export interface ChartConfig {
	[key: string]: {
		label?: ReactNode;
		icon?: React.ComponentType;
		color?: string;
	};
}

interface ChartContextValue {
	config: ChartConfig;
}

const ChartContext = createContext<ChartContextValue | null>(null);

export function useChart(): ChartContextValue {
	const context = useContext(ChartContext);
	if (!context) {
		throw new Error("useChart は <ChartContainer> の内側で使う必要があります");
	}
	return context;
}

interface ChartContainerProps extends HTMLAttributes<HTMLDivElement> {
	config: ChartConfig;
	children: ComponentProps<typeof ResponsiveContainer>["children"];
}

const ChartContainer = forwardRef<HTMLDivElement, ChartContainerProps>(
	({ id, className, children, config, ...props }, ref) => {
		const uniqueId = useId();
		const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

		return (
			<ChartContext.Provider value={{ config }}>
				<div
					data-chart={chartId}
					ref={ref}
					className={cn(
						"flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-surface]:outline-none",
						className,
					)}
					{...props}
				>
					<ChartStyle id={chartId} config={config} />
					<ResponsiveContainer>{children}</ResponsiveContainer>
				</div>
			</ChartContext.Provider>
		);
	},
);
ChartContainer.displayName = "ChartContainer";

// config の色を `[data-chart=<id>] { --color-<key>: <value> }` として注入する。
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
	const colorConfig = Object.entries(config).filter(
		([, item]) => item.color !== undefined,
	);
	if (colorConfig.length === 0) {
		return null;
	}

	const rules = colorConfig
		.map(([key, item]) => `  --color-${key}: ${item.color};`)
		.join("\n");

	return (
		<style
			// biome-ignore lint/security/noDangerouslySetInnerHtml: 値は config 由来の静的な色文字列のみで信頼できる
			dangerouslySetInnerHTML={{
				__html: `[data-chart=${id}] {\n${rules}\n}`,
			}}
		/>
	);
}

const ChartTooltip = RechartsTooltip;
const ChartLegend = RechartsLegend;

// Recharts が active 時に注入する payload の最小形。recharts の型変動に依存しないよう自前で定義する。
interface ChartPayloadItem {
	value?: number | string;
	name?: string;
	dataKey?: string | number;
	color?: string;
	payload?: Record<string, unknown>;
}

interface ChartTooltipContentProps extends HTMLAttributes<HTMLDivElement> {
	active?: boolean;
	payload?: ChartPayloadItem[];
	label?: string | number;
	hideLabel?: boolean;
	hideIndicator?: boolean;
	nameKey?: string;
}

const ChartTooltipContent = forwardRef<
	HTMLDivElement,
	ChartTooltipContentProps
>(
	(
		{
			active,
			payload,
			label,
			hideLabel = false,
			hideIndicator = false,
			nameKey,
			className,
			...props
		},
		ref,
	) => {
		const { config } = useChart();

		if (!active || !payload || payload.length === 0) {
			return null;
		}

		return (
			<div
				ref={ref}
				className={cn(
					"grid min-w-[8rem] gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-md",
					className,
				)}
				{...props}
			>
				{!hideLabel && label !== undefined ? (
					<div className="font-medium">{label}</div>
				) : null}
				<div className="grid gap-1.5">
					{payload.map((item) => {
						const key = nameKey ?? item.name ?? String(item.dataKey ?? "");
						const itemConfig = config[key];
						const indicatorColor = item.color ?? `var(--color-${key})`;
						return (
							<div key={key} className="flex w-full items-center gap-2">
								{!hideIndicator ? (
									<span
										className="size-2.5 shrink-0 rounded-[2px]"
										style={
											{
												backgroundColor: indicatorColor,
											} as CSSProperties
										}
									/>
								) : null}
								<span className="text-muted-foreground">
									{itemConfig?.label ?? item.name ?? key}
								</span>
								{item.value !== undefined ? (
									<span className="ml-auto font-mono font-medium tabular-nums text-foreground">
										{item.value}
									</span>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
		);
	},
);
ChartTooltipContent.displayName = "ChartTooltipContent";

interface ChartLegendItem {
	value?: string;
	dataKey?: string | number;
	color?: string;
}

interface ChartLegendContentProps extends HTMLAttributes<HTMLDivElement> {
	payload?: ChartLegendItem[];
	hideIcon?: boolean;
	nameKey?: string;
}

const ChartLegendContent = forwardRef<HTMLDivElement, ChartLegendContentProps>(
	({ payload, hideIcon = false, nameKey, className, ...props }, ref) => {
		const { config } = useChart();

		if (!payload || payload.length === 0) {
			return null;
		}

		return (
			<div
				ref={ref}
				className={cn("flex items-center justify-center gap-4", className)}
				{...props}
			>
				{payload.map((item) => {
					const key = nameKey ?? String(item.dataKey ?? item.value ?? "");
					const itemConfig = config[key];
					return (
						<div key={key} className="flex items-center gap-1.5">
							{!hideIcon ? (
								<span
									className="size-2 shrink-0 rounded-[2px]"
									style={
										{
											backgroundColor: item.color ?? `var(--color-${key})`,
										} as CSSProperties
									}
								/>
							) : null}
							{itemConfig?.label ?? item.value ?? key}
						</div>
					);
				})}
			</div>
		);
	},
);
ChartLegendContent.displayName = "ChartLegendContent";

export {
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartStyle,
	ChartTooltip,
	ChartTooltipContent,
};
