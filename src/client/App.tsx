import { type JSX, useSyncExternalStore } from "react";
import { TopBar } from "./components/TopBar";
import { Dashboard } from "./routes/Dashboard";

// 最小 router: History API の pathname を購読し、`/`（ダッシュボード）と `/settings`（設定）を出し分ける。
// Wave 3（#108–#114）が本格 UI（ランキングカード・詳細ドロワー・設定ビュー）を載せるための足場であり、
// react-router 等の外部依存は持ち込まずに最小の責務（ルート判定とナビゲーション）だけを提供する。

type Route = "dashboard" | "settings";

function pathToRoute(pathname: string): Route {
	return pathname === "/settings" ? "settings" : "dashboard";
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener("popstate", onChange);
	return () => {
		window.removeEventListener("popstate", onChange);
	};
}

// pushState は popstate を発火しないため、ナビゲーション後に手動でイベントを流して購読側を更新する。
export function navigate(path: string): void {
	if (path === window.location.pathname) {
		return;
	}
	window.history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePathname(): string {
	return useSyncExternalStore(
		subscribe,
		() => window.location.pathname,
		() => "/",
	);
}

function Settings(): JSX.Element {
	return (
		<section data-testid="settings-view" className="p-4">
			<h2 className="text-lg font-semibold">設定</h2>
			<p>
				重み・希望値・ハードフィルタの設定はここに表示されます（#114 で実装）。
			</p>
		</section>
	);
}

export function App(): JSX.Element {
	const route = pathToRoute(usePathname());

	return (
		<div data-app-shell>
			<TopBar
				onNavigateHome={() => navigate("/")}
				onSubmitJob={() => {
					// 投入モーダルは #113 で実装する。
				}}
				onOpenSettings={() => navigate("/settings")}
			/>
			<main>{route === "settings" ? <Settings /> : <Dashboard />}</main>
		</div>
	);
}
