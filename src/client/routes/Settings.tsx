import { type JSX, useEffect, useState } from "react";
import { CriteriaForm } from "../components/CriteriaForm";
import { ReputationSourcesForm } from "../components/ReputationSourcesForm";
import { type ApiClient, createApiClient } from "../lib/api";
import { type CriteriaConfigItem, fetchConfig } from "../lib/criteria";

// 設定ビュー（設計書 §4.5・全画面ルート /settings）。GET /api/config を取得して CriteriaForm を描画する。
//
// なぜ取得をここで持つか:
// - フォーム本体（CriteriaForm）は初期値（items）と保存経路（api）を受け取る純粋な編集部品に保ち、
//   取得のライフサイクル（loading/error）はルート側に集約する（責務分離 §9）。
// - 再ランキング反映は Dashboard 再マウント時の useRanking 再取得で実現する（App はルートを出し分け、
//   /settings → / の遷移で Dashboard が再取得する）。保存自体は PUT のみ＝AI 非再実行（§5.3）。

export interface SettingsProps {
	// 設定取得関数（既定は GET /api/config）。テストはフェイクを注入する。
	readonly configFetcher?: () => Promise<CriteriaConfigItem[]>;
	// 保存に使う API クライアント（既定は global fetch）。
	readonly api?: ApiClient;
}

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: Error }
	| { readonly status: "success"; readonly items: CriteriaConfigItem[] };

// 既定の取得関数・クライアントは安定参照（module スコープ）にする。
// useEffect の依存に configFetcher を含むため、レンダごとに新しい関数を既定値にすると
// 依存が毎回変わり再取得が無限ループする（useRanking.defaultFetcher と同方針）。
const defaultConfigFetcher: () => Promise<CriteriaConfigItem[]> = () =>
	fetchConfig();
const defaultApi = createApiClient();

export function Settings({
	configFetcher = defaultConfigFetcher,
	api = defaultApi,
}: SettingsProps): JSX.Element {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		// アンマウント後の setState を防ぐガード。
		let active = true;
		setState({ status: "loading" });
		configFetcher()
			.then((items) => {
				if (active) setState({ status: "success", items });
			})
			.catch((cause: unknown) => {
				if (active) {
					const error =
						cause instanceof Error ? cause : new Error(String(cause));
					setState({ status: "error", error });
				}
			});
		return () => {
			active = false;
		};
	}, [configFetcher]);

	return (
		<section data-testid="settings-view" className="mx-auto max-w-3xl p-4">
			<h2 className="mb-4 text-lg font-semibold">設定</h2>

			{state.status === "loading" && (
				<p data-testid="settings-loading">読み込み中...</p>
			)}

			{state.status === "error" && (
				<p role="alert">設定の取得に失敗しました。</p>
			)}

			{state.status === "success" && (
				<div className="flex flex-col gap-6">
					<CriteriaForm items={state.items} api={api} />
					<ReputationSourcesForm api={api} />
				</div>
			)}
		</section>
	);
}
