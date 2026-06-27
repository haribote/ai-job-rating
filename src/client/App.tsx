import { type JSX, useSyncExternalStore } from "react";

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

function NavLink({ to, label }: { to: string; label: string }): JSX.Element {
	// 通常リンクの見た目を保ちつつ、ページ全体リロードを避けてクライアント遷移する。
	return (
		<a
			href={to}
			onClick={(event) => {
				event.preventDefault();
				navigate(to);
			}}
		>
			{label}
		</a>
	);
}

function Dashboard(): JSX.Element {
	return (
		<section data-testid="dashboard-view">
			<h2>ダッシュボード</h2>
			<p>ランキングと求人詳細はここに表示されます（#108–#114 で実装）。</p>
		</section>
	);
}

function Settings(): JSX.Element {
	return (
		<section data-testid="settings-view">
			<h2>設定</h2>
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
			<header>
				<h1>ai-job-rating</h1>
				<nav>
					<NavLink to="/" label="ダッシュボード" />
					<NavLink to="/settings" label="設定" />
				</nav>
			</header>
			<main>{route === "settings" ? <Settings /> : <Dashboard />}</main>
		</div>
	);
}
