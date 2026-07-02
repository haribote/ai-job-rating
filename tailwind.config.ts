import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { toRootCssVars, toTailwindTheme } from "./src/shared/design-tokens";

// Tailwind 設定は design-tokens.ts（単一の真実）から theme と :root の CSS 変数を供給するだけの薄いラッパ。
// 値の二重定義を持たず、変換ロジックは design-tokens.test.ts で担保する（#97 / §8）。
export default {
	darkMode: ["class"],
	content: ["./index.html", "./src/client/**/*.{ts,tsx}"],
	theme: {
		extend: toTailwindTheme(),
	},
	plugins: [
		// shadcn の意味カラー等を :root へ CSS 変数として注入する（globals.css に値を直書きしない）。
		// overlay アニメーションは globals.css の tw-animate-css import が担う（#132）。
		plugin(({ addBase }) => {
			addBase({ ":root": toRootCssVars() });
		}),
	],
} satisfies Config;
