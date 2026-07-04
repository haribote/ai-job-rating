import { render, renderHook, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { JobDetailFetcher, JobDetailResponse } from "./jobDetail";
import {
	deriveJobPhase,
	isPendingPhase,
	type JobPhase,
	useJobStatus,
} from "./useJobStatus";

// 詳細応答の最小ダミー。job.status だけがフェーズ判定に効く（内訳は見ない）。
function detail(status: string): JobDetailResponse {
	return {
		job: {
			jobId: "job-1",
			sourceUrl: "https://example.com/job-1",
			sourceType: "detail",
			status,
			fetchedAt: 0,
			companyName: null,
			jobTitle: null,
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

describe("deriveJobPhase", () => {
	it("scored は完了（ready）", () => {
		expect(deriveJobPhase("scored")).toBe("ready");
	});

	it("failed は失敗（failed）", () => {
		expect(deriveJobPhase("failed")).toBe("failed");
	});

	it("fetched は取得中（fetching）", () => {
		expect(deriveJobPhase("fetched")).toBe("fetching");
	});

	it("extracted は採点中（scoring）", () => {
		expect(deriveJobPhase("extracted")).toBe("scoring");
	});

	it("未知の値は安全側で取得中（fetching）扱いにする", () => {
		expect(deriveJobPhase("unknown-status")).toBe("fetching");
	});
});

describe("isPendingPhase", () => {
	it("fetching/scoring は pending、ready/failed は終端", () => {
		expect(isPendingPhase("fetching")).toBe(true);
		expect(isPendingPhase("scoring")).toBe(true);
		expect(isPendingPhase("ready")).toBe(false);
		expect(isPendingPhase("failed")).toBe(false);
	});
});

describe("useJobStatus", () => {
	it("jobId が null の間はポーリングせず取得中を保つ", () => {
		const fetcher = vi.fn();
		const { result } = renderHook(() => useJobStatus(null, { fetcher }));

		expect(result.current.phase).toBe("fetching");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("extracted の間は採点中（scoring）を保ち、ポーリングを継続する（終端でない）", async () => {
		const fetcher = vi.fn().mockResolvedValue(detail("extracted"));
		const { result } = renderHook(() =>
			useJobStatus("job-1", { fetcher, intervalMs: 5 }),
		);

		await waitFor(() => expect(result.current.phase).toBe("scoring"));
		const callsAtScoring = fetcher.mock.calls.length;

		// scoring は終端でないため追加ポーリングが続く。
		await waitFor(() =>
			expect(fetcher.mock.calls.length).toBeGreaterThan(callsAtScoring),
		);
	});

	it("extracted → scored の順でポーリングし、ready で停止する", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(detail("extracted"))
			.mockResolvedValue(detail("scored"));
		const { result } = renderHook(() =>
			useJobStatus("job-1", { fetcher, intervalMs: 5 }),
		);

		await waitFor(() => expect(result.current.phase).toBe("ready"));
		expect(result.current.detail?.total).toBe(0.8);
		const settledCalls = fetcher.mock.calls.length;
		expect(settledCalls).toBeGreaterThanOrEqual(2);

		// ready 後は追加ポーリングしない（終端で停止）。
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(fetcher).toHaveBeenCalledTimes(settledCalls);
	});

	it("取得例外（404 等）は取得中とみなし再試行する", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValue(detail("scored"));
		const { result } = renderHook(() =>
			useJobStatus("job-1", { fetcher, intervalMs: 5 }),
		);

		await waitFor(() => expect(result.current.phase).toBe("ready"));
	});

	it("採点中に一時的な取得例外が起きてもフェーズを後退させない（scoring→fetching にならない）", async () => {
		// フェーズ遷移の全履歴を記録するプローブ。renderHook には履歴取得手段が無いため
		// 実コンポーネントで useEffect 経由で収集する。
		const seenPhases: JobPhase[] = [];
		function Probe({ fetcher }: { fetcher: JobDetailFetcher }): null {
			const { phase } = useJobStatus("job-1", { fetcher, intervalMs: 5 });
			useEffect(() => {
				seenPhases.push(phase);
			}, [phase]);
			return null;
		}

		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(detail("extracted"))
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValue(detail("scored"));
		render(createElement(Probe, { fetcher }));

		await waitFor(() => expect(seenPhases).toContain("ready"));

		// scoring に到達した後は fetching へ後退しない（初回の fetching は許容）。
		const afterFirstScoring = seenPhases.slice(seenPhases.indexOf("scoring"));
		expect(afterFirstScoring).not.toContain("fetching");
	});

	it("job.status が failed なら failed で停止する", async () => {
		const fetcher = vi.fn().mockResolvedValue(detail("failed"));
		const { result } = renderHook(() =>
			useJobStatus("job-1", { fetcher, intervalMs: 5 }),
		);

		await waitFor(() => expect(result.current.phase).toBe("failed"));
		const settledCalls = fetcher.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(fetcher).toHaveBeenCalledTimes(settledCalls);
	});
});
