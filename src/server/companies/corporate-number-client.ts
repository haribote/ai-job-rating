// 法人番号 名寄せクライアントを env から解決する（決定的・フォーク容易性 §8 / #32 / #117 配線）。
//
// なぜこのモジュールが存在するか:
// - createNtaCorporateNumberClient（#32）は本番未配線で、評判取得経路（manual / url_html）は常に
//   NULL クライアント（名寄せ強化なし）を直書きしていた。アプリケーションID は秘匿値のため env 経由で
//   注入し、presence による選択をここに 1 箇所へ集約してデッドコード化を防ぐ（#117 capstone）。
// - applicationId 未設定・空白は名寄せ強化を行わない NULL クライアント（中立・非ブロック §5.2）へ倒す。
//   未設定でも企業名のみで名寄せが成立し、求人処理をブロックしない。
// - live エンドポイントの応答形は 要手動検証（#116 phase exit）。本関数は env presence による client 選択
//   のみを担い、実 API 呼び出し・XML パースは houjin-bangou.ts（注入 fetch でオフライン検証済み）に委ねる。

import {
	type CorporateNumberClient,
	createNtaCorporateNumberClient,
	NULL_CORPORATE_NUMBER_CLIENT,
} from "./houjin-bangou";

// 法人番号クライアント解決に必要な env（Bindings の部分集合）。秘匿値は直書きせず env から受ける。
export interface CorporateNumberClientEnv {
	// アプリケーションID（秘匿・.dev.vars / wrangler secret 注入）。空・未設定なら NULL クライアント。
	readonly HOUJIN_BANGOU_APP_ID?: string;
	// エンドポイント base の上書き（非秘匿・wrangler.jsonc vars）。未設定は houjin-bangou の既定。
	readonly HOUJIN_BANGOU_API_BASE?: string;
}

// env から法人番号 名寄せクライアントを解決する。applicationId が無ければ中立な NULL クライアントを返す。
export function resolveCorporateNumberClient(
	env: CorporateNumberClientEnv,
): CorporateNumberClient {
	const appId = env.HOUJIN_BANGOU_APP_ID;
	if (typeof appId !== "string" || appId.trim() === "") {
		return NULL_CORPORATE_NUMBER_CLIENT;
	}
	return createNtaCorporateNumberClient({
		applicationId: appId.trim(),
		baseUrl: env.HOUJIN_BANGOU_API_BASE,
	});
}
