import { fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
	NormalizedFieldValue,
	NormalizedJob,
} from "../../shared/job-schema";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { BreakdownRow, JobDetailResponse } from "../lib/jobDetail";
import type { RankingItem } from "../lib/useRanking";
import { JobDetailSheet } from "./JobDetailSheet";

// jsdom では ResponsiveContainer の実測サイズが 0 で中身が描画されない。固定サイズを注入する。
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

function item(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-1",
		sourceUrl: "https://example.com/job-1",
		company: "テスト株式会社",
		title: "フロントエンドエンジニア",
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		...over,
	};
}

// 全正規キーを埋めた構造化求人（取れない項目は unknown）。
function structured(): NormalizedJob {
	const unknown: NormalizedFieldValue = { kind: "unknown" };
	const job = {} as Record<string, NormalizedFieldValue>;
	for (const key of NORMALIZED_KEYS) {
		job[key] = unknown;
	}
	job.benefitsCoverage = {
		kind: "coverage",
		present: 2,
		total: 4,
		signals: ["退職金制度", "住宅手当"],
	};
	return job as NormalizedJob;
}

function breakdownRow(
	over: Partial<BreakdownRow> & Pick<BreakdownRow, "key">,
): BreakdownRow {
	return {
		kind: "numericRange",
		weight: 1,
		score: 0.6,
		included: true,
		raw: "700万〜",
		hardFilter: "none",
		desired: null,
		...over,
	};
}

function detail(over: Partial<JobDetailResponse> = {}): JobDetailResponse {
	return {
		job: {
			jobId: "job-1",
			sourceUrl: "https://example.com/job-1",
			sourceType: "detail",
			status: "extracted",
			fetchedAt: 0,
		},
		extraction: {
			status: "ok",
			model: "gpt-oss-20b",
			mechanism: "json_mode",
			extractedAt: 0,
			structured: structured(),
		},
		total: 0.8,
		breakdown: NORMALIZED_KEYS.map((key) => breakdownRow({ key })),
		...over,
	};
}

describe("JobDetailSheet（詳細ドロワーの中身）", () => {
	it("開くと詳細を取得しフラット内訳表とレーダーを表示する", async () => {
		render(
			<JobDetailSheet
				job={item()}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => detail()}
			/>,
		);
		expect(await screen.findByTestId("breakdown-table")).toBeInTheDocument();
	});

	it("アクションは「再抽出」「評判取得」の 2 つ", async () => {
		render(
			<JobDetailSheet
				job={item()}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => detail()}
			/>,
		);
		expect(screen.getByTestId("reextract-button")).toHaveTextContent("再抽出");
		expect(screen.getByTestId("reputation-button")).toHaveTextContent(
			"評判取得",
		);
	});

	it("評判取得は前提未設定だと無効＋設定への案内文を出す", () => {
		render(
			<JobDetailSheet
				job={item()}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => detail()}
			/>,
		);
		expect(screen.getByTestId("reputation-button")).toBeDisabled();
		expect(screen.getByTestId("reputation-hint")).toHaveTextContent(
			"ANTHROPIC_API_KEY",
		);
	});

	it("前提が満たされれば評判取得ボタンは有効・案内文は出さない", () => {
		render(
			<JobDetailSheet
				job={item()}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => detail()}
				reputationAvailable={true}
			/>,
		);
		expect(screen.getByTestId("reputation-button")).toBeEnabled();
		expect(screen.queryByTestId("reputation-hint")).not.toBeInTheDocument();
	});

	it("再抽出ボタンで POST /reextract を当該 jobId で呼ぶ", async () => {
		const reextract = vi.fn(async () => ({ status: "ok" as const }));
		render(
			<JobDetailSheet
				job={item({ jobId: "abc" })}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => detail()}
				reextract={reextract}
			/>,
		);
		fireEvent.click(screen.getByTestId("reextract-button"));
		expect(reextract).toHaveBeenCalledWith("abc");
		expect(await screen.findByTestId("reextract-done")).toBeInTheDocument();
	});

	it("取得失敗時はエラーを表示する", async () => {
		render(
			<JobDetailSheet
				job={item()}
				open={true}
				onOpenChange={() => {}}
				detailFetcher={async () => {
					throw new Error("boom");
				}}
			/>,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"詳細の取得に失敗しました",
		);
	});
});
