// vitest-pool-workers の `cloudflare:test` モジュールが返す env をアプリの Bindings 型に揃える
declare module "cloudflare:test" {
	import type { Bindings } from "./server/app";

	interface ProvidedEnv extends Bindings {}
}

// cloudflare:test の env（= Cloudflare.Env）にテスト専用バインディングを追記する。
// pool は `export const env: Cloudflare.Env` を返すため、TEST_MIGRATIONS は ProvidedEnv ではなく
// Cloudflare.Env を拡張して可視化する。vitest.config.ts が readD1Migrations の結果を注入し、
// 各テストが applyD1Migrations(env.DB, env.TEST_MIGRATIONS) で本番スキーマを適用する。
declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
