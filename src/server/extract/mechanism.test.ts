import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL } from "./extract";
import { DEFAULT_MECHANISM, resolveExtractionMechanism } from "./mechanism";

// 機構解決はカタログ（EXTRACTION_MODEL_CANDIDATES）を単一ソースにする（モデル直書きを避ける）。
describe("resolveExtractionMechanism", () => {
	it("カタログの FC モデルは function-calling を返す（gpt-oss 系のみ・#146）", () => {
		// #146 で広 context モデルは json-mode へ再割当。FC のままなのは json-mode 非遵守の gpt-oss 系（→#147）。
		expect(resolveExtractionMechanism("@cf/openai/gpt-oss-120b")).toBe(
			"function-calling",
		);
		expect(resolveExtractionMechanism("@cf/openai/gpt-oss-20b")).toBe(
			"function-calling",
		);
	});

	it("カタログの JSON Mode モデルは json-mode を返す", () => {
		expect(
			resolveExtractionMechanism("@cf/meta/llama-3.1-8b-instruct-fast"),
		).toBe("json-mode");
	});

	// #146 live 実証: FC は CF の当該モデルで非成立（3043/8006/504）、json-mode は ai.run 成功し
	// #145 parser で OpenAI choices 形も回収できる。よって広 context 候補は json-mode へ再割当する。
	it("再割当した広 context 候補は json-mode を返す（#146）", () => {
		for (const id of [
			"@cf/mistralai/mistral-small-3.1-24b-instruct",
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			"@cf/qwen/qwen3-30b-a3b-fp8",
			"@cf/google/gemma-4-26b-a4b-it",
			"@cf/zai-org/glm-4.7-flash",
		]) {
			expect(resolveExtractionMechanism(id)).toBe("json-mode");
		}
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
