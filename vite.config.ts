import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// React SPA を public/ へビルドして Workers の静的資産（assets）として配信する。
//
// public/ 共存方針（#97 で Tailwind へ移行）:
// - スタイルは src/client/styles/globals.css を main.tsx から import し、Vite が PostCSS/Tailwind 経由で
//   バンドルする（生成された CSS は public/assets/ へ出力され .gitignore 対象）。styles.css の直生成は廃止。
// - public/ の中身はすべて Vite のビルド成果物（index.html / assets/* / .vite）で .gitignore 済みのため、
//   毎ビルドで emptyOutDir=true により一掃し、ハッシュ付き古い asset の残留を防ぐ。
// - publicDir は既定で "public" だが outDir と同一になり衝突するため無効化する。
export default defineConfig({
	plugins: [react()],
	publicDir: false,
	resolve: {
		// shadcn 規約のパスエイリアス（@/components, @/lib 等）。tsconfig.client.json の paths と一致させる。
		alias: {
			// engines.node が ">=20" のため import.meta.dirname（20.11+）に依存せず file URL から導出する。
			"@": resolve(dirname(fileURLToPath(import.meta.url)), "src/client"),
		},
	},
	build: {
		outDir: "public",
		emptyOutDir: true,
	},
	server: {
		// 単体の Vite dev server（HMR）から API を叩く場合に wrangler dev へプロキシする。
		// 既定の dev 検証は wrangler dev（ビルド済み assets）で行うため、これは任意の開発補助。
		proxy: {
			"/api": "http://localhost:8787",
		},
	},
});
