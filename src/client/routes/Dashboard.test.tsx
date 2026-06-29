import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobDetailResponse } from "../lib/jobDetail";
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

// 詳細応答の最小ダミー。job.status だけがポーリングのフェーズ判定に効く。
function detail(status: string): JobDetailResponse {
	return {
		job: {
			jobId: "job-x",
			sourceUrl: "https://example.com/job-x",
			sourceType: "detail",
			status,
			fetchedAt: 0,
		},
		extraction: {
			status: "ok",
			model: "m",
			mechanism: "json-mode",
			extractedAt: 0,
			structured: {} as never,
		},
		total: 0.8,
		breakdown: [],
	};
}

describe("Dashboard", () => {
	it("取得中はカード形 Skeleton を表示する", () => {
		// 解決しない fetcher で読み込み状態に留める
		render(
			<Dashboard
				rankingFetcher={() => new Promise<RankingResponse>(() => {})}
			/>,
		);

		expect(screen.getByTestId("ranking-loading")).toBeInTheDocument();
		expect(
			screen.getAllByTestId("score-skeleton").length,
		).toBeGreaterThanOrEqual(1);
	});

	it("ベスト3はポディウム、4位以降は通常カードで表示する", async () => {
		// 4 件 → 上位 3 件が podium、残り 1 件が通常カード。
		const jobs = ["a", "b", "c", "d"].map((id) => item({ jobId: id }));
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const podiums = await screen.findAllByTestId("ranking-podium");
		expect(podiums).toHaveLength(3);
		expect(screen.getAllByTestId("ranking-card")).toHaveLength(1);
	});

	it("カードクリックで右ドロワー（詳細）が開く", async () => {
		const jobs = [item({ jobId: "a", sourceUrl: "https://example.com/a" })];
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const card = await screen.findByTestId("ranking-podium");
		// 初期はドロワー未表示
		expect(screen.queryByTestId("job-detail-sheet")).not.toBeInTheDocument();

		fireEvent.click(card);

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

	it("投入中の求人は Skeleton を出し、scored で楽観的にカードへ差し替える", async () => {
		// 1 回目は抽出中（extracted）→ Skeleton、2 回目で scored → カードへ。
		const jobStatusFetcher = vi
			.fn()
			.mockResolvedValueOnce(detail("extracted"))
			.mockResolvedValue(detail("scored"));
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		expect(await screen.findByTestId("pending-skeleton")).toBeInTheDocument();
		expect(await screen.findByTestId("pending-card")).toBeInTheDocument();
	});

	it("投入中の求人が終端に達したら onJobSettled を一度だけ通知する", async () => {
		const jobStatusFetcher = vi.fn().mockResolvedValue(detail("scored"));
		const onJobSettled = vi.fn();
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
				onJobSettled={onJobSettled}
			/>,
		);

		await screen.findByTestId("pending-card");
		expect(onJobSettled).toHaveBeenCalledTimes(1);
		expect(onJobSettled).toHaveBeenCalledWith("job-x");
	});

	it("投入中カードのクリックで詳細ドロワーが開く", async () => {
		const jobStatusFetcher = vi.fn().mockResolvedValue(detail("scored"));
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		const card = await screen.findByTestId("pending-card");
		fireEvent.click(card);

		expect(await screen.findByTestId("job-detail-sheet")).toBeInTheDocument();
	});
});
