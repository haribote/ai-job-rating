import { describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../shared/job-schema";
import { rescoredToView, toRankingItem } from "./ranking-list";
import type { RescoredJob } from "./scoring/rescore-core";

function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

const rescored: RescoredJob = {
	jobId: "j1",
	score: {
		total: 0.8,
		breakdown: [
			{
				key: "annualSalary",
				kind: "numericRange",
				weight: 5,
				score: 0.8,
				included: true,
			},
		],
	},
	hardFilter: { passed: true, rejectedBy: null },
};

describe("rescoredToView", () => {
	it("score/raw/status を忠実に構造化する（HTML を持たない）", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({
				annualSalary: {
					kind: "numericRange",
					min: 800,
					max: 800,
					raw: "800万",
				},
			}),
			"ok",
		);
		expect(view).toMatchObject({
			jobId: "j1",
			sourceUrl: "https://example.com/1",
			status: "ok",
			total: 0.8,
			rejectedBy: null,
		});
		expect(view.breakdown[0]).toMatchObject({
			key: "annualSalary",
			score: 0.8,
			included: true,
			raw: "800万",
		});
	});
});

describe("toRankingItem", () => {
	it("一覧行へ縮約する（company/title は現状 null・内訳は持たない）", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({}),
			"ok",
		);
		expect(toRankingItem(view)).toEqual({
			jobId: "j1",
			sourceUrl: "https://example.com/1",
			company: null,
			title: null,
			total: 0.8,
			status: "ok",
			rejectedBy: null,
		});
	});
});
