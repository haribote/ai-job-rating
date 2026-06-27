import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CriteriaConfigInput,
	inputsToConfigRows,
	parseWeight,
	readConfigItems,
} from "./config";
import { TABLE_NAMES } from "./storage/db-schema";

// ---------------------------------------------------------------------------
// 決定的バリデーション・変換（純関数）
// ---------------------------------------------------------------------------

describe("parseWeight", () => {
	it("非負の有限数のみ受理する（weight>=0 §5.2）", () => {
		expect(parseWeight(0)).toEqual({ ok: true, value: 0 });
		expect(parseWeight(3.5)).toEqual({ ok: true, value: 3.5 });
		expect(parseWeight(-1).ok).toBe(false);
		expect(parseWeight(Number.NaN).ok).toBe(false);
		expect(parseWeight("abc").ok).toBe(false);
	});
});

describe("inputsToConfigRows", () => {
	it("numericRange(higherBetter) は direction に応じ floor のみ採用する", () => {
		const r = inputsToConfigRows([
			{
				criterion: "annualSalary",
				weight: 5,
				hardFilter: "none",
				desired: { desired: 700, floor: 300, ceil: 999 },
			},
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(JSON.parse(r.rows[0].desired_value ?? "null")).toEqual({
			desired: 700,
			floor: 300,
		});
	});

	it("numericRange(lowerBetter) は ceil のみ採用する", () => {
		const r = inputsToConfigRows([
			{
				criterion: "overtime",
				weight: 2,
				hardFilter: "none",
				desired: { desired: 10, ceil: 45 },
			},
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(JSON.parse(r.rows[0].desired_value ?? "null")).toEqual({
			desired: 10,
			ceil: 45,
		});
	});

	it("categorical は preferred 集合を trim/空除去して JSON 化する", () => {
		const r = inputsToConfigRows([
			{
				criterion: "remoteWork",
				weight: 3,
				hardFilter: "required",
				desired: { preferred: [" full ", "partial", ""] },
			},
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows[0].hard_filter).toBe("required");
		expect(JSON.parse(r.rows[0].desired_value ?? "null")).toEqual({
			preferred: ["full", "partial"],
		});
	});

	it("希望値なしは desired_value=null（中立・評価不能）", () => {
		const r = inputsToConfigRows([
			{ criterion: "annualSalary", weight: 5, hardFilter: "none" },
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows[0].desired_value).toBeNull();
	});

	it("不正な criterion は criterion 理由で拒否する", () => {
		const r = inputsToConfigRows([
			{ criterion: "bogus", weight: 1, hardFilter: "none" },
		]);
		expect(r).toEqual({ ok: false, reason: "criterion" });
	});

	it("負の重みは weight 理由で拒否する", () => {
		const r = inputsToConfigRows([
			{ criterion: "annualSalary", weight: -1, hardFilter: "none" },
		]);
		expect(r).toEqual({ ok: false, reason: "weight" });
	});

	it("集合外の hard_filter は hard_filter 理由で拒否する", () => {
		const r = inputsToConfigRows([
			{
				criterion: "annualSalary",
				weight: 1,
				hardFilter: "banana" as CriteriaConfigInput["hardFilter"],
			},
		]);
		expect(r).toEqual({ ok: false, reason: "hard_filter" });
	});
});

// ---------------------------------------------------------------------------
// 取得（DB I/O）
// ---------------------------------------------------------------------------

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM criteria_config").run();
});

describe("readConfigItems", () => {
	it("全正規キーぶん返し、未保存キーは既定（weight=1/none/desired=null）", async () => {
		const items = await readConfigItems(env.DB);
		expect(items.length).toBe(21);
		const salary = items.find((i) => i.criterion === "annualSalary");
		expect(salary).toMatchObject({
			kind: "numericRange",
			weight: 1,
			hardFilter: "none",
			desired: null,
		});
	});

	it("保存済み設定を構造化して返す", async () => {
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES ('annualSalary', ?, 7, 'required')`,
		)
			.bind(JSON.stringify({ desired: 800, floor: 400 }))
			.run();
		const items = await readConfigItems(env.DB);
		const salary = items.find((i) => i.criterion === "annualSalary");
		expect(salary).toMatchObject({ weight: 7, hardFilter: "required" });
		expect(salary?.desired).toEqual({ desired: 800, floor: 400 });
	});
});
