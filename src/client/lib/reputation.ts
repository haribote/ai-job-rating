// 企業評判（Phase 2・#30 以降）のクライアント契約。設定 UI（#31）が消費する。
//
// なぜ存在するか:
// - GET /api/reputation/config の応答（presence のみ）を型と取得関数に閉じ、設定節（ReputationApiKeySection）
//   から fetch 細部を切り離して単体テスト可能にする（criteria.ts の流儀に倣う・§9）。
// - サーバは別バンドルのため型は client 側で定義する（criteria.ts と同方針）。
// - キー値そのものは契約に含めない（presence の boolean だけ）。秘匿はサーバ側の責務（§8）。

import type { ApiClient } from "./api";
import { apiGet } from "./api";

// GET /api/reputation/config の応答。評判検索（#30）の前提キーが注入済みかだけを表す。
export interface ReputationApiKeyConfig {
	readonly apiKeyConfigured: boolean;
}

// 評判 API キーの構成状態を取得する。get は注入可能（テストはフェイク、本番は global fetch）。
export async function fetchReputationApiKeyConfig(
	get: ApiClient["get"] = apiGet,
): Promise<ReputationApiKeyConfig> {
	return get<ReputationApiKeyConfig>("/reputation/config");
}
