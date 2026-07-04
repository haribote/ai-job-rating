import { fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_KEYS, type CategoryKey } from "../../shared/categories";
import type { JobDetailResponse } from "../lib/jobDetail";
import type { RankingItem, RankingResponse } from "../lib/useRanking";
import { Dashboard } from "./Dashboard";

// jsdom では ResponsiveContainer の実測サイズが 0 で中身が描画されない（ScoreRadar.test.tsx と同じ事情）。
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

// 全軸 unknown（null・中立）の既定軸別スコア。
const NEUTRAL_CATEGORY_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

// ランキング 1 件分の最小ダミー。company/title は既定 null（テスト対象外の場合はテストごとに上書き）。
function item(over: Partial<RankingItem> = {}): RankingItem {
	return {
		jobId: "job-1",
		sourceUrl: "https://example.com/job-1",
		company: null,
		title: null,
		total: 0.8,
		status: "ok",
		rejectedBy: null,
		categoryScores: NEUTRAL_CATEGORY_SCORES,
		...over,
	};
}

// 詳細応答の最小ダミー。job.status だけがポーリングのフェーズ判定に効く。
// names は #200 の楽観的差し替え（PendingJob）で companyName/jobTitle が伝播するかの検証に使う。
// reputation は #202 の軸別スコア集約（reputation を混ぜない）検証に使う。
function detail(
	status: string,
	over: {
		reputation?: JobDetailResponse["reputation"];
		companyName?: string | null;
		jobTitle?: string | null;
		total?: number | null;
	} = {},
): JobDetailResponse {
	return {
		job: {
			jobId: "job-x",
			sourceUrl: "https://example.com/job-x",
			sourceType: "detail",
			status,
			fetchedAt: 0,
			companyName: over.companyName ?? null,
			jobTitle: over.jobTitle ?? null,
		},
		extraction: {
			status: "ok",
			model: "m",
			mechanism: "json-mode",
			extractedAt: 0,
			structured: {} as never,
		},
		// null は「意図的な未算出」なので ?? では畳まない（undefined のときだけ既定 0.8）。
		total: over.total === undefined ? 0.8 : over.total,
		breakdown: [],
		reputation: over.reputation,
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

	it("1位はヒーロー領域、2・3位は右側縦並び、4位以下は3列グリッドのDOM構造になる（#201）", async () => {
		const jobs = ["a", "b", "c", "d", "e"].map((id) => item({ jobId: id }));
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const heroRegion = await screen.findByTestId("ranking-hero-region");
		expect(within(heroRegion).getAllByTestId("ranking-podium")).toHaveLength(3);
		// 2・3位の行を明示的に等分（1位の高さの約50%ずつ）にする決定的な行分割。
		expect(heroRegion.className).toContain("md:grid-rows-2");

		const gridRegion = screen.getByTestId("ranking-grid-region");
		expect(within(gridRegion).getAllByTestId("ranking-card")).toHaveLength(2);
	});

	it("確定ランキング4位以下が無いときは grid 領域を描画しない（#201）", async () => {
		const jobs = ["a", "b"].map((id) => item({ jobId: id }));
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		await screen.findByTestId("ranking-hero-region");
		expect(screen.queryByTestId("ranking-grid-region")).not.toBeInTheDocument();
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

	// #199: fetched（取得中）/extracted（採点中）を判別可能なバッジで明示する。
	it("投入直後（fetched）は「取得中」バッジを role=status で表示する", async () => {
		const jobStatusFetcher = vi.fn().mockResolvedValue(detail("fetched"));
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		expect(await screen.findByTestId("pending-skeleton")).toBeInTheDocument();
		const badge = screen.getByTestId("job-phase-badge");
		expect(badge).toHaveTextContent("取得中");
		expect(badge).toHaveAttribute("role", "status");
	});

	it("抽出済み・採点前（extracted）は「採点中」バッジを role=status で表示する", async () => {
		const jobStatusFetcher = vi.fn().mockResolvedValue(detail("extracted"));
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		expect(await screen.findByTestId("pending-skeleton")).toBeInTheDocument();
		await screen.findByText("採点中");
		const badge = screen.getByTestId("job-phase-badge");
		expect(badge).toHaveTextContent("採点中");
		expect(badge).toHaveAttribute("role", "status");
	});

	// #199: ready かつ total===null（設定不足等でスコア未算出）を「—」だけでなく明示する。
	it("投入中の求人が scored かつ total===null なら「スコア未算出」を明示する", async () => {
		const jobStatusFetcher = vi
			.fn()
			.mockResolvedValue(detail("scored", { total: null }));
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		const card = await screen.findByTestId("pending-card");
		expect(within(card).getByTestId("card-score")).toHaveTextContent("—");
		expect(
			within(card).getByTestId("score-unavailable-note"),
		).toHaveTextContent("スコア未算出");
	});

	// #199: 確定ランキング本体（PendingJob 経由でない通常カード）でも同様に明示する。
	it("確定ランキングの通常カードが total===null のとき「スコア未算出」を明示する", async () => {
		const jobs = ["a", "b", "c", "d"].map((id) =>
			item({ jobId: id, total: id === "d" ? null : 0.8 }),
		);
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		const gridRegion = await screen.findByTestId("ranking-grid-region");
		const card = within(gridRegion).getByTestId("ranking-card");
		expect(
			within(card).getByTestId("score-unavailable-note"),
		).toHaveTextContent("スコア未算出");
	});

	// #200: 投入直後の楽観的カードも、確定ランキング再取得を待たず company/title を表示する。
	it("投入中の求人が scored になったら companyName/jobTitle をカードへ反映する", async () => {
		const jobStatusFetcher = vi.fn().mockResolvedValue(
			detail("scored", {
				companyName: "株式会社サンプル",
				jobTitle: "バックエンドエンジニア",
			}),
		);
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		const card = await screen.findByTestId("pending-card");
		expect(card).toHaveTextContent("バックエンドエンジニア");
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

	it("投入中カードの軸別スコアは breakdown のみで集約する（reputation を混ぜない・#202）", async () => {
		// reputation はサーバ側 toRankingItem（ranking-list.ts）が渡さないものと同じ形にする。
		// ここで混ぜると、再取得後の確定カードで company 軸の値が変化なしに見た目だけ変わる。
		const jobStatusFetcher = vi.fn().mockResolvedValue(
			detail("scored", {
				reputation: { score: 0.9, weight: 3, confidence: "ok", sources: [] },
			}),
		);
		render(
			<Dashboard
				rankingFetcher={async () => ({ jobs: [], excluded: [] })}
				pendingJobIds={["job-x"]}
				jobStatusFetcher={jobStatusFetcher}
				jobStatusIntervalMs={5}
			/>,
		);

		const card = await screen.findByTestId("pending-card");
		// breakdown が空なので全軸 unknown（中立）のまま。reputation があっても company 軸は動かない。
		const unknownAxes = card.querySelectorAll('text[data-unknown="true"]');
		expect(unknownAxes.length).toBe(CATEGORY_KEYS.length);
	});
});
