import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SubmitJobResponse } from "../shared/submit-job";
import {
	App,
	addPendingId,
	pendingIdFromResponse,
	removePendingId,
} from "./App";
import type { JobDetailResponse } from "./lib/jobDetail";
import type { RankingItem, RankingResponse } from "./lib/useRanking";

// client（jsdom）プロジェクトの足場が機能することを示す最小スモーク。
// ビルド成果物に依存せず、App を直接レンダリングして既定ルートと骨格のみを検証する。
describe("App", () => {
	it("既定ルートでダッシュボードビューを描画する", () => {
		render(<App />);

		expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument();
	});

	it("トップバーのアプリ名と設定アクションを描画する", () => {
		render(<App />);

		expect(
			screen.getByRole("heading", { level: 1, name: "ai-job-rating" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
	});

	it("投入ボタンで求人投入モーダルを開く", () => {
		render(<App />);

		// 既定ではモーダル（ダイアログ）は閉じている。
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "求人を投入" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByTestId("add-job-url-input")).toBeInTheDocument();
	});
});

// 投入応答 → pending 配線の決定的ロジック（純関数）。
describe("pendingIdFromResponse（投入応答から pending 対象を決める）", () => {
	it("201 詳細/貼付応答は jobId を返す", () => {
		const res: SubmitJobResponse = { jobId: "job-1", status: "ok" };
		expect(pendingIdFromResponse(res)).toBe("job-1");
	});

	it("202 一覧キュー応答は個別 ID を持たないので null", () => {
		const res: SubmitJobResponse = { status: "queued", count: 3 };
		expect(pendingIdFromResponse(res)).toBeNull();
	});
});

describe("addPendingId / removePendingId（pending の積み・除去）", () => {
	it("addPendingId は末尾に積み、重複は積まない", () => {
		expect(addPendingId(["a"], "b")).toEqual(["a", "b"]);
		expect(addPendingId(["a", "b"], "a")).toEqual(["a", "b"]);
	});

	it("removePendingId は該当 ID だけ外す", () => {
		expect(removePendingId(["a", "b"], "a")).toEqual(["b"]);
		expect(removePendingId(["a"], "x")).toEqual(["a"]);
	});
});

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

function rankItem(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-x",
		sourceUrl: "https://example.com/job-x",
		company: null,
		title: null,
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		...over,
	};
}

// URL を入力して投入する操作をまとめる（モーダルを開く→入力→送信）。
function submitUrl(value: string): void {
	fireEvent.click(screen.getByRole("button", { name: "求人を投入" }));
	fireEvent.change(screen.getByTestId("add-job-url-input"), {
		target: { value },
	});
	fireEvent.click(screen.getByTestId("add-job-submit"));
}

describe("App 投入フロー → pending seam 配線（#169）", () => {
	it("201 投入後はその求人を pending-skeleton として楽観表示する", async () => {
		// 抽出中のまま据え置き（scored にしない）→ pending-skeleton が残る。
		const jobStatusFetcher = vi.fn(async () => detail("extracted"));
		render(
			<App
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				submitJob={async () => ({ jobId: "job-x", status: "ok" })}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		submitUrl("https://example.com/job-x");

		expect(await screen.findByTestId("pending-list")).toBeInTheDocument();
		expect(await screen.findByTestId("pending-skeleton")).toBeInTheDocument();
		// seam が実際にポーリングへ配線されている（その jobId で取得関数が呼ばれる）ことを示す。
		await waitFor(() => expect(jobStatusFetcher).toHaveBeenCalledWith("job-x"));
	});

	it("投入した求人が scored になると pending から外れ ranking に統合される（二重表示しない）", async () => {
		const jobStatusFetcher = vi.fn(async () => detail("scored"));
		// 初回 ranking は空、settle 後の再取得で当該求人を含む。
		let rankingCalls = 0;
		const rankingFetcher = vi.fn(async (): Promise<RankingResponse> => {
			rankingCalls += 1;
			return rankingCalls === 1
				? { jobs: [], excluded: [] }
				: { jobs: [rankItem()], excluded: [] };
		});
		render(
			<App
				rankingFetcher={rankingFetcher}
				submitJob={async () => ({ jobId: "job-x", status: "ok" })}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		submitUrl("https://example.com/job-x");

		// settle 後の再取得で確定ランキングのカード（≤3 件は podium）が現れる。
		expect(await screen.findByTestId("ranking-podium")).toBeInTheDocument();
		// pending からは外れ、楽観カードとの二重表示は残らない。
		await waitFor(() =>
			expect(screen.queryByTestId("pending-list")).not.toBeInTheDocument(),
		);
		expect(screen.queryByTestId("pending-card")).not.toBeInTheDocument();
		expect(rankingFetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("一覧URL投入（202 queued）は pending に積まず ranking を再取得する", async () => {
		const jobStatusFetcher = vi.fn(async () => detail("scored"));
		const rankingFetcher = vi.fn(
			async (): Promise<RankingResponse> => ({ jobs: [], excluded: [] }),
		);
		render(
			<App
				rankingFetcher={rankingFetcher}
				submitJob={async () => ({ status: "queued", count: 2 })}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		submitUrl("https://example.com/list");

		// 再取得（reloadKey 増加で再マウント）まで待つ。
		await waitFor(() =>
			expect(rankingFetcher.mock.calls.length).toBeGreaterThanOrEqual(2),
		);
		// 個別 jobId を持たないので pending には積まない。
		expect(screen.queryByTestId("pending-list")).not.toBeInTheDocument();
		expect(screen.queryByTestId("pending-skeleton")).not.toBeInTheDocument();
		expect(jobStatusFetcher).not.toHaveBeenCalled();
	});
});
