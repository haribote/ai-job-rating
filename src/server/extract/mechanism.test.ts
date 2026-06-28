import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL } from "./extract";
import {
	DEFAULT_MECHANISM,
	resolveExtractionMaxTokens,
	resolveExtractionMechanism,
} from "./mechanism";
import { EXTRACTION_MODEL_CANDIDATES } from "./model-eval";

// 機構解決はカタログ（EXTRACTION_MODEL_CANDIDATES）を単一ソースにする（モデル直書きを避ける）。
describe("resolveExtractionMechanism", () => {
	// #147 時点で CF の候補はいずれも json-mode が実成立（FC は 3043/8006/504 で非成立）。
	// function-calling は機構として残すが、現状どの候補にも割当てず options.mechanism 上書きでのみ使う。
	it("現行カタログ候補はいずれも json-mode を返す（#146/#147）", () => {
		for (const c of EXTRACTION_MODEL_CANDIDATES) {
			expect(resolveExtractionMechanism(c.id)).toBe("json-mode");
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

// #147 live 実証: gpt-oss は reasoning に budget を食い、既定 max_tokens では content 生成前に
// finish_reason:length で切れる（content=null）。十分な max_tokens を与えると完全な JSON を返す。
// 一方 mistral 等は高 max_tokens で退化したタブ列を吐き 504 になるため、上限はモデル別に持つ。
describe("resolveExtractionMaxTokens", () => {
	it("gpt-oss 系は reasoning 分の max_tokens を返す（#147）", () => {
		expect(resolveExtractionMaxTokens("@cf/openai/gpt-oss-120b")).toBe(16384);
		expect(resolveExtractionMaxTokens("@cf/openai/gpt-oss-20b")).toBe(16384);
	});

	it("maxTokens 未設定の候補・未掲載は undefined（モデル既定に委ねる）", () => {
		expect(
			resolveExtractionMaxTokens("@cf/qwen/qwen3-30b-a3b-fp8"),
		).toBeUndefined();
		expect(
			resolveExtractionMaxTokens("@cf/forked/unknown-model"),
		).toBeUndefined();
	});
});
