import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RankingItem, RankingResponse } from "../lib/useRanking";
import { Dashboard } from "./Dashboard";

// ランキング 1 件分の最小ダミー。company/title は契約上まだ null（#95 申し送り）。
function item(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-1",
		sourceUrl: "https://example.com/job-1",
		company: null,
		title: null,
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		...over,
	};
}

describe("Dashboard", () => {
	it("取得中はローディングを表示する", () => {
		// 解決しない fetcher で読み込み状態に留める
		render(
			<Dashboard
				rankingFetcher={() => new Promise<RankingResponse>(() => {})}
			/>,
		);

		expect(screen.getByTestId("ranking-loading")).toBeInTheDocument();
	});

	it("取得したランキングを行として表示する", async () => {
		const jobs = [item({ jobId: "a" }), item({ jobId: "b" })];
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const rows = await screen.findAllByTestId("ranking-row");
		expect(rows).toHaveLength(2);
	});

	it("行クリックで右ドロワー（詳細）が開く", async () => {
		const jobs = [item({ jobId: "a", sourceUrl: "https://example.com/a" })];
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const row = await screen.findByTestId("ranking-row");
		// 初期はドロワー未表示
		expect(screen.queryByTestId("job-detail-sheet")).not.toBeInTheDocument();

		fireEvent.click(row);

		expect(await screen.findByTestId("job-detail-sheet")).toBeInTheDocument();
	});

	it("取得失敗時はエラーを表示する", async () => {
		render(
			<Dashboard
				rankingFetcher={async () => {
					throw new Error("boom");
				}}
			/>,
		);

		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});
});
