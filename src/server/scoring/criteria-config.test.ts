import { describe, expect, it } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { CriteriaConfigRow } from "../storage/db-schema";
import {
	buildHardFilterMap,
	buildScoringConfig,
	criteriaRowToItemConfig,
	NORMALIZED_KEY_KINDS,
} from "./criteria-config";
import { REMOTE_WORK_TIER_SCORES } from "./score";

// criteria_config 行を組み立てるヘルパ（既定値を埋める）。
function row(over: Partial<CriteriaConfigRow>): CriteriaConfigRow {
	return {
		criterion: "annualSalary",
		desired_value: null,
		weight: 1,
		hard_filter: "none",
		updated_at: 0,
		...over,
	};
}

describe("NORMALIZED_KEY_KINDS（kind レジストリ）", () => {
	it("全正規キーを網羅する（単一ソース）", () => {
		for (const key of NORMALIZED_KEYS) {
			expect(NORMALIZED_KEY_KINDS[key]).toBeDefined();
		}
	});

	it("numericRange キーは direction を必ず持つ", () => {
		for (const k of Object.values(NORMALIZED_KEY_KINDS)) {
			if (k.kind === "numericRange") {
				expect(["higherBetter", "lowerBetter"]).toContain(k.direction);
			}
		}
	});
});

describe("criteriaRowToItemConfig（1 行 → 項目設定）", () => {
	it("numericRange の desired_value(JSON) を desired/floor へ展開する", () => {
		const item = criteriaRowToItemConfig(
			row({
				criterion: "annualSalary",
				weight: 5,
				desired_value: JSON.stringify({ desired: 700, floor: 300 }),
			}),
		);
		expect(item).toEqual({
			weight: 5,
			kind: "numericRange",
			direction: "higherBetter",
			desired: 700,
			floor: 300,
		});
	});

	it("lowerBetter の数値項目は direction をレジストリから引く", () => {
		const item = criteriaRowToItemConfig(
			row({
				criterion: "overtime",
				desired_value: JSON.stringify({ desired: 10, ceil: 45 }),
			}),
		);
		expect(item).toMatchObject({
			kind: "numericRange",
			direction: "lowerBetter",
			ceil: 45,
		});
	});

	it("categorical の desired_value(JSON) を preferred 集合へ展開する（tier 無しキー）", () => {
		// flexWork は tier 採点を持たないため preferred 集合一致率のまま（remoteWork は別テスト）。
		const item = criteriaRowToItemConfig(
			row({
				criterion: "flexWork",
				desired_value: JSON.stringify({ preferred: ["flex", "discretionary"] }),
			}),
		);
		expect(item).toEqual({
			weight: 1,
			kind: "categorical",
			preferred: ["flex", "discretionary"],
		});
	});

	it("remoteWork は tier 採点（フルリモート別格）をレジストリから注入する（#104）", () => {
		// preferred は desired_value から、tierScores は kind レジストリから注入する。
		// desired_value に tierScores を持たせない（ユーザー編集の preferred だけが round-trip する）。
		const item = criteriaRowToItemConfig(
			row({
				criterion: "remoteWork",
				desired_value: JSON.stringify({ preferred: ["full", "partial"] }),
			}),
		);
		expect(item).toEqual({
			weight: 1,
			kind: "categorical",
			preferred: ["full", "partial"],
			tierScores: REMOTE_WORK_TIER_SCORES,
		});
	});

	it("keywordMatch（skillMatch）は desired_value({keywords}) を keyword 集合へ展開する（#105）", () => {
		const item = criteriaRowToItemConfig(
			row({
				criterion: "skillMatch",
				weight: 4,
				desired_value: JSON.stringify({ keywords: ["go", "ts"] }),
			}),
		);
		expect(item).toEqual({
			weight: 4,
			kind: "keywordMatch",
			keywords: ["go", "ts"],
		});
	});

	it("keywordMatch は keyword 未設定・壊れた JSON なら空集合＝中立で weight だけ取り込む（#105）", () => {
		const missing = criteriaRowToItemConfig(
			row({ criterion: "skillMatch", weight: 4, desired_value: null }),
		);
		const broken = criteriaRowToItemConfig(
			row({ criterion: "skillMatch", weight: 4, desired_value: "{broken" }),
		);
		expect(missing).toEqual({ weight: 4, kind: "keywordMatch", keywords: [] });
		expect(broken).toEqual({ weight: 4, kind: "keywordMatch", keywords: [] });
	});

	it("coverage（benefitsCoverage）は希望値なしなら weight だけを取り込む（充足率は抽出値から算出）", () => {
		const item = criteriaRowToItemConfig(
			row({ criterion: "benefitsCoverage", weight: 2, desired_value: null }),
		);
		expect(item).toEqual({ weight: 2, kind: "coverage" });
	});

	it("coverage は emphasis（重視 signal）を取り込む（#102）", () => {
		const item = criteriaRowToItemConfig(
			row({
				criterion: "benefitsCoverage",
				weight: 2,
				desired_value: JSON.stringify({ emphasis: ["completeTwoDayWeekoff"] }),
			}),
		);
		expect(item).toEqual({
			weight: 2,
			kind: "coverage",
			emphasis: ["completeTwoDayWeekoff"],
		});
	});

	it("正規キーでない criterion（番兵 __total__ 等）は null（評価対象外）", () => {
		expect(criteriaRowToItemConfig(row({ criterion: "__total__" }))).toBeNull();
		expect(criteriaRowToItemConfig(row({ criterion: "bogus" }))).toBeNull();
	});

	it("desired_value が kind と整合しない・壊れた JSON は null（中立で除外）", () => {
		// numericRange なのに preferred 形 → null
		expect(
			criteriaRowToItemConfig(
				row({
					criterion: "annualSalary",
					desired_value: JSON.stringify({ preferred: [] }),
				}),
			),
		).toBeNull();
		// 壊れた JSON → null
		expect(
			criteriaRowToItemConfig(
				row({ criterion: "annualSalary", desired_value: "{not json" }),
			),
		).toBeNull();
	});
});

describe("buildScoringConfig（行群 → 設定）", () => {
	it("複数行を ScoringConfig.items にまとめる", () => {
		const config = buildScoringConfig([
			row({
				criterion: "annualSalary",
				weight: 5,
				desired_value: JSON.stringify({ desired: 700, floor: 300 }),
			}),
			row({
				criterion: "remoteWork",
				weight: 3,
				desired_value: JSON.stringify({ preferred: ["full"] }),
			}),
		]);
		expect(Object.keys(config.items).sort()).toEqual([
			"annualSalary",
			"remoteWork",
		]);
	});

	it("行の取得順に依存せず criterion 昇順で決定的な内訳順を作る（§8）", () => {
		const a = buildScoringConfig([
			row({
				criterion: "remoteWork",
				desired_value: JSON.stringify({ preferred: ["full"] }),
			}),
			row({
				criterion: "annualSalary",
				desired_value: JSON.stringify({ desired: 700, floor: 300 }),
			}),
		]);
		const b = buildScoringConfig([
			row({
				criterion: "annualSalary",
				desired_value: JSON.stringify({ desired: 700, floor: 300 }),
			}),
			row({
				criterion: "remoteWork",
				desired_value: JSON.stringify({ preferred: ["full"] }),
			}),
		]);
		expect(Object.keys(a.items)).toEqual(Object.keys(b.items));
	});

	it("不正行は黙って除外する（残りは採用、フォーク耐性）", () => {
		const config = buildScoringConfig([
			row({
				criterion: "annualSalary",
				desired_value: JSON.stringify({ desired: 700, floor: 300 }),
			}),
			row({ criterion: "__total__" }),
			row({ criterion: "remoteWork", desired_value: "{broken" }),
		]);
		expect(Object.keys(config.items)).toEqual(["annualSalary"]);
	});
});

describe("buildHardFilterMap（ハードフィルタ抽出）", () => {
	it("none 以外のフィルタだけを正規キーで拾う", () => {
		const map = buildHardFilterMap([
			row({ criterion: "annualSalary", hard_filter: "required" }),
			row({ criterion: "overtime", hard_filter: "none" }),
			row({ criterion: "remoteWork", hard_filter: "exclude" }),
			row({ criterion: "__total__", hard_filter: "required" }),
		]);
		expect(map).toEqual({ annualSalary: "required", remoteWork: "exclude" });
	});
});
