import { describe, expect, it } from "vitest";
import { companyKey, normalizeCompanyName } from "./normalize";

describe("normalizeCompanyName（表示用の決定的正規化）", () => {
	it("全角英数記号を半角へ寄せ前後空白を落とす（NFKC）", () => {
		expect(normalizeCompanyName("　Ｇｏｏｇｌｅ　")).toBe("Google");
	});

	it("㈱ は NFKC で (株) へ展開する（法人種別語は表示用には残す）", () => {
		expect(normalizeCompanyName("㈱メルカリ")).toBe("(株)メルカリ");
	});
});

describe("companyKey（名寄せキーの決定的生成）", () => {
	// なぜ: 同一企業が前株/後株/(株)/㈱/全角括弧で多様表記されても 1 キーへ収束させる。
	it("法人種別語の位置・表記が違っても同一キーになる", () => {
		const expected = companyKey("サイバーエージェント");
		for (const variant of [
			"株式会社サイバーエージェント",
			"サイバーエージェント株式会社",
			"(株)サイバーエージェント",
			"㈱サイバーエージェント",
			"（株）サイバーエージェント",
			"株式会社　サイバーエージェント",
		]) {
			expect(companyKey(variant)).toBe(expected);
		}
	});

	it("英字大小と全角半角を吸収する", () => {
		expect(companyKey("Ｇｏｏｇｌｅ")).toBe(companyKey("google"));
		expect(companyKey("GOOGLE")).toBe(companyKey("Google"));
	});

	it("前後・中間の空白を無視する", () => {
		expect(companyKey("  メルカリ  ")).toBe(companyKey("メルカリ"));
		expect(companyKey("日本 電気")).toBe(companyKey("日本電気"));
	});

	it("有限会社・(有)・㈲ を同一視する", () => {
		const expected = companyKey("山田商店");
		for (const variant of ["有限会社山田商店", "山田商店(有)", "㈲山田商店"]) {
			expect(companyKey(variant)).toBe(expected);
		}
	});

	it("中黒は除去して名寄せする", () => {
		expect(companyKey("ジョンソン・エンド・ジョンソン")).toBe(
			companyKey("ジョンソンエンドジョンソン"),
		);
	});

	// なぜ: 長音符はカタカナ社名の弁別に必須。除去すると別社へ誤併合する。
	it("長音符は保持する（過剰併合を防ぐ）", () => {
		expect(companyKey("サーバーワークス")).not.toBe(companyKey("サバワクス"));
	});

	it("同一入力は常に同一キー（決定的）", () => {
		expect(companyKey("株式会社テスト")).toBe(companyKey("株式会社テスト"));
	});

	it("法人種別語のみでも空キーにならず決定的にフォールバックする", () => {
		expect(companyKey("株式会社")).not.toBe("");
		expect(companyKey("株式会社")).toBe(companyKey("株式会社"));
	});
});
