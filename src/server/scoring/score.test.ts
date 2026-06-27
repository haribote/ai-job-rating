import { describe, expect, it } from "vitest";
import type {
	NormalizedFieldValue,
	NormalizedJob,
} from "../../shared/job-schema";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig, scoreJob } from "./score";

// テスト用に全キー unknown の求人を作り、必要なキーだけ実値で上書きする。
// なぜ: スコアリングは全キー必須の NormalizedJob を入力に取るため、最小構成を固定する。
function jobWith(
	overrides: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((key) => [key, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...overrides } as NormalizedJob;
}

describe("scoreJob 総合スコア", () => {
	it("全項目 unknown のときは分母 0 を表す total=null を返す（加点も減点もしない）", () => {
		const result = scoreJob(jobWith({}), DEFAULT_SCORING_CONFIG);
		expect(result.total).toBeNull();
		// 内訳は全項目が除外（included=false）
		expect(result.breakdown.every((b) => b.included === false)).toBe(true);
	});

	it("同一入力・同一設定なら同一スコア（決定的）", () => {
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
			remoteWork: { kind: "categorical", categories: ["full"] },
		});
		const a = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const b = scoreJob(job, DEFAULT_SCORING_CONFIG);
		expect(a.total).toBe(b.total);
		expect(a).toEqual(b);
	});

	it("総合スコア = Σ(weight·score)/Σ(weight)（unknown は分母から除外）", () => {
		// annualSalary(weight 任意) を希望充足=1.0、他は全 unknown にすると total=1。
		const config: ScoringConfig = {
			items: {
				annualSalary: {
					weight: 3,
					kind: "numericRange",
					direction: "higherBetter",
					desired: 700,
					floor: 300,
				},
			},
		};
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const result = scoreJob(job, config);
		// 希望(700)以上 → サブスコア1.0。設定にある唯一の項目なので total=1。
		expect(result.total).toBe(1);
	});

	it("2 項目の加重平均を重みに比例して算出する", () => {
		// item A: score=1.0 weight=3, item B: score=0.0 weight=1 → (3*1+1*0)/4 = 0.75
		const config: ScoringConfig = {
			items: {
				annualSalary: {
					weight: 3,
					kind: "numericRange",
					direction: "higherBetter",
					desired: 700,
					floor: 300,
				},
				overtime: {
					weight: 1,
					kind: "numericRange",
					direction: "lowerBetter",
					desired: 0,
					ceil: 40,
				},
			},
		};
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
			overtime: { kind: "numericRange", min: 40, max: 40 }, // ceil ちょうど → 0.0
		});
		const result = scoreJob(job, config);
		expect(result.total).toBe(0.75);
	});
});

describe("numericRange のサブスコア（higherBetter）", () => {
	const config: ScoringConfig = {
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

	it("希望値(desired)以上は 1.0（境界含む）", () => {
		const at = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 700, max: 700 } }),
			config,
		);
		const above = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 900, max: 900 } }),
			config,
		);
		expect(at.total).toBe(1);
		expect(above.total).toBe(1);
	});

	it("floor 以下は 0.0（境界含む）", () => {
		const result = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 300, max: 300 } }),
			config,
		);
		expect(result.total).toBe(0);
	});

	it("floor と desired の中間は線形補間する", () => {
		// (500-300)/(700-300) = 0.5
		const result = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 500, max: 500 } }),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("レンジは上限(max)で評価する（高いほど良いので有利側）", () => {
		// max=700 → desired 到達で 1.0
		const result = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 500, max: 700 } }),
			config,
		);
		expect(result.total).toBe(1);
	});
});

describe("numericRange のサブスコア（lowerBetter）", () => {
	const config: ScoringConfig = {
		items: {
			overtime: {
				weight: 1,
				kind: "numericRange",
				direction: "lowerBetter",
				desired: 10,
				ceil: 40,
			},
		},
	};

	it("希望値(desired)以下は 1.0（境界含む）", () => {
		const result = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 5, max: 5 } }),
			config,
		);
		expect(result.total).toBe(1);
	});

	it("ceil 以上は 0.0（多いほど減点）", () => {
		const result = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 50, max: 50 } }),
			config,
		);
		expect(result.total).toBe(0);
	});

	it("desired と ceil の中間は線形補間する", () => {
		// (25-10)/(40-10)=0.5 → 1-0.5=0.5
		const result = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 25, max: 25 } }),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("レンジは下限(min)で評価する（低いほど良いので有利側）", () => {
		const result = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 10, max: 30 } }),
			config,
		);
		expect(result.total).toBe(1);
	});
});

describe("categorical のサブスコア", () => {
	const config: ScoringConfig = {
		items: {
			remoteWork: {
				weight: 1,
				kind: "categorical",
				preferred: ["full", "partial"],
			},
		},
	};

	it("preferred 集合と一致すれば 1.0", () => {
		const result = scoreJob(
			jobWith({ remoteWork: { kind: "categorical", categories: ["full"] } }),
			config,
		);
		expect(result.total).toBe(1);
	});

	it("preferred と全く一致しなければ 0.0", () => {
		const result = scoreJob(
			jobWith({ remoteWork: { kind: "categorical", categories: ["onsite"] } }),
			config,
		);
		expect(result.total).toBe(0);
	});

	it("複数カテゴリのうち一致割合で算出する（部分一致）", () => {
		// categories=[full, onsite], preferred=[full, partial] → 一致1/全2 = 0.5
		const result = scoreJob(
			jobWith({
				remoteWork: { kind: "categorical", categories: ["full", "onsite"] },
			}),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("カテゴリが空なら unknown 扱いで分母から除外する", () => {
		const result = scoreJob(
			jobWith({ remoteWork: { kind: "categorical", categories: [] } }),
			config,
		);
		expect(result.total).toBeNull();
	});
});

describe("aiJudged のサブスコア", () => {
	const config: ScoringConfig = {
		items: { skillMatch: { weight: 1, kind: "aiJudged" } },
	};

	it("score(0..100) を 0..1 に正規化する", () => {
		const result = scoreJob(
			jobWith({ skillMatch: { kind: "aiJudged", score: 80 } }),
			config,
		);
		expect(result.total).toBe(0.8);
	});

	it("範囲外の score は 0..1 にクランプする", () => {
		const over = scoreJob(
			jobWith({ skillMatch: { kind: "aiJudged", score: 150 } }),
			config,
		);
		const under = scoreJob(
			jobWith({ skillMatch: { kind: "aiJudged", score: -10 } }),
			config,
		);
		expect(over.total).toBe(1);
		expect(under.total).toBe(0);
	});
});

describe("coverage のサブスコア（benefitsCoverage 充足率）", () => {
	const config: ScoringConfig = {
		items: { benefitsCoverage: { weight: 1, kind: "coverage" } },
	};

	it("充足率 present/total を 0..1 で算出する", () => {
		const result = scoreJob(
			jobWith({ benefitsCoverage: { kind: "coverage", present: 3, total: 6 } }),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("total が 0 なら評価不能（unknown 中立で分母から除外）", () => {
		const result = scoreJob(
			jobWith({ benefitsCoverage: { kind: "coverage", present: 0, total: 0 } }),
			config,
		);
		expect(result.total).toBeNull();
	});
});

describe("unknown 中立（§5.2）", () => {
	it("unknown 項目は分母にも分子にも入れない", () => {
		const config: ScoringConfig = {
			items: {
				annualSalary: {
					weight: 1,
					kind: "numericRange",
					direction: "higherBetter",
					desired: 700,
					floor: 300,
				},
				overtime: {
					weight: 99,
					kind: "numericRange",
					direction: "lowerBetter",
					desired: 0,
					ceil: 40,
				},
			},
		};
		// annualSalary のみ実値(1.0)、overtime は unknown → total は annualSalary だけで 1.0
		const job = jobWith({
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		});
		const result = scoreJob(job, config);
		expect(result.total).toBe(1);
		const overtimeRow = result.breakdown.find((b) => b.key === "overtime");
		expect(overtimeRow?.included).toBe(false);
		expect(overtimeRow?.score).toBeNull();
	});
});

describe("内訳（breakdown）— #13 への申し送り形", () => {
	it("項目ごとに key・kind・weight・score・included を返す", () => {
		const config: ScoringConfig = {
			items: {
				annualSalary: {
					weight: 2,
					kind: "numericRange",
					direction: "higherBetter",
					desired: 700,
					floor: 300,
				},
			},
		};
		const result = scoreJob(
			jobWith({ annualSalary: { kind: "numericRange", min: 700, max: 700 } }),
			config,
		);
		const row = result.breakdown.find((b) => b.key === "annualSalary");
		expect(row).toEqual({
			key: "annualSalary",
			kind: "numericRange",
			weight: 2,
			score: 1,
			included: true,
		});
	});

	it("breakdown は設定項目を決定的な順序で返す", () => {
		const a = scoreJob(jobWith({}), DEFAULT_SCORING_CONFIG);
		const b = scoreJob(jobWith({}), DEFAULT_SCORING_CONFIG);
		expect(a.breakdown.map((r) => r.key)).toEqual(
			b.breakdown.map((r) => r.key),
		);
	});
});

describe("DEFAULT_SCORING_CONFIG（固定設定）", () => {
	it("正規キーのみを参照する（未知キーを含まない）", () => {
		for (const key of Object.keys(DEFAULT_SCORING_CONFIG.items)) {
			expect(NORMALIZED_KEYS).toContain(key);
		}
	});

	it("全項目 weight は正の数（重みは加重平均の分母に効く）", () => {
		for (const item of Object.values(DEFAULT_SCORING_CONFIG.items)) {
			expect(item.weight).toBeGreaterThan(0);
		}
	});
});
