import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { CategoryScoreTable } from "./CategoryScoreTable";

// 全軸 unknown（null）の既定値。
const NEUTRAL_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

describe("CategoryScoreTable", () => {
	it("data-testid=category-score-table で描画する", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		expect(screen.getByTestId("category-score-table")).toBeInTheDocument();
	});

	it("CATEGORY_KEYS 順で番号・カテゴリ名を過不足なく対応させる（ハードコードしない）", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		const table = screen.getByTestId("category-score-table");
		const rows = within(table).getAllByRole("row");
		expect(rows).toHaveLength(CATEGORY_KEYS.length);

		CATEGORY_KEYS.forEach((key, index) => {
			const row = rows[index];
			expect(row).toHaveTextContent(String(CATEGORY_AXIS_NUMBERS[key]));
			expect(row).toHaveTextContent(CATEGORY_LABELS[key]);
		});
	});

	it("既知の軸は categoryScores（0..1）を ×100・小数2桁で表示する（総合スコアと同じスケール・精度）", () => {
		render(
			<CategoryScoreTable scores={{ ...NEUTRAL_SCORES, compensation: 0.9 }} />,
		);
		const table = screen.getByTestId("category-score-table");
		expect(within(table).getByText("90.00")).toBeInTheDocument();
	});

	it("unknown（null）軸は行を消さず「—」で表示する（中立表示・§5.2）", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		const table = screen.getByTestId("category-score-table");
		const rows = within(table).getAllByRole("row");
		expect(rows).toHaveLength(CATEGORY_KEYS.length);
		for (const row of rows) {
			expect(row).toHaveTextContent("—");
		}
	});
});
