import { describe, expect, it } from "vitest";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	CATEGORY_OF,
	categoryOf,
	KEYS_BY_CATEGORY,
} from "./categories";
import { NORMALIZED_KEYS } from "./job-schema";

// 5軸 ↔ 項目の対応は後続 UI/評判が一貫消費する単一ソース（#101）。網羅・無矛盾を型＋テストで担保する。
describe("5軸カテゴリ", () => {
	it("5軸ちょうど（compensation/integrity/flexibility/role/company）", () => {
		expect(CATEGORY_KEYS).toEqual([
			"compensation",
			"integrity",
			"flexibility",
			"role",
			"company",
		]);
	});

	it("全正規キーが必ず 1 軸に属する（CATEGORY_OF が NORMALIZED_KEYS を網羅）", () => {
		for (const key of NORMALIZED_KEYS) {
			expect(CATEGORY_OF[key]).toBeDefined();
			expect(CATEGORY_KEYS).toContain(CATEGORY_OF[key]);
		}
	});

	it("CATEGORY_OF は正規キー以外を含まない", () => {
		for (const key of Object.keys(CATEGORY_OF)) {
			expect(NORMALIZED_KEYS).toContain(key);
		}
	});

	it("KEYS_BY_CATEGORY は CATEGORY_OF の逆引きと一致し、全項目を重複なく覆う", () => {
		const flattened = CATEGORY_KEYS.flatMap((c) => KEYS_BY_CATEGORY[c]);
		expect([...flattened].sort()).toEqual([...NORMALIZED_KEYS].sort());
		for (const c of CATEGORY_KEYS) {
			for (const key of KEYS_BY_CATEGORY[c]) {
				expect(CATEGORY_OF[key]).toBe(c);
			}
		}
	});

	it("各軸に表示名がある（integrity は内部キー固定・表示名は差し替え可能な構造）", () => {
		for (const c of CATEGORY_KEYS) {
			expect(CATEGORY_LABELS[c].length).toBeGreaterThan(0);
		}
	});

	it("categoryOf は CATEGORY_OF と一致する（決定的）", () => {
		for (const key of NORMALIZED_KEYS) {
			expect(categoryOf(key)).toBe(CATEGORY_OF[key]);
		}
	});

	it("5軸の代表項目が正しい軸に属する（設計書 §5.1）", () => {
		expect(CATEGORY_OF.annualSalary).toBe("compensation");
		expect(CATEGORY_OF.overtime).toBe("integrity");
		expect(CATEGORY_OF.benefitsCoverage).toBe("integrity");
		expect(CATEGORY_OF.remoteWork).toBe("flexibility");
		expect(CATEGORY_OF.skillMatch).toBe("role");
		expect(CATEGORY_OF.capital).toBe("company");
	});
});

// レーダー軸ラベルの番号化（#203）。番号→カテゴリ名は凡例が単一ソースの CATEGORY_LABELS を参照する。
describe("CATEGORY_AXIS_NUMBERS（軸の番号割り当て・決定的）", () => {
	it("CATEGORY_KEYS の順序どおり 1 始まりで過不足なく割り当てる", () => {
		CATEGORY_KEYS.forEach((key, index) => {
			expect(CATEGORY_AXIS_NUMBERS[key]).toBe(index + 1);
		});
		expect(Object.keys(CATEGORY_AXIS_NUMBERS).sort()).toEqual(
			[...CATEGORY_KEYS].sort(),
		);
	});

	it("番号は 1..5 の範囲で重複しない", () => {
		const numbers = CATEGORY_KEYS.map((key) => CATEGORY_AXIS_NUMBERS[key]);
		expect(new Set(numbers).size).toBe(CATEGORY_KEYS.length);
		for (const n of numbers) {
			expect(n).toBeGreaterThanOrEqual(1);
			expect(n).toBeLessThanOrEqual(CATEGORY_KEYS.length);
		}
	});
});
