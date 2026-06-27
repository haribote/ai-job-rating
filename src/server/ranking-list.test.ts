import { describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../shared/job-schema";
import {
	type RankedJobView,
	renderRankingPage,
	rescoredToView,
} from "./ranking-list";
import type { RescoredJob } from "./scoring/rescore-core";

// 全キー unknown の最小求人。必要キーだけ実値で上書きして使う。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

// 表示用ビューの最小生成ヘルパ。
function view(over: Partial<RankedJobView>): RankedJobView {
	return {
		jobId: "j1",
		sourceUrl: "https://example.com/j1",
		total: 0.8,
		breakdown: [],
		rejectedBy: null,
		...over,
	};
}

describe("rescoredToView（RescoredJob + raw 値 → 表示ビュー）", () => {
	it("内訳の score/included/weight と raw 値を写し取る", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 700, max: 700, raw: "700万" },
		});
		const rescored: RescoredJob = {
			jobId: "j1",
			score: {
				total: 0.5,
				breakdown: [
					{
						key: "annualSalary",
						kind: "numericRange",
						weight: 5,
						score: 0.5,
						included: true,
					},
				],
			},
			hardFilter: { passed: true, rejectedBy: null },
		};
		const v = rescoredToView(rescored, "https://example.com/j1", job);
		expect(v.total).toBe(0.5);
		expect(v.breakdown[0]).toMatchObject({
			key: "annualSalary",
			weight: 5,
			score: 0.5,
			included: true,
			raw: "700万",
		});
		expect(v.rejectedBy).toBeNull();
	});

	it("除外された求人は rejectedBy を保持する", () => {
		const rescored: RescoredJob = {
			jobId: "j2",
			score: { total: 0.9, breakdown: [] },
			hardFilter: {
				passed: false,
				rejectedBy: { criterion: "remoteWork", filter: "required" },
			},
		};
		const v = rescoredToView(rescored, "https://example.com/j2", jobWith({}));
		expect(v.rejectedBy).toEqual({
			criterion: "remoteWork",
			filter: "required",
		});
	});
});

describe("renderRankingPage（スコア順一覧 + 項目別内訳の SSR）", () => {
	it("スタイルを読み込み総合スコアを % 表示する", () => {
		const html = renderRankingPage([view({ total: 0.8 })], []);
		expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
		expect(html).toContain("80%");
	});

	it("渡された並び順のまま順位を振る（並べ替えは呼び出し側の責務）", () => {
		const html = renderRankingPage(
			[view({ jobId: "high", total: 0.9 }), view({ jobId: "low", total: 0.1 })],
			[],
		);
		// 1 位の求人が 2 位より前に出る（出現位置で検証）。
		expect(html.indexOf("high")).toBeLessThan(html.indexOf("low"));
		expect(html).toContain("1 位");
		expect(html).toContain("2 位");
	});

	it("total=null は末尾求人として評価できる項目なしと表示する", () => {
		const html = renderRankingPage([view({ jobId: "j1", total: null })], []);
		expect(html).toContain("評価できる項目なし");
	});

	it("項目別内訳に日本語ラベル・kind・weight・サブスコア・raw を出す", () => {
		const html = renderRankingPage(
			[
				view({
					breakdown: [
						{
							key: "annualSalary",
							kind: "numericRange",
							weight: 5,
							score: 0.5,
							included: true,
							raw: "700万",
						},
					],
				}),
			],
			[],
		);
		expect(html).toContain("年収");
		expect(html).toContain("数値レンジ");
		expect(html).toContain("50%");
		expect(html).toContain("700万");
	});

	it("included=false の項目は情報なし（unknown 中立で分母除外）と表示する", () => {
		const html = renderRankingPage(
			[
				view({
					breakdown: [
						{
							key: "annualSalary",
							kind: "numericRange",
							weight: 5,
							score: null,
							included: false,
							raw: "",
						},
					],
				}),
			],
			[],
		);
		expect(html).toContain("情報なし");
		// 分母から外れたことが分かる文言を出す。
		expect(html).toContain("分母除外");
	});

	it("除外求人は別枠で除外理由（criterion・種別）を表示する", () => {
		const excluded = view({
			jobId: "ng",
			sourceUrl: "https://example.com/ng",
			rejectedBy: { criterion: "remoteWork", filter: "required" },
		});
		const html = renderRankingPage([], [excluded]);
		expect(html).toContain("除外");
		expect(html).toContain("リモートワーク"); // criterion の日本語ラベル
		expect(html).toContain("必須"); // required の可読化
	});

	it("求人が無いときは空状態メッセージを返す", () => {
		const html = renderRankingPage([], []);
		expect(html).toContain("求人がありません");
	});

	it("source_url と raw 値の HTML 特殊文字をエスケープする（XSS 防止）", () => {
		const html = renderRankingPage(
			[
				view({
					sourceUrl: "https://example.com/?q=<script>",
					breakdown: [
						{
							key: "techStack",
							kind: "categorical",
							weight: 1,
							score: 1,
							included: true,
							raw: "<script>alert(1)</script>",
						},
					],
				}),
			],
			[],
		);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
