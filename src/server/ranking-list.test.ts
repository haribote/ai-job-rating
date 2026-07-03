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
			null,
			null,
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

	// #200: companyName/jobTitle は表示専用でスコアリングに影響しない並列カラム由来。
	it("companyName/jobTitle をそのままビューへ渡す", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({}),
			"ok",
			"株式会社サンプル",
			"バックエンドエンジニア",
		);
		expect(view.companyName).toBe("株式会社サンプル");
		expect(view.jobTitle).toBe("バックエンドエンジニア");
	});
});

describe("toRankingItem", () => {
	it("一覧行へ縮約する（company/title は実値・軸別スコアは breakdown から集約する）", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({}),
			"ok",
			"株式会社サンプル",
			"バックエンドエンジニア",
		);
		expect(toRankingItem(view)).toEqual({
			jobId: "j1",
			sourceUrl: "https://example.com/1",
			company: "株式会社サンプル",
			title: "バックエンドエンジニア",
			total: 0.8,
			status: "ok",
			rejectedBy: null,
			categoryScores: {
				compensation: 0.8,
				integrity: null,
				flexibility: null,
				role: null,
				company: null,
			},
		});
	});

	it("companyName/jobTitle が null なら company/title も null（抽出失敗時の URL フォールバック維持）", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({}),
			"ok",
			null,
			null,
		);
		expect(toRankingItem(view)).toMatchObject({ company: null, title: null });
	});

	it("軸別スコアは決定的（同一 view から同一 categoryScores）", () => {
		const view = rescoredToView(
			rescored,
			"https://example.com/1",
			jobWith({}),
			"ok",
			null,
			null,
		);
		expect(toRankingItem(view).categoryScores).toEqual(
			toRankingItem(view).categoryScores,
		);
	});
});
