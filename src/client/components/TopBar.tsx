import { Plus, Settings } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";

// ダッシュボードシェルのトップバー（設計書 §4.2）。求人投入・設定への入口を常設する。
//
// なぜコールバック受け取りか:
// - ナビゲーション／モーダル状態は親（App）が持つ（投入モーダルは #113、設定ビューは #114）。
//   TopBar は純粋な表示部品に保ち、ルータへ直接依存させず単体テスト可能にする。

export interface TopBarProps {
	// ブランド名クリックでダッシュボード（"/"）へ戻る。
	onNavigateHome: () => void;
	// 求人投入モーダルを開く（#113 で実装）。
	onSubmitJob: () => void;
	// 設定ビュー（"/settings"）へ遷移する（#114 で実装）。
	onOpenSettings: () => void;
}

export function TopBar({
	onNavigateHome,
	onSubmitJob,
	onOpenSettings,
}: TopBarProps): JSX.Element {
	return (
		<header className="flex items-center justify-between border-b px-4 py-3">
			{/* ブランドはダッシュボードへの帰還導線を兼ねる（単一ハブ・§4.1）。
			    リンク全体ロードを避けてクライアント遷移する。 */}
			<a
				href="/"
				onClick={(event) => {
					event.preventDefault();
					onNavigateHome();
				}}
			>
				<h1 className="text-lg font-semibold tracking-tight">ai-job-rating</h1>
			</a>
			<nav className="flex items-center gap-2">
				<Button type="button" onClick={onSubmitJob}>
					<Plus />
					求人を投入
				</Button>
				<Button type="button" variant="outline" onClick={onOpenSettings}>
					<Settings />
					設定
				</Button>
			</nav>
		</header>
	);
}
