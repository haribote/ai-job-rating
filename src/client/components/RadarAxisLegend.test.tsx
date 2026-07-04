import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
} from "../../shared/categories";
import { RadarAxisLegend } from "./RadarAxisLegend";

// レーダー軸番号 → カテゴリ名の凡例（#203）。ダッシュボード単位で 1 箇所のみ表示する想定。

describe("RadarAxisLegend", () => {
	it("data-testid=radar-axis-legend で描画する", () => {
		render(<RadarAxisLegend />);
		expect(screen.getByTestId("radar-axis-legend")).toBeInTheDocument();
	});

	it("CATEGORY_KEYS 順で番号→カテゴリ名を過不足なく対応させる（ハードコードしない）", () => {
		render(<RadarAxisLegend />);
		const legend = screen.getByTestId("radar-axis-legend");
		const numbers = within(legend).getAllByRole("term");
		const names = within(legend).getAllByRole("definition");

		expect(numbers).toHaveLength(CATEGORY_KEYS.length);
		expect(names).toHaveLength(CATEGORY_KEYS.length);

		CATEGORY_KEYS.forEach((key, index) => {
			expect(numbers[index]).toHaveTextContent(
				String(CATEGORY_AXIS_NUMBERS[key]),
			);
			expect(names[index]).toHaveTextContent(CATEGORY_LABELS[key]);
		});
	});
});
