import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "../../shared/job-schema";
import {
	collectBenefitSections,
	DEFAULT_MAIN_MAX_CHARS,
	mergeBenefitFields,
	prepareExtractionContent,
} from "./content-extract";

// 福利厚生/休暇セクションを見出し＋直後の箇条書きごと拾い、無関係行は捨てる（決定的）。
describe("collectBenefitSections", () => {
	it("福利厚生見出しと直後のリストを保持し、無関係行は除外する", () => {
		const text = [
			"職種: バックエンドエンジニア",
			"会社概要: 受託開発",
			"福利厚生",
			"・社会保険完備",
			"・退職金制度",
			"応募方法: フォームから",
		].join("\n");
		const collected = collectBenefitSections(text);
		expect(collected).toContain("福利厚生");
		expect(collected).toContain("社会保険完備");
		expect(collected).toContain("退職金制度");
		// 見出し前の無関係行は含めない
		expect(collected).not.toContain("会社概要");
	});

	it("休日・年間休日セクションも拾う", () => {
		const text = ["年間休日125日", "完全週休2日制"].join("\n");
		expect(collectBenefitSections(text)).toContain("年間休日125日");
	});

	it("福利厚生に該当する記載が無ければ空文字", () => {
		const text = ["職種: エンジニア", "勤務地: 東京"].join("\n");
		expect(collectBenefitSections(text)).toBe("");
	});
});

// 予算内は全文・1 パス、予算超過はセクション保持つき切り詰め＋分割パス推奨。
describe("prepareExtractionContent", () => {
	it("予算内は全文を main にし split=false（golden 入力を変えない）", () => {
		const html =
			"<html><body><p>年収 700万</p><p>福利厚生 社会保険</p></body></html>";
		const prepared = prepareExtractionContent(html);
		expect(prepared.split).toBe(false);
		expect(prepared.main).toContain("年収 700万");
		expect(prepared.main).toContain("福利厚生");
	});

	it("予算超過かつ福利厚生ありは main を切り詰め、benefits を集約し split=true", () => {
		const filler = "業務内容の説明。".repeat(80);
		const html = `<html><body><p>${filler}</p><p>福利厚生</p><p>社会保険完備</p><p>退職金制度</p></body></html>`;
		const prepared = prepareExtractionContent(html, { maxChars: 50 });
		expect(prepared.split).toBe(true);
		expect(prepared.main.length).toBeLessThanOrEqual(50);
		expect(prepared.benefits).toContain("社会保険完備");
	});

	it("予算超過でも福利厚生が無ければ split=false（切り詰めのみ）", () => {
		const filler = "業務内容。".repeat(80);
		const html = `<html><body><p>${filler}</p></body></html>`;
		const prepared = prepareExtractionContent(html, { maxChars: 50 });
		expect(prepared.split).toBe(false);
		expect(prepared.main.length).toBeLessThanOrEqual(50);
	});

	it("同一入力は常に同一結果（決定的）", () => {
		const html = "<html><body><p>福利厚生 社会保険</p></body></html>";
		expect(prepareExtractionContent(html)).toEqual(
			prepareExtractionContent(html),
		);
	});

	it("既定の文字予算を公開する", () => {
		expect(DEFAULT_MAIN_MAX_CHARS).toBeGreaterThan(0);
	});
});

// 分割パス統合: benefits パスが取れたキーは benefits を優先、取れなければ主パスを残す。
describe("mergeBenefitFields", () => {
	const numeric = (
		min: number,
		max: number,
	): NormalizedJob["annualSalary"] => ({
		kind: "numericRange",
		min,
		max,
		raw: `${min}`,
	});

	it("benefits パスが福利厚生/年間休日を取れたら主パスより優先する", () => {
		const mainJob = {
			...allUnknown(),
			annualSalary: numeric(700, 900),
		} as NormalizedJob;
		const benefitsJob = {
			...allUnknown(),
			annualHolidays: numeric(125, 125),
			benefitsCoverage: {
				kind: "coverage" as const,
				present: 2,
				total: 5,
				signals: ["insurance", "retirement"],
				raw: "社会保険 退職金",
			},
		} as NormalizedJob;

		const merged = mergeBenefitFields(mainJob, benefitsJob);
		// 主パス固有の値は維持
		expect(merged.annualSalary).toEqual(numeric(700, 900));
		// benefits パスの値で上書き
		expect(merged.annualHolidays).toEqual(numeric(125, 125));
		expect(merged.benefitsCoverage.kind).toBe("coverage");
	});

	it("benefits パスが unknown のキーは主パスを残す", () => {
		const mainJob = {
			...allUnknown(),
			annualHolidays: numeric(120, 120),
		} as NormalizedJob;
		const benefitsJob = allUnknown();

		const merged = mergeBenefitFields(mainJob, benefitsJob);
		expect(merged.annualHolidays).toEqual(numeric(120, 120));
	});
});

// 全キー unknown の NormalizedJob を作るテストヘルパ。
function allUnknown(): NormalizedJob {
	return {
		annualSalary: { kind: "unknown" },
		bonus: { kind: "unknown" },
		overtime: { kind: "unknown" },
		annualHolidays: { kind: "unknown" },
		benefitsCoverage: { kind: "unknown" },
		remoteWork: { kind: "unknown" },
		flexWork: { kind: "unknown" },
		skillMatch: { kind: "unknown" },
		companySize: { kind: "unknown" },
		capital: { kind: "unknown" },
	};
}
