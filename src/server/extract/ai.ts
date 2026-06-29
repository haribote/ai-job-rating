// Workers AI 疎通確認用の最小ロジック。
// 抽出本体（§7.1 JSON Mode）とは分離し、ここでは binding が呼べることだけを担保する。
// live 推論は account/secrets 依存のため、テストでは AiRunner を fake して整形・分岐を検証する。

// 疎通確認に使う既定モデル。抽出本採用（#106）と揃え gpt-oss-20b を使う。
// 抽出のデフォルトモデル選定（#11 以降）とは独立した、health 用途の固定値。
export const DEFAULT_AI_HEALTH_MODEL = "@cf/openai/gpt-oss-20b";

// env.AI の最小契約。テストで差し替えられるよう run のみに依存する（c.env.AI は構造的に適合する）。
export interface AiRunner {
	run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

// 疎通確認の結果。成功時は整形済み reply、失敗時は理由を返す判別共用体。
export type AiHealthResult =
	| { ok: true; model: string; reply: string }
	| { ok: false; model: string; error: string };

// run のレスポンスから本文を安全に取り出す。想定外形は空文字へ正規化する（落とさない）。
function extractReply(output: unknown): string {
	if (typeof output !== "object" || output === null) return "";
	const choices = (output as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return "";
	const content = (choices[0] as { message?: { content?: unknown } })?.message
		?.content;
	return typeof content === "string" ? content : "";
}

// AI binding へ最小の推論を投げ、疎通可否を判定する。
// 失敗は throw させず ok:false に畳み込み、ヘルスチェックとして安定した契約を保つ。
export async function runAiHealthCheck(ai: AiRunner): Promise<AiHealthResult> {
	try {
		const output = await ai.run(DEFAULT_AI_HEALTH_MODEL, {
			// 最小の往復で binding の到達性のみ確認する（抽出プロンプトは #11 で扱う）
			messages: [{ role: "user", content: "ping" }],
		});
		return {
			ok: true,
			model: DEFAULT_AI_HEALTH_MODEL,
			reply: extractReply(output),
		};
	} catch (cause) {
		const error = cause instanceof Error ? cause.message : String(cause);
		return { ok: false, model: DEFAULT_AI_HEALTH_MODEL, error };
	}
}
