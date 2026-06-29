import { type JSX, useState, useSyncExternalStore } from "react";
import { AddJobModal } from "./components/AddJobModal";
import { TopBar } from "./components/TopBar";
import { Dashboard } from "./routes/Dashboard";
import { Settings } from "./routes/Settings";

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

export function App(): JSX.Element {
	const route = pathToRoute(usePathname());
	// 投入モーダルの開閉（#113）。状態は親が持ち、TopBar は純粋な表示部品に保つ。
	const [addJobOpen, setAddJobOpen] = useState(false);
	// 投入成功ごとに増やす nonce。Dashboard の key に渡して再マウントさせ、
	// GET /api/ranking を再取得する（再ランキング）。useRanking 側を変えず最小差分で
	// 「投入→一覧反映」を成立させる（抽出↔スコア分離は不変・投入はトリガのみ）。
	const [reloadKey, setReloadKey] = useState(0);

	return (
		<div data-app-shell>
			<TopBar
				onNavigateHome={() => navigate("/")}
				onSubmitJob={() => setAddJobOpen(true)}
				onOpenSettings={() => navigate("/settings")}
			/>
			<main>
				{route === "settings" ? <Settings /> : <Dashboard key={reloadKey} />}
			</main>
			<AddJobModal
				open={addJobOpen}
				onOpenChange={setAddJobOpen}
				onSubmitted={() => {
					// 投入後は一覧（ダッシュボード）へ戻し、再取得して新規ジョブを反映する。
					setReloadKey((key) => key + 1);
					navigate("/");
				}}
			/>
		</div>
	);
}
