import { type JSX, useEffect, useState } from "react";
import {
	fetchReputationApiKeyConfig,
	type ReputationApiKeyConfig,
} from "../lib/reputation";

// 企業評判（Phase 2）の設定節（#31）。設定画面に差し込み、評判検索（#30）の前提キーの構成状態と
// 取得元/スコア表示の足場を描く。
//
// なぜ独立コンポーネントか:
// - 設定画面（Settings.tsx）への編集を import + 1 箇所差し込みに留め、#34（取得元 CRUD）との
//   共有ファイル衝突を最小化する。
// - presence の取得ライフサイクル（loading/error/success）をここに閉じ、Settings の取得（GET /api/config）と
//   独立させる。キー値そのものはサーバが返さない（presence のみ・秘匿 §8）。
// - スコア数値の表示は評判スコアが成立する #36/#37 の責務。ここでは未実装の数値を作り込まず、足場のみ置く。

export interface ReputationApiKeySectionProps {
	// 構成状態の取得関数（既定は GET /api/reputation/config）。テストはフェイクを注入する。
	readonly configFetcher?: () => Promise<ReputationApiKeyConfig>;
}

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: Error }
	| { readonly status: "success"; readonly config: ReputationApiKeyConfig };

// 既定の取得関数は安定参照（module スコープ）。useEffect 依存に含めるため毎レンダ新規だと再取得が無限ループする
// （Settings.tsx / useRanking と同方針）。
const defaultConfigFetcher: () => Promise<ReputationApiKeyConfig> = () =>
	fetchReputationApiKeyConfig();

export function ReputationApiKeySection({
	configFetcher = defaultConfigFetcher,
}: ReputationApiKeySectionProps): JSX.Element {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		// アンマウント後の setState を防ぐガード。
		let active = true;
		setState({ status: "loading" });
		configFetcher()
			.then((config) => {
				if (active) setState({ status: "success", config });
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
		<section
			data-testid="reputation-api-key-section"
			className="mt-8 border-t pt-6"
		>
			<h3 className="mb-2 text-base font-semibold">企業評判（Phase 2）</h3>

			{state.status === "loading" && (
				<p data-testid="reputation-api-key-loading">読み込み中...</p>
			)}

			{state.status === "error" && (
				<p role="alert">評判設定の取得に失敗しました。</p>
			)}

			{state.status === "success" && (
				<div className="space-y-3 text-sm">
					<p data-testid="reputation-api-key-status">
						Claude API キー（ANTHROPIC_API_KEY）:{" "}
						<span className="font-medium">
							{state.config.apiKeyConfigured ? "設定済み" : "未設定"}
						</span>
					</p>

					{!state.config.apiKeyConfigured && (
						<div
							data-testid="reputation-api-key-setup-guide"
							className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900"
						>
							<p className="mb-1">
								評判検索を使うには Claude API キーを設定してください。
							</p>
							{/* フォーク先が注入できるよう、秘匿値をコードに直書きしない 2 経路（§8）を案内する。 */}
							<ul className="list-disc pl-5">
								<li>
									本番: <code>wrangler secret put ANTHROPIC_API_KEY</code>
								</li>
								<li>
									ローカル開発: <code>.dev.vars</code> に{" "}
									<code>ANTHROPIC_API_KEY=...</code> を記述
								</li>
							</ul>
						</div>
					)}

					{/* 取得元(source)表示の足場。取得元設定の CRUD は #34、評判の実取得は #30 の責務。 */}
					<p
						data-testid="reputation-source-placeholder"
						className="text-gray-500"
					>
						取得元（口コミサイト等）の設定・表示は順次対応予定です。
					</p>

					{/* スコア数値表示は評判スコアが成立する #36/#37 で実装する。未実装の数値はここに作らない。 */}
					<p
						data-testid="reputation-score-placeholder"
						className="text-gray-500"
					>
						評判スコアの表示は今後のリリースで対応します。
					</p>
				</div>
			)}
		</section>
	);
}
