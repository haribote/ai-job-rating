import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL } from "./extract";
import { DEFAULT_MECHANISM, resolveExtractionMechanism } from "./mechanism";

// 機構解決はカタログ（EXTRACTION_MODEL_CANDIDATES）を単一ソースにする（モデル直書きを避ける）。
describe("resolveExtractionMechanism", () => {
	it("カタログの FC モデルは function-calling を返す", () => {
		expect(resolveExtractionMechanism("@cf/google/gemma-4-26b-a4b-it")).toBe(
			"function-calling",
		);
		expect(resolveExtractionMechanism("@cf/openai/gpt-oss-120b")).toBe(
			"function-calling",
		);
	});

	it("カタログの JSON Mode モデルは json-mode を返す", () => {
		expect(
			resolveExtractionMechanism("@cf/meta/llama-3.1-8b-instruct-fast"),
		).toBe("json-mode");
	});

	it("カタログ未掲載（incumbent / フォーク先の独自モデル）は既定 json-mode へ寄せる", () => {
		// incumbent はカタログに含めない設計（model-eval.ts の baseline）。既定で json-mode になる。
		expect(resolveExtractionMechanism(EXTRACTION_MODEL)).toBe("json-mode");
		expect(resolveExtractionMechanism("@cf/forked/unknown-model")).toBe(
			DEFAULT_MECHANISM,
		);
		expect(DEFAULT_MECHANISM).toBe("json-mode");
	});
});
