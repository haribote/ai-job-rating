import { render, screen } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { buildRadarData, SCORE_RADAR_CONFIG, ScoreRadar } from "./ScoreRadar";

// jsdom では ResponsiveContainer の実測サイズが 0 になり中身が描画されない。
// 固定サイズを子へ注入して RadarChart を実描画させ、軸ラベル/unknown 表示を検証可能にする。
vi.mock("recharts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("recharts")>();
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
			isValidElement<{ width?: number; height?: number }>(children)
				? cloneElement(children, { width: 480, height: 480 })
				: children,
	};
});

// 全軸そろった既知スコア（0..1）。
const fullScores: Record<CategoryKey, number | null> = {
	compensation: 0.8,
	integrity: 0.6,
	flexibility: 0.4,
	role: 0.9,
	company: 0.5,
};

describe("buildRadarData（軸データ整形・決定的）", () => {
	it("CATEGORY_KEYS の順序・軸数で 5 軸を返す", () => {
		const data = buildRadarData(fullScores);
		expect(data).toHaveLength(CATEGORY_KEYS.length);
		expect(data.map((d) => d.key)).toEqual([...CATEGORY_KEYS]);
	});

	it("各軸ラベルは categories.ts の表示名に連動する（ハードコードしない）", () => {
		const data = buildRadarData(fullScores);
		for (const datum of data) {
			expect(datum.label).toBe(CATEGORY_LABELS[datum.key]);
		}
	});

	it("既知値はそのまま value に入り unknown=false", () => {
		const data = buildRadarData(fullScores);
		const role = data.find((d) => d.key === "role");
		expect(role?.value).toBe(0.9);
		expect(role?.unknown).toBe(false);
	});

	it("null 軸は 0 ではなく value=null・unknown=true（unknown 中立）", () => {
		const data = buildRadarData({ ...fullScores, flexibility: null });
		const flex = data.find((d) => d.key === "flexibility");
		expect(flex?.value).toBeNull();
		expect(flex?.unknown).toBe(true);
	});
});

describe("SCORE_RADAR_CONFIG（単一アクセント）", () => {
	it("系列は 1 つだけで単一アクセント色（chart-1）を参照する", () => {
		const keys = Object.keys(SCORE_RADAR_CONFIG);
		expect(keys).toHaveLength(1);
		// design-tokens は --chart-1 を RGB チャンネルで持つため rgb() で包まないと無効な paint になる。
		expect(SCORE_RADAR_CONFIG[keys[0]].color).toBe("rgb(var(--chart-1))");
	});
});

describe("ScoreRadar（描画）", () => {
	it("軸ラベルは番号（1〜5）で描画する（狭枠での重なり回避・#203）", () => {
		render(<ScoreRadar scores={fullScores} />);
		for (const key of CATEGORY_KEYS) {
			expect(
				screen.getByText(String(CATEGORY_AXIS_NUMBERS[key])),
			).toBeInTheDocument();
		}
	});

	it("データ無し軸の目盛りを中立表示（data-unknown）でマークする", () => {
		render(<ScoreRadar scores={{ ...fullScores, company: null }} />);
		const companyTick = screen.getByText(String(CATEGORY_AXIS_NUMBERS.company));
		expect(companyTick).toHaveAttribute("data-unknown", "true");
		// 既知軸は中立マークを付けない。
		const roleTick = screen.getByText(String(CATEGORY_AXIS_NUMBERS.role));
		expect(roleTick).toHaveAttribute("data-unknown", "false");
	});

	it("番号目盛りの title に軸名（CATEGORY_LABELS）を残す（a11y フォロー）", () => {
		render(<ScoreRadar scores={fullScores} />);
		const compensationTick = screen.getByText(
			String(CATEGORY_AXIS_NUMBERS.compensation),
		);
		expect(compensationTick.querySelector("title")).toHaveTextContent(
			CATEGORY_LABELS.compensation,
		);
	});
});
