import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Tailwind + shadcn のスタイル。Vite が PostCSS/Tailwind 経由でバンドルし assets として配信する（#97）。
import "./styles/globals.css";

// SPA のエントリ。index.html の #root に React ツリーをマウントする。
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("#root 要素が見つかりません");
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
