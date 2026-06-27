import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { NormalizedJob } from "./job-schema";
import {
	escapeHtml,
	formatScorePercent,
	formatSubScore,
	renderExtractionFailedPage,
	renderResultPage,
} from "./result-display";
import type { ScoreResult } from "./score";

// 全 unknown の最小 job。表示テストは個別キーだけ上書きして使う。
function allUnknownJob(): NormalizedJob {
	const keys = [
		"annualSalary",
		"monthlySalary",
		"bonus",
		"salaryRaise",
		"retirementAllowance",
		"overtime",
		"annualHolidays",
		"holidaySystem",
		"paidLeaveRate",
		"remoteWork",
		"flexWork",
		"workLocation",
		"employmentType",
		"employmentTerm",
		"techStack",
		"requiredSkillsMatch",
		"preferredSkillsMatch",
		"businessDomain",
		"languageRequirement",
		"companySize",
		"companyPhase",
	] as const;
	const entries = keys.map((k) => [k, { kind: "unknown" }] as const);
	return Object.fromEntries(entries) as NormalizedJob;
}

// HTML エスケープ。raw 値・本文を埋め込むため XSS を防ぐ決定的関数として担保する。
describe("escapeHtml", () => {
	it("HTML 特殊文字をすべてエスケープする", () => {
		expect(escapeHtml(`<script>alert("x&y")</script>'`)).toBe(
			"&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;",
		);
	});

	// & を最初に処理しないと二重エスケープになるため順序を担保する
	it("既存の実体参照を二重エスケープしない形で & を先に処理する", () => {
		expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
	});
});

// 総合スコアの可読化。0..1 を % へ、null は「評価できる項目なし」を区別して表示する。
describe("formatScorePercent", () => {
	it("0..1 を四捨五入した整数 % で表示する", () => {
		expect(formatScorePercent(0.726)).toBe("73%");
		expect(formatScorePercent(1)).toBe("100%");
		expect(formatScorePercent(0)).toBe("0%");
	});

	// total=null は 0 と区別し「評価できる項目なし」と表示する（unknown 中立の可視化）
	it("null は評価できる項目なしと表示する", () => {
		expect(formatScorePercent(null)).toBe("評価できる項目なし");
	});
});

// サブスコアの可読化。除外項目（null）は「情報なし」を表示する。
describe("formatSubScore", () => {
	it("採用項目は % 表示する", () => {
		expect(formatSubScore(0.5)).toBe("50%");
	});

	it("除外項目（null）は情報なしと表示する", () => {
		expect(formatSubScore(null)).toBe("情報なし");
	});
});

// 結果ページ描画。ScoreResult と NormalizedJob を忠実に SSR へ落とす決定的関数。
describe("renderResultPage", () => {
	it("総合スコアを % 表示する", () => {
		const result: ScoreResult = { total: 0.5, breakdown: [] };
		const html = renderResultPage(result, allUnknownJob());
		expect(html).toContain("50%");
	});

	it("total=null は評価できる項目なしと表示する", () => {
		const result: ScoreResult = { total: null, breakdown: [] };
		const html = renderResultPage(result, allUnknownJob());
		expect(html).toContain("評価できる項目なし");
	});

	it("内訳行に日本語ラベル・kind・weight・サブスコアを出す", () => {
		const result: ScoreResult = {
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
		};
		const job = allUnknownJob();
		const html = renderResultPage(result, {
			...job,
			annualSalary: { kind: "numericRange", min: 700, max: 700, raw: "700万" },
		});
		expect(html).toContain("年収"); // 日本語ラベル
		expect(html).toContain("50%"); // サブスコア
		expect(html).toContain("700万"); // raw 値
	});

	it("included=false の行は情報なしと表示する（unknown 中立の可視化）", () => {
		const result: ScoreResult = {
			total: null,
			breakdown: [
				{
					key: "annualSalary",
					kind: "numericRange",
					weight: 5,
					score: null,
					included: false,
				},
			],
		};
		const html = renderResultPage(result, allUnknownJob());
		expect(html).toContain("情報なし");
	});

	it("raw 値の HTML 特殊文字をエスケープする（XSS 防止）", () => {
		const result: ScoreResult = {
			total: 1,
			breakdown: [
				{
					key: "techStack",
					kind: "categorical",
					weight: 1,
					score: 1,
					included: true,
				},
			],
		};
		const job = allUnknownJob();
		const html = renderResultPage(result, {
			...job,
			techStack: {
				kind: "categorical",
				categories: ["<script>"],
				raw: "<script>alert(1)</script>",
			},
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

// 抽出失敗の導線（#26）。スコア結果でも取得失敗でもない第三の状態を明示する。
describe("renderExtractionFailedPage", () => {
	// 抽出失敗を「評価できる項目なし（unknown 中立）」と混同させない明示メッセージを出す。
	it("抽出失敗を明示し再試行・貼付フォールバックへ誘導する", () => {
		const html = renderExtractionFailedPage();
		expect(html).toContain("抽出に失敗しました");
		// 再試行と貼付フォールバックの導線を置く（§8 エラーハンドリング）。
		expect(html).toContain('href="/paste"');
		// スコア結果ページと取り違えない（別状態であることを担保）。
		expect(html).not.toContain("スコア結果");
	});
});

// 結果表示ルート。貼付 HTML → trim → 抽出（AI モック）→ 永続化 → score → 表示を通す（#26）。
describe("POST /result", () => {
	// 取込が jobs/extractions/R2 へ書くため、毎回まっさらな D1/R2 を用意する。
	beforeEach(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		await env.DB.prepare("DELETE FROM jobs").run();
		await env.DB.prepare("DELETE FROM criteria_config").run();
	});

	// AI 抽出はモックで決定的にする（live は要手動検証）。年収だけ返させ表示まで通す。
	it("貼付 HTML を抽出・スコアして結果ページを返す", async () => {
		// スコアは保存済み criteria_config 駆動（#20/#26）。年収基準を入れて内訳に出させる。
		await env.DB.prepare(
			"INSERT INTO criteria_config (criterion, desired_value, weight, hard_filter) VALUES ('annualSalary', ?, 5, 'none')",
		)
			.bind(JSON.stringify({ desired: 700, floor: 300 }))
			.run();
		const aiRun = vi.fn(async () => ({
			response: { annualSalary: "700万〜900万" },
		}));
		const testEnv = { ...env, AI: { run: aiRun } };

		const form = new URLSearchParams({
			html: "<html><body><p>想定年収 700万〜900万</p></body></html>",
		});
		const res = await app.request(
			"/result",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			testEnv,
		);

		expect(res.status).toBe(200);
		expect(aiRun).toHaveBeenCalledOnce();
		const body = await res.text();
		expect(body).toContain("年収");
		expect(body).toContain("700万〜900万"); // raw 値が表示される
	});

	it("空入力は 400 で拒否し AI を呼ばない", async () => {
		const aiRun = vi.fn(async () => ({ response: {} }));
		const testEnv = { ...env, AI: { run: aiRun } };
		const form = new URLSearchParams({ html: "" });
		const res = await app.request(
			"/result",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			testEnv,
		);
		expect(res.status).toBe(400);
		expect(aiRun).not.toHaveBeenCalled();
	});
});
