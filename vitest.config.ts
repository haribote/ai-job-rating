import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// shadcn 規約のパスエイリアス（vite.config.ts / tsconfig.client.json と一致）。
// client プロジェクトの jsdom テストが @/components・@/lib を解決できるようにする。
const clientAlias = {
	"@": resolve(dirname(fileURLToPath(import.meta.url)), "src/client"),
};

// 本番マイグレーション（migrations/）を config ロード時に一度だけ読み、テストワーカーへ
// TEST_MIGRATIONS バインディングとして渡す。各テストは applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
// で本番と同一スキーマを適用する。miniflare がテストファイルごとに独立した in-memory D1（DB）を与える。
const migrations = await readD1Migrations("./migrations");

// 2 プロジェクト構成（vitest 4 の test.projects）:
// - server: Workers ランタイム（@cloudflare/vitest-pool-workers）。本番と同じ assets/D1 バインディングを再現する。
// - client: jsdom + @testing-library/react。React SPA（src/client）の DOM レンダリングを検証する。
// pool-workers は custom environment（jsdom 等）を許さないため、両者をプロジェクトとして分離する。
// 振り分け基準は配置: src/client/** は client、それ以外（src/server・src/shared・ルート）は server。
// e2e/ は Playwright 専用（実ブラウザ）のため両プロジェクトから除外する。
export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						main: "./src/server/index.ts",
						wrangler: { configPath: "./wrangler.jsonc" },
						// AI binding は local simulator を持たず remote proxy に credentials を要するため、
						// テストでは remote bindings を無効化しオフライン・決定的に保つ。実推論は AiRunner を fake する。
						remoteBindings: false,
						miniflare: {
							bindings: { TEST_MIGRATIONS: migrations },
						},
					}),
				],
				test: {
					name: "server",
					include: ["src/**/*.test.ts"],
					exclude: [...configDefaults.exclude, "e2e/**", "src/client/**"],
				},
			},
			{
				plugins: [react()],
				resolve: { alias: clientAlias },
				test: {
					name: "client",
					environment: "jsdom",
					include: ["src/client/**/*.test.{ts,tsx}"],
					setupFiles: ["./src/client/test-setup.ts"],
					exclude: [...configDefaults.exclude, "e2e/**"],
				},
			},
		],
	},
});
