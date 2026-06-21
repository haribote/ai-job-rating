// vitest-pool-workers の `cloudflare:test` モジュールが返す env をアプリの Bindings 型に揃える
declare module "cloudflare:test" {
	import type { Bindings } from "./app";

	interface ProvidedEnv extends Bindings {}
}
