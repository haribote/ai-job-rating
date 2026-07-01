import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Bindings } from "./app";

// サイトアクセス制限（#183）。オーナー単一テナントを Basic 認証で守り、SPA(HTML) も /api/* も一括で保護する。
// 全経路保護には wrangler.jsonc の assets.run_worker_first=true（全リクエストを Worker 経由）が前提（#185）。
//
// 設計（フォーク容易性 §8）:
// - 認証情報はコードに直書きせず AUTH_USER/AUTH_PASS（wrangler secret / .dev.vars）で注入する。
// - fail-open: 両方揃うときのみ認証を有効化し、欠けたら素通り＋警告する。これで dev・e2e（secret 無し）は
//   従来どおり通り、本番だけ secret 設定で保護できる（未設定＝無防備は warn で可視化する）。
// - warned は factory の closure に閉じるため、app が 1 度だけ生成する middleware では isolate 単位で 1 回だけ
//   警告し、テストは createAuthMiddleware() ごとに独立した状態を得る（グローバル状態を持たない）。
export function createAuthMiddleware(): MiddlewareHandler<{
	Bindings: Bindings;
}> {
	let warned = false;
	return (c, next) => {
		const user = c.env.AUTH_USER;
		const pass = c.env.AUTH_PASS;
		if (!user || !pass) {
			if (!warned) {
				warned = true;
				console.warn(
					"[auth] AUTH_USER/AUTH_PASS 未設定: 認証なしで公開中。本番は wrangler secret で設定してください。",
				);
			}
			return next();
		}
		return basicAuth({ username: user, password: pass })(c, next);
	};
}
