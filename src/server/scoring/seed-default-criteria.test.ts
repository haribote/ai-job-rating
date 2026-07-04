import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../../shared/job-schema";
import { readConfigItems } from "../config";
import { buildScoringConfig } from "./criteria-config";
import { readCriteriaConfig } from "./rescore";
import { DEFAULT_SCORING_CONFIG, scoreJob } from "./score";

// テスト用に全キー unknown の求人を作り、必要なキーだけ実値で上書きする（score.test.ts と同じ流儀）。
function jobWith(
	overrides: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((key) => [key, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...overrides } as NormalizedJob;
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("既定スコアリング設定の seed migration", () => {
	it("追加 INSERT なしで criteria_config が DEFAULT_SCORING_CONFIG と構造的に一致する", async () => {
		const rows = await readCriteriaConfig(env.DB);
		const built = buildScoringConfig(rows);
		expect(built).toEqual(DEFAULT_SCORING_CONFIG);
	});

	it("フォーク直後・設定未保存でも総合スコアが null にならない", async () => {
		const rows = await readCriteriaConfig(env.DB);
		const built = buildScoringConfig(rows);
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
			remoteWork: { kind: "categorical", categories: ["full"] },
		});
		const result = scoreJob(job, built);
		expect(result.total).not.toBeNull();
	});

	it("seed 後は readConfigItems（設定UI初期表示相当）が既定の実値を返す", async () => {
		const items = await readConfigItems(env.DB);
		const salary = items.find((i) => i.criterion === "annualSalary");
		expect(salary).toMatchObject({ weight: 5, hardFilter: "none" });
		expect(salary?.desired).toEqual({ desired: 700, floor: 300 });
	});

	// 企業軸（companySize/capital）も seed 済みで、抽出済みの企業規模から実値スコアが出る（#企業軸）。
	it("seed 後は企業規模・資本金が既定スコア項目として採点される", async () => {
		const rows = await readCriteriaConfig(env.DB);
		const built = buildScoringConfig(rows);
		expect(built.items.companySize).toBeDefined();
		expect(built.items.capital).toBeDefined();
		const job = jobWith({
			companySize: { kind: "numericRange", min: 1000, max: 1000 },
		});
		const result = scoreJob(job, built);
		const size = result.breakdown.find((b) => b.key === "companySize");
		expect(size?.score).not.toBeNull();
	});
});
