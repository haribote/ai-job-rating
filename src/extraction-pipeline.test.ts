import { describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import { runExtractionPipeline } from "./extraction-pipeline";

// 抽出パイプライン（trim → 抽出 → スコア → 表示）の共有コア。貼付経路と URL 経路で共用する。
describe("runExtractionPipeline", () => {
	// 本文を最小経路に通し、結果ページ HTML（スコア＋内訳）を返す
	it("HTML をスコア結果ページ HTML へ変換する", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: { annualSalary: "700万〜900万" } }),
		};

		const html = await runExtractionPipeline(
			fakeAi,
			"<p>年収 700万〜900万</p>",
		);

		expect(html).toContain("スコア結果");
		expect(html).toContain("年収");
		expect(html).toContain("700万〜900万");
	});
});
