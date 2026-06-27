import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// React SPA を public/ へビルドして Workers の静的資産（assets）として配信する。
//
// public/ 共存方針:
// - public/styles.css はデザイントークン由来の生成物で VCS 追跡対象（#97 で Tailwind へ移行予定）。
//   Vite が build 時にこれを消さないよう emptyOutDir=false にする。
// - publicDir は既定で "public" だが outDir と同一になり衝突するため無効化する
//   （styles.css は index.html から絶対パス /styles.css で参照し、実行時に同階層から配信される）。
// - Vite が生成する index.html / assets/* はビルド成果物として .gitignore する。
export default defineConfig({
	plugins: [react()],
	publicDir: false,
	build: {
		outDir: "public",
		emptyOutDir: false,
	},
	server: {
		// 単体の Vite dev server（HMR）から API を叩く場合に wrangler dev へプロキシする。
		// 既定の dev 検証は wrangler dev（ビルド済み assets）で行うため、これは任意の開発補助。
		proxy: {
			"/api": "http://localhost:8787",
		},
	},
});
