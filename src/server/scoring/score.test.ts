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

	it("既定の flexWork preferred は flex のみ（裁量労働を歓迎しない）", () => {
		const flexWork = DEFAULT_SCORING_CONFIG.items.flexWork;
		expect(flexWork?.kind).toBe("categorical");
		if (flexWork?.kind === "categorical") {
			expect(flexWork.preferred).toEqual(["flex"]);
		}
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

describe("bonus（年間支給回数・higherBetter）の採点", () => {
	// 回数が多いほど高スコア。desired=4/floor=0 で境界の単調性を固定する（#142）。
	const config: ScoringConfig = {
		items: {
			bonus: {
				weight: 1,
				kind: "numericRange",
				direction: "higherBetter",
				desired: 4,
				floor: 0,
			},
		},
	};

	it("支給回数が多いほど高スコア（年4回 > 年2回 > 年1回）", () => {
		const once = scoreJob(
			jobWith({ bonus: { kind: "numericRange", min: 1, max: 1 } }),
			config,
		);
		const twice = scoreJob(
			jobWith({ bonus: { kind: "numericRange", min: 2, max: 2 } }),
			config,
		);
		const four = scoreJob(
			jobWith({ bonus: { kind: "numericRange", min: 4, max: 4 } }),
			config,
		);
		expect(once.total).toBe(0.25);
		expect(twice.total).toBe(0.5);
		expect(four.total).toBe(1);
		expect(four.total ?? 0).toBeGreaterThan(twice.total ?? 0);
		expect(twice.total ?? 0).toBeGreaterThan(once.total ?? 0);
	});

	it("回数 unknown は中立（分母から除外）", () => {
		const result = scoreJob(jobWith({ bonus: { kind: "unknown" } }), config);
		expect(result.total).toBeNull();
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

describe("overtime 特例（有り明記だが定量なし）", () => {
	// unknown 中立の意図的例外（§5.2 / 設計 §5.2）。
	// 境界: 記載なし=中立 / 有り明記・定量なし=減点 / 定量値あり=値ベース採点 を厳密に固定する。
	const config: ScoringConfig = {
		items: {
			overtime: {
				weight: 3,
				kind: "numericRange",
				direction: "lowerBetter",
				desired: 10,
				ceil: 45,
			},
		},
	};

	it("有り明記だが定量なし（stated unknown）は中立でなく減点する（sub-score 0・分母に算入）", () => {
		const result = scoreJob(
			jobWith({ overtime: { kind: "unknown", stated: true, raw: "残業あり" } }),
			config,
		);
		// 減点 = 最悪値 0 を分母へ算入する（excluded ではない）。
		expect(result.total).toBe(0);
		const row = result.breakdown.find((b) => b.key === "overtime");
		expect(row?.included).toBe(true);
		expect(row?.score).toBe(0);
	});

	it("記載なし（stated でない unknown）は従来通り中立（分母から除外）", () => {
		const result = scoreJob(jobWith({ overtime: { kind: "unknown" } }), config);
		expect(result.total).toBeNull();
		const row = result.breakdown.find((b) => b.key === "overtime");
		expect(row?.included).toBe(false);
		expect(row?.score).toBeNull();
	});

	it("定量値あり（numericRange）は値ベースで連続採点する（特例に落ちない）", () => {
		const atDesired = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 5, max: 5 } }),
			config,
		);
		const middle = scoreJob(
			jobWith({ overtime: { kind: "numericRange", min: 27.5, max: 27.5 } }),
			config,
		);
		expect(atDesired.total).toBe(1); // desired(10) 以下 → 1.0
		expect(middle.total).toBe(0.5); // (27.5-10)/(45-10)=0.5 → 1-0.5
	});

	it("減点(有り明記・定量なし)は中立(記載なし)より総合スコアを下げる", () => {
		// overtime 以外を 1.0 充足させ、overtime の状態だけで総合スコアの差を固定する。
		const mixed: ScoringConfig = {
			items: {
				annualSalary: {
					weight: 1,
					kind: "numericRange",
					direction: "higherBetter",
					desired: 700,
					floor: 300,
				},
				overtime: {
					weight: 1,
					kind: "numericRange",
					direction: "lowerBetter",
					desired: 10,
					ceil: 45,
				},
			},
		};
		const salary = {
			annualSalary: { kind: "numericRange", min: 800, max: 800 },
		} as const;
		const penalized = scoreJob(
			jobWith({ ...salary, overtime: { kind: "unknown", stated: true } }),
			mixed,
		);
		const neutral = scoreJob(
			jobWith({ ...salary, overtime: { kind: "unknown" } }),
			mixed,
		);
		// 減点: (1*1 + 1*0)/2 = 0.5 / 中立: overtime 除外で 1*1/1 = 1.0。
		expect(penalized.total).toBe(0.5);
		expect(neutral.total).toBe(1);
		expect(penalized.total).toBeLessThan(neutral.total as number);
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

describe("categorical の tier 採点（フルリモート別格・#104）", () => {
	// なぜ tierScores か: preferred 集合一致率だと full/partial が等価（共に 1.0）になり
	// 「フルリモート別格」を表現できない。順序づけスコアで full > partial > onsite を決定的に差別化する。
	const config: ScoringConfig = {
		items: {
			remoteWork: {
				weight: 1,
				kind: "categorical",
				preferred: ["full", "partial"],
				tierScores: { full: 1, partial: 0.5, onsite: 0 },
			},
		},
	};
	const sub = (category: string): number =>
		scoreJob(
			jobWith({ remoteWork: { kind: "categorical", categories: [category] } }),
			config,
		).total ?? Number.NaN;

	it("full は別格で 1.0", () => {
		expect(sub("full")).toBe(1);
	});

	it("partial は full より明確に低い（0.5）", () => {
		expect(sub("partial")).toBe(0.5);
	});

	it("onsite は 0.0", () => {
		expect(sub("onsite")).toBe(0);
	});

	it("full > partial > onsite の順序が成立する（別格加点の不変条件）", () => {
		expect(sub("full")).toBeGreaterThan(sub("partial"));
		expect(sub("partial")).toBeGreaterThan(sub("onsite"));
	});

	it("canonical 外の生表記カテゴリは tier に無く 0.0（記載はあるので included=true・中立ではない）", () => {
		const result = scoreJob(
			jobWith({ remoteWork: { kind: "categorical", categories: ["応相談"] } }),
			config,
		);
		expect(result.total).toBe(0);
		const row = result.breakdown.find((b) => b.key === "remoteWork");
		expect(row?.included).toBe(true);
	});

	it("記載なし(unknown)は従来どおり中立で分母から除外(null)", () => {
		expect(scoreJob(jobWith({}), config).total).toBeNull();
	});

	it("複数カテゴリは tier スコアの平均（決定的・[full,onsite]→0.5）", () => {
		const result = scoreJob(
			jobWith({
				remoteWork: { kind: "categorical", categories: ["full", "onsite"] },
			}),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("プロトタイプ継承キーに一致する生表記でも NaN 化せず 0.0（own のみ参照）", () => {
		const result = scoreJob(
			jobWith({
				remoteWork: { kind: "categorical", categories: ["constructor"] },
			}),
			config,
		);
		expect(result.total).toBe(0);
	});
});

describe("keywordMatch のサブスコア（求人スキル × keyword ヒット率・#105）", () => {
	const config: ScoringConfig = {
		items: {
			skillMatch: { weight: 1, kind: "keywordMatch", keywords: ["go", "ts"] },
		},
	};

	it("keyword のヒット率を 0..1 に正規化する", () => {
		// keyword [go, ts] のうち求人 [go, ts, rust] に出現するのは 2/2 = 100 → 1.0
		const result = scoreJob(
			jobWith({
				skillMatch: { kind: "categorical", categories: ["go", "ts", "rust"] },
			}),
			config,
		);
		expect(result.total).toBe(1);
	});

	it("一部ヒットは割合になる（keyword 基準）", () => {
		// keyword [go, ts] のうち求人 [go] に出現するのは go のみ 1/2 = 0.5
		const result = scoreJob(
			jobWith({ skillMatch: { kind: "categorical", categories: ["go"] } }),
			config,
		);
		expect(result.total).toBe(0.5);
	});

	it("keyword 未指定は中立（included=false・分母から除外）", () => {
		const neutral: ScoringConfig = {
			items: { skillMatch: { weight: 1, kind: "keywordMatch", keywords: [] } },
		};
		const result = scoreJob(
			jobWith({ skillMatch: { kind: "categorical", categories: ["go"] } }),
			neutral,
		);
		expect(result.total).toBeNull();
		expect(result.breakdown.find((r) => r.key === "skillMatch")?.included).toBe(
			false,
		);
	});

	it("求人スキル不明（categories 空）・unknown は中立（分母から除外）", () => {
		const emptyCats = scoreJob(
			jobWith({ skillMatch: { kind: "categorical", categories: [] } }),
			config,
		);
		const unknown = scoreJob(
			jobWith({ skillMatch: { kind: "unknown" } }),
			config,
		);
		expect(emptyCats.total).toBeNull();
		expect(unknown.total).toBeNull();
	});

	it("旧 aiJudged 由来の保存値は categorical でないので安全に中立へ畳む（後方互換・#105）", () => {
		// 廃止済みの { kind: "aiJudged", score } 形が structured_json に残っていても、
		// keywordMatch は categorical 以外を中立（null）にするため誤採点しない。
		const legacy = {
			kind: "aiJudged",
			score: 80,
		} as unknown as NormalizedFieldValue;
		const result = scoreJob(jobWith({ skillMatch: legacy }), config);
		expect(result.total).toBeNull();
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

	it("signals があれば canonical 閉集合の充足率で算出する", () => {
		const result = scoreJob(
			jobWith({
				benefitsCoverage: {
					kind: "coverage",
					present: 20,
					total: 20,
					signals: [
						"twoDayWeekoff",
						"completeTwoDayWeekoff",
						"fourWeekEightOff",
						"paidLeave",
						"condolenceLeave",
						"seasonalLeave",
						"refreshLeave",
						"familyCareLeave",
						"specialLeave",
						"nursingLeave",
						"retirementAllowance",
						"allowances",
						"trainingSupport",
						"healthCare",
						"equityProgram",
						"sideJob",
						"socialInsurance",
						"parentalRecord",
						"shorterHours",
						"companyHousing",
					],
				},
			}),
			config,
		);
		expect(result.total).toBe(1);
	});

	it("重視 signal を保有すると充足率が上がる（emphasis・AI 非再実行）", () => {
		const job = jobWith({
			benefitsCoverage: {
				kind: "coverage",
				present: 1,
				total: 20,
				signals: ["completeTwoDayWeekoff"],
			},
		});
		const base = scoreJob(job, config).total;
		const emphasized = scoreJob(job, {
			items: {
				benefitsCoverage: {
					weight: 1,
					kind: "coverage",
					emphasis: ["completeTwoDayWeekoff"],
				},
			},
		}).total;
		expect(base).not.toBeNull();
		expect(emphasized).not.toBeNull();
		expect(emphasized as number).toBeGreaterThan(base as number);
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
