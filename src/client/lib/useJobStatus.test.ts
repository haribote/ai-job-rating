import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobDetailResponse } from "./jobDetail";
import { deriveJobPhase, useJobStatus } from "./useJobStatus";

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

	it("fetched/extracted は抽出中（extracting）", () => {
		expect(deriveJobPhase("fetched")).toBe("extracting");
		expect(deriveJobPhase("extracted")).toBe("extracting");
	});
});

describe("useJobStatus", () => {
	it("jobId が null の間はポーリングせず抽出中を保つ", () => {
		const fetcher = vi.fn();
		const { result } = renderHook(() => useJobStatus(null, { fetcher }));

		expect(result.current.phase).toBe("extracting");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("scored になるまでポーリングし、ready で停止する", async () => {
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

	it("取得例外（404 等）は抽出中とみなし再試行する", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValue(detail("scored"));
		const { result } = renderHook(() =>
			useJobStatus("job-1", { fetcher, intervalMs: 5 }),
		);

		await waitFor(() => expect(result.current.phase).toBe("ready"));
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
