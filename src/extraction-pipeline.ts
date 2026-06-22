import type { AiRunner } from "./ai";
import { extractJob } from "./extract";
import { renderResultPage } from "./result-display";
import { DEFAULT_SCORING_CONFIG, scoreJob } from "./score";
import { trimHtml } from "./trim-html";

// 抽出パイプラインの共有コア（trim #9 → 抽出 #11 → スコア #12 → 表示 #13）。
// 貼付経路（paste-input）と URL 経路（url-input）で共用し重複を避ける。
// 1 リクエスト 1 抽出・表示で再実行しない（§5.3 の抽出↔スコアリング分離を維持）。
export async function runExtractionPipeline(
	ai: AiRunner,
	html: string,
): Promise<string> {
	const body = trimHtml(html);
	const { job } = await extractJob(ai, body);
	const score = scoreJob(job, DEFAULT_SCORING_CONFIG);
	return renderResultPage(score, job);
}
