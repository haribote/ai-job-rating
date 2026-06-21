import { describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import { rawFieldsToNormalizedJob } from "./extract";
import { NORMALIZED_KEYS } from "./job-schema";
import {
	CANDIDATE_MODELS,
	compareModels,
	diffJobs,
	summarizeExtraction,
} from "./model-comparison";

// 比較対象モデル（一次ソースで ID を確認済み）。重複なく定義されていること。
describe("CANDIDATE_MODELS", () => {
	it("モデル ID が重複なく定義されている", () => {
		const ids = CANDIDATE_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("各候補は JSON Mode 対応状況を一次ソース確認結果として持つ", () => {
		for (const m of CANDIDATE_MODELS) {
			// jsonModeListed: JSON Mode 機能ページの対応モデル一覧に載るか（一次ソース）
			expect(typeof m.jsonModeListed).toBe("boolean");
			expect(typeof m.id).toBe("string");
		}
	});
});

// 抽出結果の決定的サマリ: present/unknown 数を数え、比較の母数を出す。
describe("summarizeExtraction", () => {
	it("全 unknown の求人は valueCount 0・unknownCount が全キー数", () => {
		const job = rawFieldsToNormalizedJob({});
		const s = summarizeExtraction(job);
		expect(s.valueCount).toBe(0);
		expect(s.unknownCount).toBe(NORMALIZED_KEYS.length);
	});

	it("値があるキーは present に数え、unknown は数えない", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "700万〜900万",
			remoteWork: "フルリモート",
		});
		const s = summarizeExtraction(job);
		expect(s.valueCount).toBe(2);
		expect(s.unknownCount).toBe(NORMALIZED_KEYS.length - 2);
		expect(s.presentKeys).toContain("annualSalary");
		expect(s.presentKeys).toContain("remoteWork");
	});

	it("同一入力は常に同一サマリ（決定的）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		expect(summarizeExtraction(job)).toEqual(summarizeExtraction(job));
	});
});

// 2モデル間のキー単位 diff: 一致/不一致/片側のみ present を分類する。
describe("diffJobs", () => {
	it("両モデルが同じ raw を返したキーは agree に入る", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		const d = diffJobs(a, b);
		expect(d.agree).toContain("annualSalary");
		expect(d.disagree).not.toContain("annualSalary");
	});

	it("両モデルが present だが raw が異なるキーは disagree に入る", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "600万〜800万" });
		const d = diffJobs(a, b);
		expect(d.disagree).toContain("annualSalary");
		expect(d.agree).not.toContain("annualSalary");
	});

	it("片側だけ present なキーは onlyA / onlyB に入る", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const b = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const d = diffJobs(a, b);
		expect(d.onlyA).toContain("annualSalary");
		expect(d.onlyB).toContain("remoteWork");
	});

	it("両側 unknown なキーは bothUnknown に入り、他の分類に重複しない", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const d = diffJobs(a, b);
		// overtime は両方未指定 → bothUnknown
		expect(d.bothUnknown).toContain("overtime");
		expect(d.agree).not.toContain("overtime");
	});

	it("各キーはちょうど 1 分類にだけ属する（網羅・排他）", () => {
		const a = rawFieldsToNormalizedJob({
			annualSalary: "700万",
			overtime: "20時間",
		});
		const b = rawFieldsToNormalizedJob({
			annualSalary: "700万",
			remoteWork: "可",
		});
		const d = diffJobs(a, b);
		const buckets = [
			...d.agree,
			...d.disagree,
			...d.onlyA,
			...d.onlyB,
			...d.bothUnknown,
		];
		// 全キーが過不足なく 1 回ずつ分類される
		expect(buckets.sort()).toEqual([...NORMALIZED_KEYS].sort());
	});

	it("同一入力は常に同一 diff（決定的）", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "800万" });
		expect(diffJobs(a, b)).toEqual(diffJobs(a, b));
	});
});

// オーケストレーション: モデル × fixture で extractJob を回し結果表を返す（AI 注入）。
describe("compareModels", () => {
	it("各モデル × 各 fixture で抽出を実行し、使ったモデルを記録する", async () => {
		const calls: string[] = [];
		// fixture 本文に応じて model 別の生出力を返す fake（決定性のため固定）
		const fakeAi: AiRunner = {
			run: async (model: string) => {
				calls.push(model);
				return { response: { annualSalary: "700万" } };
			},
		};
		const models = ["@cf/model-a", "@cf/model-b"];
		const fixtures = [
			{ name: "job1", body: "年収 700万" },
			{ name: "job2", body: "年収 800万" },
		];

		const report = await compareModels(fakeAi, fixtures, models);

		// 2 モデル × 2 fixture = 4 回呼ぶ
		expect(calls).toHaveLength(4);
		expect(report).toHaveLength(2); // fixture 単位
		expect(report[0].fixture).toBe("job1");
		expect(report[0].results).toHaveLength(2); // モデル単位
		expect(report[0].results[0].model).toBe("@cf/model-a");
		expect(report[0].results[0].summary.valueCount).toBe(1);
	});

	it("空 fixture リストでは AI を呼ばず空レポートを返す", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};
		const report = await compareModels(fakeAi, [], ["@cf/model-a"]);
		expect(called).toBe(false);
		expect(report).toEqual([]);
	});
});
