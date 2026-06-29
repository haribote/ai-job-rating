// 企業評判機能（#30 の Claude API web_search 以降）の前提となる ANTHROPIC_API_KEY の構成状態。
//
// なぜこのモジュールが存在するか:
// - 評判検索（#30）は ANTHROPIC_API_KEY を必要とする。設定 UI（#31）は「キーが入っているか」だけを
//   出し分けたいので、env → presence の判定を決定的な純関数に切り出してユニットテストで担保する（§8）。
// - 返すのは presence の boolean のみ。キー値そのものはクライアントへ晒さない（秘匿・フォーク容易性 §8）。
//   実値は wrangler secret / .dev.vars 経由で注入し、コードには直書きしない。

// 評判 API キーの構成状態を表す JSON 契約（GET /api/reputation/config の応答）。
// キー値は含めない（presence のみ）。
export interface ReputationApiKeyConfig {
	readonly apiKeyConfigured: boolean;
}

// env の ANTHROPIC_API_KEY から presence を判定する純関数（決定的）。
// 未設定・空文字・空白のみは「未構成」として扱う（注入し忘れと同義）。値そのものは返さない。
export function resolveReputationApiKeyConfig(
	apiKey: string | undefined,
): ReputationApiKeyConfig {
	const apiKeyConfigured =
		typeof apiKey === "string" && apiKey.trim().length > 0;
	return { apiKeyConfigured };
}
