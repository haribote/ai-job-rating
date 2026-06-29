import { describe, expect, it } from "vitest";
import { resolveReputationApiKeyConfig } from "./api-key";

// 評判 API キーの presence 判定（#31）。決定的な純関数なのでユニットテストで担保する。
describe("resolveReputationApiKeyConfig", () => {
	// 未注入（wrangler secret / .dev.vars 未設定）は未構成として扱う。
	it("未設定（undefined）は apiKeyConfigured=false", () => {
		expect(resolveReputationApiKeyConfig(undefined)).toEqual({
			apiKeyConfigured: false,
		});
	});

	// 空文字・空白のみは「設定し忘れ」と同義なので未構成に倒す。
	it("空文字・空白のみは apiKeyConfigured=false", () => {
		expect(resolveReputationApiKeyConfig("").apiKeyConfigured).toBe(false);
		expect(resolveReputationApiKeyConfig("   ").apiKeyConfigured).toBe(false);
	});

	// 非空の値があれば構成済み。値そのものは契約に含めない（秘匿）。
	it("非空の値は apiKeyConfigured=true で、キー値を漏らさない", () => {
		const config = resolveReputationApiKeyConfig("sk-ant-secret");
		expect(config).toEqual({ apiKeyConfigured: true });
		expect(JSON.stringify(config)).not.toContain("sk-ant-secret");
	});
});
