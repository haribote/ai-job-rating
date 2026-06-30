import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CoverageValue } from "../../shared/job-schema";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { BreakdownRow, JobReputation } from "../lib/jobDetail";
import { BreakdownTable } from "./BreakdownTable";

// 内訳 1 行の最小ダミー。
function row(
	over: Partial<BreakdownRow> & Pick<BreakdownRow, "key">,
): BreakdownRow {
	return {
		kind: "numericRange",
		weight: 1,
		score: 0.5,
		included: true,
		raw: "700万〜",
		hardFilter: "none",
		desired: null,
		...over,
	};
}

// 全正規キーぶんの行（フラット表は全キーを 1 表に並べる）。
function allRows(): BreakdownRow[] {
	return NORMALIZED_KEYS.map((key) => row({ key }));
}

describe("BreakdownTable（フラット内訳表）", () => {
	it("カテゴリ別アコーディオンにせず 1 枚のフラット表に全正規キーを並べる", () => {
		render(<BreakdownTable rows={allRows()} />);
		// 表は 1 つだけ（カテゴリごとに分割しない）。
		expect(screen.getAllByRole("table")).toHaveLength(1);
		// ヘッダ行を除く本体行は正規キー数ぶん。
		for (const key of NORMALIZED_KEYS) {
			expect(screen.getByTestId(`breakdown-row-${key}`)).toBeInTheDocument();
		}
	});

	it("項目・抽出値・希望値・サブスコア・重みの 5 列を表示する", () => {
		render(<BreakdownTable rows={allRows()} />);
		expect(screen.getByText("項目")).toBeInTheDocument();
		expect(screen.getByText("抽出値")).toBeInTheDocument();
		expect(screen.getByText("希望値")).toBeInTheDocument();
		expect(screen.getByText("サブスコア")).toBeInTheDocument();
		expect(screen.getByText("重み")).toBeInTheDocument();
	});

	it("unknown 中立（included=false / score=null）は中立明示し分母除外を data 属性で示す", () => {
		render(
			<BreakdownTable
				rows={[row({ key: "overtime", score: null, included: false })]}
			/>,
		);
		const tr = screen.getByTestId("breakdown-row-overtime");
		expect(tr).toHaveAttribute("data-included", "false");
		expect(within(tr).getByTestId("neutral-badge")).toHaveTextContent("中立");
		// サブスコアは「—」（0 点に潰さない）。中立バッジと同じセルに「—」が並ぶ。
		const scoreCell = within(tr).getByTestId("neutral-badge")
			.parentElement as HTMLElement;
		expect(within(scoreCell).getByText("—")).toBeInTheDocument();
	});

	it("ハードフィルタ required/exclude はバッジ表示する", () => {
		render(
			<BreakdownTable
				rows={[
					row({ key: "annualSalary", hardFilter: "required" }),
					row({ key: "remoteWork", hardFilter: "exclude" }),
				]}
			/>,
		);
		expect(
			within(screen.getByTestId("breakdown-row-annualSalary")).getByText(
				"必須",
			),
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId("breakdown-row-remoteWork")).getByText("除外"),
		).toBeInTheDocument();
	});

	it("benefitsCoverage は「充足度 NN%」1 行＋展開で signal 内訳を出す", () => {
		const coverage: CoverageValue = {
			kind: "coverage",
			present: 3,
			total: 4,
			signals: ["退職金制度", "住宅手当", "資格支援"],
		};
		render(
			<BreakdownTable
				rows={[row({ key: "benefitsCoverage", kind: "coverage" })]}
				coverage={coverage}
			/>,
		);
		// 充足度 75%（present/total）。
		expect(screen.getByText("充足度 75%")).toBeInTheDocument();
		// 初期は内訳を畳む。
		expect(screen.queryByTestId("coverage-signals")).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId("coverage-toggle"));
		const signals = screen.getByTestId("coverage-signals");
		expect(within(signals).getByText("退職金制度")).toBeInTheDocument();
		expect(within(signals).getByText("資格支援")).toBeInTheDocument();
	});

	it("企業評判は出所・スコアを明示する 1 行として company 軸合流を示す（#117）", () => {
		const reputation: JobReputation = {
			score: 0.7,
			weight: 3,
			confidence: "ok",
			sources: [{ source: "openwork", overallScore: 3.5, reviewCount: 500 }],
		};
		render(<BreakdownTable rows={allRows()} reputation={reputation} />);
		const tr = screen.getByTestId("breakdown-row-reputation");
		expect(within(tr).getByText("企業評判")).toBeInTheDocument();
		expect(within(tr).getByText("0.70")).toBeInTheDocument();
		expect(within(tr).getByText("openwork（3.5・500件）")).toBeInTheDocument();
		expect(within(tr).queryByTestId("reputation-neutral-badge")).toBeNull();
	});

	it("評判が中立（score=null・APIキー未設定/データなし）は中立表示・出所なし", () => {
		const reputation: JobReputation = {
			score: null,
			weight: 3,
			confidence: "none",
			sources: [],
		};
		render(<BreakdownTable rows={allRows()} reputation={reputation} />);
		const tr = screen.getByTestId("breakdown-row-reputation");
		expect(
			within(tr).getByTestId("reputation-neutral-badge"),
		).toHaveTextContent("中立");
	});

	it("低信頼（confidence=low）は低信頼バッジを出す", () => {
		const reputation: JobReputation = {
			score: 0.55,
			weight: 3,
			confidence: "low",
			sources: [{ source: "openwork", overallScore: 4.8, reviewCount: 3 }],
		};
		render(<BreakdownTable rows={allRows()} reputation={reputation} />);
		const tr = screen.getByTestId("breakdown-row-reputation");
		expect(
			within(tr).getByTestId("reputation-low-confidence"),
		).toHaveTextContent("低信頼");
	});

	it("評判 prop 未指定は評判行を出さない（後方互換）", () => {
		render(<BreakdownTable rows={allRows()} />);
		expect(screen.queryByTestId("breakdown-row-reputation")).toBeNull();
	});
});
