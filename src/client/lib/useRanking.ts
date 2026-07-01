import { useEffect, useState } from "react";
import type { NormalizedKey } from "../../shared/job-schema";
import type { ExtractionStatus } from "../../shared/submit-job";
import { apiGet } from "./api";

// GET /api/ranking（#95 契約）を購読する React フック。
//
// なぜ存在するか:
// - ダッシュボード（#108 シェル）以降の各ビューが fetch のライフサイクル（loading/error/success）と
//   契約型を再実装しないよう、取得状態を 1 箇所に集約する。
// - 契約はサーバ側の責務（抽出↔スコア分離・unknown 中立・正規化）。本フックは消費するだけで再実装しない。
// - fetcher を注入可能にし、jsdom テストをネットワーク非依存・決定的に保つ（注入する fetcher は安定参照前提）。

// 抽出状態（契約）。投入契約と共有する単一ソースへ集約した（#187）。既存 import 元を壊さないため再輸出する。
export type { ExtractionStatus };

// ランキング一覧 1 行の契約型（#95）。company/title は抽出スキーマ未対応で現状 null。
export interface RankingItem {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly company: string | null;
	readonly title: string | null;
	readonly total: number | null;
	readonly status: ExtractionStatus;
	// ハードフィルタ除外理由（通過は null）。criterion は正規キー（#101）。
	readonly rejectedBy: {
		readonly criterion: NormalizedKey;
		readonly filter: "required" | "exclude";
	} | null;
}

// GET /api/ranking の応答（通過分 jobs ＋ ハードフィルタ除外分 excluded）。
export interface RankingResponse {
	readonly jobs: RankingItem[];
	readonly excluded: RankingItem[];
}

// ランキング取得関数。既定は /api/ranking を叩く。テストはフェイクを注入する。
export type RankingFetcher = () => Promise<RankingResponse>;

const defaultFetcher: RankingFetcher = () =>
	apiGet<RankingResponse>("/ranking");

// 取得状態の判別共用体。consumer は status で網羅的に分岐する。
export type RankingState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: Error }
	| {
			readonly status: "success";
			readonly jobs: RankingItem[];
			readonly excluded: RankingItem[];
	  };

export function useRanking(
	fetcher: RankingFetcher = defaultFetcher,
): RankingState {
	const [state, setState] = useState<RankingState>({ status: "loading" });

	useEffect(() => {
		// アンマウント後／二重実行（StrictMode）での setState を防ぐためのガード。
		let active = true;
		setState({ status: "loading" });
		fetcher()
			.then((data) => {
				if (active) {
					setState({
						status: "success",
						jobs: data.jobs,
						excluded: data.excluded,
					});
				}
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
	}, [fetcher]);

	return state;
}
