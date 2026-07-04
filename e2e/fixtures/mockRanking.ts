import type {
	RankingItem,
	RankingResponse,
} from "../../src/client/lib/useRanking";
import { CATEGORY_KEYS, type CategoryKey } from "../../src/shared/categories";

// @screenshot テスト専用のモックランキングデータ（#204）。
//
// なぜ存在するか:
// - 取得〜AI抽出パイプラインや実データを回さずに、ダッシュボードのレイアウト（ベスト3ヒーロー＋
//   4位以下グリッド）を Playwright の page.route() で intercept した /api/ranking 応答から視覚確認する。
// - RankingCard は item.categoryScores をそのままレーダーへ渡し実データを描画する（#202 merge 済み）。
//   MOCK_RANKING_SCORED は known/unknown 混在の categoryScores を一部ジョブへ付与し、レーダーの
//   サイズ比例・軸番号化・凡例（#203）を意味のあるスコアで目視確認できるようにする。

const NEUTRAL_CATEGORY_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

function job(
	overrides: Partial<RankingItem> & Pick<RankingItem, "jobId">,
): RankingItem {
	return {
		jobId: overrides.jobId,
		sourceUrl:
			overrides.sourceUrl ?? `https://example.com/jobs/${overrides.jobId}`,
		company: overrides.company ?? null,
		title: overrides.title ?? null,
		total: overrides.total ?? null,
		status: overrides.status ?? "ok",
		rejectedBy: overrides.rejectedBy ?? null,
		categoryScores: overrides.categoryScores ?? NEUTRAL_CATEGORY_SCORES,
	};
}

// スコア済み: ベスト3（total/company/title を埋めた現実的な値）＋4位以下3件以上。
export const MOCK_RANKING_SCORED: RankingResponse = {
	jobs: [
		job({
			jobId: "mock-scored-1",
			company: "株式会社サンプルテック",
			title: "バックエンドエンジニア（Go/Kubernetes）",
			total: 87.5,
			// hero（1位）: known/unknown混在でレーダーの重なり解消・サイズ比例を目視確認する（#203）。
			categoryScores: {
				compensation: 0.9,
				integrity: 0.7,
				flexibility: null,
				role: 0.85,
				company: 0.6,
			},
		}),
		job({
			jobId: "mock-scored-2",
			company: "合同会社フィクションワークス",
			title: "フロントエンドエンジニア（React/TypeScript）",
			total: 82.1,
			// podium（2位）。
			categoryScores: {
				compensation: 0.7,
				integrity: null,
				flexibility: 0.8,
				role: 0.75,
				company: 0.5,
			},
		}),
		job({
			jobId: "mock-scored-3",
			company: "架空商事株式会社",
			title: "SRE / インフラエンジニア",
			total: 76.4,
			// podium（3位）。
			categoryScores: {
				compensation: 0.6,
				integrity: 0.65,
				flexibility: 0.5,
				role: null,
				company: 0.4,
			},
		}),
		job({
			jobId: "mock-scored-4",
			company: "テストデータ株式会社",
			title: "データエンジニア",
			total: 68.9,
			// default（4位以下グリッド）。
			categoryScores: {
				compensation: 0.5,
				integrity: 0.55,
				flexibility: null,
				role: 0.6,
				company: null,
			},
		}),
		job({
			jobId: "mock-scored-5",
			company: "ダミーソリューションズ株式会社",
			title: "QAエンジニア",
			total: 61.2,
		}),
		job({
			jobId: "mock-scored-6",
			company: "サンプルシステムズ合同会社",
			title: "社内SE",
			total: 54.8,
		}),
	],
	excluded: [
		job({
			jobId: "mock-scored-excluded-1",
			company: "除外株式会社",
			title: "未経験不問エンジニア",
			total: null,
			rejectedBy: { criterion: "annualSalary", filter: "required" },
		}),
	],
};

// スコア未算出（#198 前の状態を模す）: 一部 total: null（「—」表示）を含むセット。
export const MOCK_RANKING_UNSCORED: RankingResponse = {
	jobs: [
		job({
			jobId: "mock-unscored-1",
			company: "株式会社サンプルテック",
			title: "バックエンドエンジニア（Go/Kubernetes）",
			total: null,
		}),
		job({
			jobId: "mock-unscored-2",
			company: "合同会社フィクションワークス",
			title: "フロントエンドエンジニア（React/TypeScript）",
			total: 68.2,
		}),
		job({
			jobId: "mock-unscored-3",
			company: "架空商事株式会社",
			title: "SRE / インフラエンジニア",
			total: null,
		}),
		job({
			jobId: "mock-unscored-4",
			company: "テストデータ株式会社",
			title: "データエンジニア",
			total: 55.0,
		}),
		job({
			jobId: "mock-unscored-5",
			company: "ダミーソリューションズ株式会社",
			title: "QAエンジニア",
			total: null,
		}),
		job({
			jobId: "mock-unscored-6",
			company: "サンプルシステムズ合同会社",
			title: "社内SE",
			total: 40.1,
		}),
	],
	excluded: [],
};
