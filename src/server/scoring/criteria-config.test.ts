import { describe, expect, it } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { CriteriaConfigRow } from "../storage/db-schema";
import {
	buildDesiredSkills,
	buildHardFilterMap,
	buildScoringConfig,
	criteriaRowToItemConfig,
	NORMALIZED_KEY_KINDS,
} from "./criteria-config";

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

	it("categorical の desired_value(JSON) を preferred 集合へ展開する", () => {
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
		});
	});

	it("aiJudged は希望値を持たず weight だけを取り込む（#68 拡張点）", () => {
		const item = criteriaRowToItemConfig(
			row({ criterion: "requiredSkillsMatch", weight: 4, desired_value: null }),
		);
		expect(item).toEqual({ weight: 4, kind: "aiJudged" });
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

describe("buildDesiredSkills（aiJudged の希望スキル集合・#68 拡張点）", () => {
	it("aiJudged 行の desired_value({skills}) を正規キーごとの希望集合へ展開する", () => {
		const map = buildDesiredSkills([
			row({
				criterion: "requiredSkillsMatch",
				desired_value: JSON.stringify({ skills: ["go", "ts"] }),
			}),
			row({
				criterion: "preferredSkillsMatch",
				desired_value: JSON.stringify({ skills: ["rust"] }),
			}),
		]);
		expect(map).toEqual({
			requiredSkillsMatch: ["go", "ts"],
			preferredSkillsMatch: ["rust"],
		});
	});

	it("aiJudged でないキー・壊れた JSON・skills 不在の行は希望集合を持たない", () => {
		const map = buildDesiredSkills([
			// categorical キーは aiJudged ではないので無視
			row({
				criterion: "remoteWork",
				desired_value: JSON.stringify({ skills: ["x"] }),
			}),
			// 壊れた JSON
			row({ criterion: "requiredSkillsMatch", desired_value: "{broken" }),
			// skills 不在
			row({
				criterion: "preferredSkillsMatch",
				desired_value: JSON.stringify({ preferred: ["x"] }),
			}),
		]);
		expect(map).toEqual({});
	});

	it("skills が空配列の行は空集合として持つ（required の意味差を保つ）", () => {
		// required は希望空でも「必須未充足=0.0」を出すため、空集合と未設定を区別する。
		const map = buildDesiredSkills([
			row({
				criterion: "requiredSkillsMatch",
				desired_value: JSON.stringify({ skills: [] }),
			}),
		]);
		expect(map).toEqual({ requiredSkillsMatch: [] });
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
