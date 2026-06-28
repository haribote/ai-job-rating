import { describe, expect, it } from "vitest";
import {
	isStatedUnquantified,
	isUnknown,
	isUnknownRaw,
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
	normalizeLabel,
} from "./job-schema";

// 正規キー一覧はスコアリングの単一ソース。重複なく全カテゴリを網羅する。
describe("NORMALIZED_KEYS", () => {
	it("正規キーは重複しない", () => {
		expect(new Set(NORMALIZED_KEYS).size).toBe(NORMALIZED_KEYS.length);
	});

	it("§5.1 5軸の代表キーを含む", () => {
		expect(NORMALIZED_KEYS).toContain("annualSalary");
		expect(NORMALIZED_KEYS).toContain("overtime");
		expect(NORMALIZED_KEYS).toContain("benefitsCoverage");
		expect(NORMALIZED_KEYS).toContain("remoteWork");
		expect(NORMALIZED_KEYS).toContain("skillMatch");
		expect(NORMALIZED_KEYS).toContain("capital");
	});
});

// ラベル正規化（§5.2）: サイト依存ラベルの揺れを正規キーへ寄せる。決定的であること。
describe("normalizeLabel", () => {
	it("「想定年収」「年収」は同じ正規キーへ寄る（ラベル揺れの吸収）", () => {
		expect(normalizeLabel("想定年収")).toBe("annualSalary");
		expect(normalizeLabel("年収")).toBe("annualSalary");
	});

	it("「時間外労働」「みなし残業」は overtime へ寄る", () => {
		expect(normalizeLabel("時間外労働")).toBe("overtime");
		expect(normalizeLabel("みなし残業")).toBe("overtime");
		expect(normalizeLabel("固定残業")).toBe("overtime");
	});

	it("全角・空白・装飾記号の揺れを吸収する", () => {
		// 全角コロン・前後空白・全角括弧などが付いても同じキーへ寄る
		expect(normalizeLabel("　資本金　")).toBe("capital");
		expect(normalizeLabel("給与（年収）")).toBe("annualSalary");
		// 休日・休暇は benefitsCoverage の signal として吸収する（#101）。
		expect(normalizeLabel("休日・休暇")).toBe("benefitsCoverage");
	});

	it("同一入力は常に同一正規キー（決定的）", () => {
		const a = normalizeLabel("リモートワーク");
		const b = normalizeLabel("リモートワーク");
		expect(a).toBe(b);
		expect(a).toBe("remoteWork");
	});

	it("未知ラベルは null を返す", () => {
		expect(normalizeLabel("受動喫煙防止措置")).toBeNull();
		expect(normalizeLabel("")).toBeNull();
	});

	// 技術スタック・必須/歓迎要件は skillMatch へ統合する（#101）。
	it("技術スタック・必須/歓迎要件は skillMatch へ寄る", () => {
		expect(normalizeLabel("技術スタック")).toBe("skillMatch");
		expect(normalizeLabel("必須要件")).toBe("skillMatch");
		expect(normalizeLabel("歓迎要件")).toBe("skillMatch");
	});

	it("裁量労働は flexWork に寄せない（フレックスのみ flexWork）", () => {
		expect(normalizeLabel("フレックス")).toBe("flexWork");
		expect(normalizeLabel("フレックスタイム")).toBe("flexWork");
		expect(normalizeLabel("裁量労働")).toBeNull();
		expect(normalizeLabel("裁量労働制")).toBeNull();
	});

	// 福利厚生・退職金は benefitsCoverage の signal として吸収する（#101）。
	it("福利厚生・退職金は benefitsCoverage へ寄る", () => {
		expect(normalizeLabel("福利厚生")).toBe("benefitsCoverage");
		expect(normalizeLabel("退職金制度")).toBe("benefitsCoverage");
	});

	it("削除した正規キーのラベルは寄せない（companyPhase/勤務地）", () => {
		expect(normalizeLabel("上場区分")).toBeNull();
		expect(normalizeLabel("勤務地")).toBeNull();
	});
});

// unknown 中立（§5.2）: 値が取れない項目を判定でき、スコアリングが分母から外せる。
describe("isUnknownRaw", () => {
	it("null / undefined は unknown", () => {
		expect(isUnknownRaw(null)).toBe(true);
		expect(isUnknownRaw(undefined)).toBe(true);
	});

	it("「-」「記載なし」などの未記載表記は unknown", () => {
		expect(isUnknownRaw("-")).toBe(true);
		expect(isUnknownRaw("ー")).toBe(true);
		expect(isUnknownRaw("記載なし")).toBe(true);
		expect(isUnknownRaw("  N/A  ")).toBe(true);
	});

	it("実値は unknown ではない", () => {
		expect(isUnknownRaw("700万〜")).toBe(false);
		expect(isUnknownRaw("122日")).toBe(false);
	});

	it("同一入力は常に同一判定（決定的）", () => {
		expect(isUnknownRaw("-")).toBe(isUnknownRaw("-"));
	});
});

describe("isUnknown", () => {
	it("kind が unknown の値だけ true（スコアリングの分母除外フラグ）", () => {
		const unknown: NormalizedFieldValue = { kind: "unknown" };
		const range: NormalizedFieldValue = {
			kind: "numericRange",
			min: 700,
			max: 900,
		};
		expect(isUnknown(unknown)).toBe(true);
		expect(isUnknown(range)).toBe(false);
	});
});

describe("isStatedUnquantified", () => {
	it("unknown かつ stated=true のときだけ true（overtime 減点特例）", () => {
		expect(isStatedUnquantified({ kind: "unknown", stated: true })).toBe(true);
		// 記載なし（stated 未設定）・否定（stated=false）は中立のまま。
		expect(isStatedUnquantified({ kind: "unknown" })).toBe(false);
		expect(isStatedUnquantified({ kind: "unknown", stated: false })).toBe(
			false,
		);
		// 値が読める（numericRange）なら特例ではない。
		expect(
			isStatedUnquantified({ kind: "numericRange", min: 20, max: 20 }),
		).toBe(false);
	});
});

// スキーマ表現の確認: 全正規キーを必須にし、取れない項目を unknown で埋められる。
describe("NormalizedJob", () => {
	it("取れない項目を unknown で表現した完全な求人を構築できる", () => {
		const job: NormalizedJob = Object.fromEntries(
			NORMALIZED_KEYS.map((key) => [key, { kind: "unknown" } as const]),
		) as NormalizedJob;

		// スコアリングは全キーを走査し unknown を分母から外せる
		const knownCount = NORMALIZED_KEYS.filter(
			(key) => !isUnknown(job[key]),
		).length;
		expect(knownCount).toBe(0);
	});
});
