import { describe, expect, it } from "vitest";
import type {
	NormalizedFieldValue,
	NormalizedJob,
} from "../../shared/job-schema";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { HardFilterMap } from "./criteria-config";
import {
	applyExtractionStatus,
	passesHardFilters,
	type RescoredJob,
	rankJobs,
	rescoreJob,
} from "./rescore-core";
import type { ScoringConfig } from "./score";

// 全キー unknown の最小求人を作り、必要キーだけ実値で上書きする。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

const salaryConfig: ScoringConfig = {
	items: {
		annualSalary: {
			weight: 1,
			kind: "numericRange",
			direction: "higherBetter",
			desired: 700,
			floor: 300,
		},
	},
};

describe("applyExtractionStatus（failed と unknown 中立の区別）", () => {
	it("failed は保存値を信頼せず全項目を unknown 中立化する", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const out = applyExtractionStatus(job, "failed");
		expect(out.annualSalary).toEqual({ kind: "unknown" });
	});

	it("partial は値をそのまま採用する（取れない項目は値が unknown のまま）", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const out = applyExtractionStatus(job, "partial");
		expect(out.annualSalary).toEqual({
			kind: "numericRange",
			min: 800,
			max: 800,
		});
	});

	it("ok は値をそのまま採用する", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		expect(applyExtractionStatus(job, "ok")).toBe(job);
	});
});

describe("passesHardFilters（required / exclude）", () => {
	it("required: 該当すれば通過する", () => {
		const job = jobWith({
			remoteWork: { kind: "categorical", categories: ["full"] },
		});
		const config: ScoringConfig = {
			items: {
				remoteWork: { weight: 1, kind: "categorical", preferred: ["full"] },
			},
		};
		const filters: HardFilterMap = { remoteWork: "required" };
		expect(passesHardFilters(job, config, filters).passed).toBe(true);
	});

	it("required: 該当しなければ除外し rejectedBy を残す", () => {
		const job = jobWith({
			remoteWork: { kind: "categorical", categories: ["onsite"] },
		});
		const config: ScoringConfig = {
			items: {
				remoteWork: { weight: 1, kind: "categorical", preferred: ["full"] },
			},
		};
		const result = passesHardFilters(job, config, { remoteWork: "required" });
		expect(result.passed).toBe(false);
		expect(result.rejectedBy).toEqual({
			criterion: "remoteWork",
			filter: "required",
		});
	});

	it("required: unknown は『満たした』とは扱わず除外する（unknown 中立と区別）", () => {
		const job = jobWith({}); // remoteWork は unknown
		const config: ScoringConfig = {
			items: {
				remoteWork: { weight: 1, kind: "categorical", preferred: ["full"] },
			},
		};
		expect(
			passesHardFilters(job, config, { remoteWork: "required" }).passed,
		).toBe(false);
	});

	it("exclude: 該当すれば除外する", () => {
		const job = jobWith({
			flexWork: { kind: "categorical", categories: ["flex"] },
		});
		const config: ScoringConfig = {
			items: {
				flexWork: {
					weight: 1,
					kind: "categorical",
					preferred: ["flex"],
				},
			},
		};
		expect(passesHardFilters(job, config, { flexWork: "exclude" }).passed).toBe(
			false,
		);
	});

	it("exclude: unknown は除外しない（判定不能は中立）", () => {
		const job = jobWith({});
		const config: ScoringConfig = {
			items: {
				flexWork: {
					weight: 1,
					kind: "categorical",
					preferred: ["flex"],
				},
			},
		};
		expect(passesHardFilters(job, config, { flexWork: "exclude" }).passed).toBe(
			true,
		);
	});

	it("required: numericRange は希望を満たすかで判定する", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		expect(
			passesHardFilters(job, salaryConfig, { annualSalary: "required" }).passed,
		).toBe(true);
		const low = jobWith({
			annualSalary: { kind: "numericRange", min: 400, max: 400 },
		});
		expect(
			passesHardFilters(low, salaryConfig, { annualSalary: "required" }).passed,
		).toBe(false);
	});

	it("複数フィルタの除外理由は criterion 昇順で決定的", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 100, max: 100 },
			remoteWork: { kind: "categorical", categories: ["onsite"] },
		});
		const config: ScoringConfig = {
			items: {
				...salaryConfig.items,
				remoteWork: { weight: 1, kind: "categorical", preferred: ["full"] },
			},
		};
		const filters: HardFilterMap = {
			annualSalary: "required",
			remoteWork: "required",
		};
		// annualSalary < remoteWork（昇順）なので annualSalary が先に除外理由になる
		expect(passesHardFilters(job, config, filters).rejectedBy?.criterion).toBe(
			"annualSalary",
		);
	});
});

describe("rescoreJob（1 件再スコアリング・決定的・AI 非依存）", () => {
	it("同一入力・同一設定なら同一スコア（決定的、§8）", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const a = rescoreJob("j1", job, "ok", salaryConfig, {});
		const b = rescoreJob("j1", job, "ok", salaryConfig, {});
		expect(a).toEqual(b);
		expect(a.score.total).toBe(1);
	});

	it("failed は全項目中立で total=null（分母 0）になる", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const r = rescoreJob("j1", job, "failed", salaryConfig, {});
		expect(r.score.total).toBeNull();
	});

	it("ハードフィルタ除外でも score は算出する（#18 内訳表示）", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const r = rescoreJob("j1", job, "ok", salaryConfig, {
			annualSalary: "exclude",
		});
		// 800 は desired 以上で exclude 該当 → 除外。だが score は出る。
		expect(r.hardFilter.passed).toBe(false);
		expect(r.score.total).toBe(1);
	});

	describe("skillMatch（keyword ヒット採点・#105）", () => {
		const skillConfig: ScoringConfig = {
			items: {
				skillMatch: { weight: 1, kind: "keywordMatch", keywords: ["go"] },
			},
		};

		it("求人スキル × keyword の決定的ヒット率を 0..1 で加重に組込む", () => {
			// keyword [go] のうち求人 [go, ts] に出現するのは 1/1 = 100 → 1.0
			const job = jobWith({
				skillMatch: { kind: "categorical", categories: ["go", "ts"] },
			});
			const r = rescoreJob("j1", job, "ok", skillConfig, {});
			expect(r.score.total).toBe(1);
		});

		it("求人スキル不明（categories 空）は unknown 中立のまま（分母から除外）", () => {
			const job = jobWith({
				skillMatch: { kind: "categorical", categories: [] },
			});
			const r = rescoreJob("j1", job, "ok", skillConfig, {});
			expect(r.score.total).toBeNull();
		});

		it("keyword 未指定（意見なし）は中立（分母から除外）", () => {
			const neutral: ScoringConfig = {
				items: {
					skillMatch: { weight: 1, kind: "keywordMatch", keywords: [] },
				},
			};
			const job = jobWith({
				skillMatch: { kind: "categorical", categories: ["go", "ts"] },
			});
			const r = rescoreJob("j1", job, "ok", neutral, {});
			expect(r.score.total).toBeNull();
		});
	});
});

describe("rankJobs（決定的ランキング）", () => {
	function ranked(
		jobId: string,
		total: number | null,
		passed = true,
	): RescoredJob {
		return {
			jobId,
			score: { total, breakdown: [] },
			hardFilter: { passed, rejectedBy: null },
		};
	}

	it("スコア降順に並べる", () => {
		const out = rankJobs([
			ranked("a", 0.3),
			ranked("b", 0.9),
			ranked("c", 0.6),
		]);
		expect(out.map((r) => r.jobId)).toEqual(["b", "c", "a"]);
	});

	it("ハードフィルタ除外はランキングから外す", () => {
		const out = rankJobs([ranked("a", 0.9, false), ranked("b", 0.1, true)]);
		expect(out.map((r) => r.jobId)).toEqual(["b"]);
	});

	it("total=null は末尾、同点・同 null は jobId 昇順で安定", () => {
		const out = rankJobs([
			ranked("z", null),
			ranked("a", null),
			ranked("y", 0.5),
			ranked("x", 0.5),
		]);
		expect(out.map((r) => r.jobId)).toEqual(["x", "y", "a", "z"]);
	});
});
