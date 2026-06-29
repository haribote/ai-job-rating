import { describe, expect, it } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import {
	CRITERION_META,
	type CriteriaConfigItem,
	formRowToInput,
	itemToFormRow,
} from "./criteria";

// criteria.ts は「GET 契約 item ↔ フォーム状態 ↔ PUT 入力」の決定的変換を担う純関数群。
// ここを単体で固定し、CriteriaForm（DOM 結合）の検証から変換ロジックを切り離す。

describe("CRITERION_META", () => {
	it("全正規キーを網羅する（フォーム描画の単一ソース）", () => {
		for (const key of NORMALIZED_KEYS) {
			expect(CRITERION_META[key]).toBeDefined();
		}
	});

	it("kind が GET 契約の算出方式と整合する", () => {
		// numericRange は方向に応じた bound キー（floor/ceil）を必ず持つ（PUT 構築に必須）。
		expect(CRITERION_META.annualSalary.kind).toBe("numericRange");
		if (CRITERION_META.annualSalary.kind === "numericRange") {
			expect(CRITERION_META.annualSalary.boundKey).toBe("floor");
		}
		expect(CRITERION_META.overtime.kind).toBe("numericRange");
		if (CRITERION_META.overtime.kind === "numericRange") {
			// 残業は低いほど良い → 反対端は上限（ceil）。
			expect(CRITERION_META.overtime.boundKey).toBe("ceil");
		}
		expect(CRITERION_META.remoteWork.kind).toBe("categorical");
		expect(CRITERION_META.skillMatch.kind).toBe("keywordMatch");
		expect(CRITERION_META.benefitsCoverage.kind).toBe("coverage");
	});
});

describe("itemToFormRow", () => {
	it("numericRange の desired/floor を編集用の文字列へ展開する", () => {
		const item: CriteriaConfigItem = {
			criterion: "annualSalary",
			kind: "numericRange",
			weight: 3,
			hardFilter: "none",
			desired: { desired: 700, floor: 300 },
		};
		const row = itemToFormRow(item);
		expect(row.kind).toBe("numericRange");
		if (row.kind !== "numericRange") return;
		expect(row.weight).toBe("3");
		expect(row.desired).toBe("700");
		expect(row.bound).toBe("300");
		expect(row.boundKey).toBe("floor");
	});

	it("lowerBetter は反対端を ceil として取り込む", () => {
		const item: CriteriaConfigItem = {
			criterion: "overtime",
			kind: "numericRange",
			weight: 1,
			hardFilter: "none",
			desired: { desired: 10, ceil: 45 },
		};
		const row = itemToFormRow(item);
		if (row.kind !== "numericRange") throw new Error("kind");
		expect(row.desired).toBe("10");
		expect(row.bound).toBe("45");
		expect(row.boundKey).toBe("ceil");
	});

	it("categorical の preferred を集合として取り込む", () => {
		const item: CriteriaConfigItem = {
			criterion: "remoteWork",
			kind: "categorical",
			weight: 1,
			hardFilter: "none",
			desired: { preferred: ["full", "partial"] },
		};
		const row = itemToFormRow(item);
		if (row.kind !== "categorical") throw new Error("kind");
		expect(row.preferred).toEqual(["full", "partial"]);
	});

	it("keywordMatch の keywords をカンマ区切り文字列へ展開する", () => {
		const item: CriteriaConfigItem = {
			criterion: "skillMatch",
			kind: "keywordMatch",
			weight: 1,
			hardFilter: "none",
			desired: { keywords: ["go", "typescript"] },
		};
		const row = itemToFormRow(item);
		if (row.kind !== "keywordMatch") throw new Error("kind");
		expect(row.keywords).toBe("go, typescript");
	});

	it("desired が null の項目は空欄で初期化する（unknown 中立）", () => {
		const item: CriteriaConfigItem = {
			criterion: "benefitsCoverage",
			kind: "coverage",
			weight: 1,
			hardFilter: "none",
			desired: null,
		};
		const row = itemToFormRow(item);
		if (row.kind !== "coverage") throw new Error("kind");
		expect(row.emphasis).toBe("");
	});
});

describe("formRowToInput", () => {
	it("numericRange は boundKey に従って floor を詰める", () => {
		const input = formRowToInput({
			criterion: "annualSalary",
			kind: "numericRange",
			weight: "5",
			hardFilter: "required",
			desired: "700",
			bound: "300",
			boundKey: "floor",
		});
		expect(input).toEqual({
			criterion: "annualSalary",
			weight: 5,
			hardFilter: "required",
			desired: { desired: 700, floor: 300 },
		});
	});

	it("numericRange は desired 未入力なら希望値なし（中立）にする", () => {
		const input = formRowToInput({
			criterion: "annualSalary",
			kind: "numericRange",
			weight: "1",
			hardFilter: "none",
			desired: "",
			bound: "300",
			boundKey: "floor",
		});
		expect(input.desired).toBeUndefined();
	});

	it("categorical は選択集合を preferred として詰める。空なら中立", () => {
		expect(
			formRowToInput({
				criterion: "remoteWork",
				kind: "categorical",
				weight: "1",
				hardFilter: "none",
				preferred: ["full"],
			}).desired,
		).toEqual({ preferred: ["full"] });
		expect(
			formRowToInput({
				criterion: "remoteWork",
				kind: "categorical",
				weight: "1",
				hardFilter: "none",
				preferred: [],
			}).desired,
		).toBeUndefined();
	});

	it("keywordMatch はカンマ/空白区切りを正規化して keywords にする", () => {
		expect(
			formRowToInput({
				criterion: "skillMatch",
				kind: "keywordMatch",
				weight: "2",
				hardFilter: "none",
				keywords: "go,  typescript ,go",
			}).desired,
		).toEqual({ keywords: ["go", "typescript"] });
	});

	it("coverage は重視 signal 集合を emphasis として詰める", () => {
		expect(
			formRowToInput({
				criterion: "benefitsCoverage",
				kind: "coverage",
				weight: "1",
				hardFilter: "none",
				emphasis: "retirementAllowance, childcareLeave",
			}).desired,
		).toEqual({ emphasis: ["retirementAllowance", "childcareLeave"] });
	});
});
