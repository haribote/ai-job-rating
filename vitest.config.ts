import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workers ランタイム上でテストを走らせ、本番と同じ assets バインディング等を再現する
// vitest 4 / pool-workers 0.16 では defineWorkersConfig は廃止され、cloudflareTest プラグインで構成する
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			// AI binding は local simulator を持たず remote proxy に credentials を要するため、
			// テストでは remote bindings を無効化しオフライン・決定的に保つ。実推論は AiRunner を fake する。
			remoteBindings: false,
		}),
	],
});
