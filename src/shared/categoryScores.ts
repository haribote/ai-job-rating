import {
	CATEGORY_KEYS,
	type CategoryKey,
	KEYS_BY_CATEGORY,
} from "./categories";
import type { NormalizedKey } from "./job-schema";

// フラット内訳（NormalizedKey 別）→ 5軸カテゴリスコアの集約（決定的純関数・#110 申し送り / #202）。
//
// なぜここに置くか:
// - サーバ（GET /api/ranking の RankingItem 構築）とクライアント（詳細ドロワーの内訳表示）が
//   同一の集約ロジックを必要とするため、shared に一元化し重複実装を避ける（#202）。
// - サーバ側の内訳行（RankedBreakdownRow）・クライアント側の内訳行（BreakdownRow）はいずれも
//   ここで必要な最小フィールド（CategoryBreakdownRow）を構造的に満たすため、型を共有せず
//   最小形状だけをここで定義する（server→client / client→server の依存を作らない）。
//
// 集約規則（§5.2 unknown 中立）:
// - 軸内の included かつ score!=null の行のみを weight で加重平均する。
// - unknown 中立（included=false / score=null）は分母から除外する（0 点に潰さない）。
// - 有効行が無い（または重み合計 0）軸は null（中立）として返す。ScoreRadar が穴として描く。

// 軸集約に必要な内訳行の最小形状。
export interface CategoryBreakdownRow {
	readonly key: NormalizedKey;
	readonly score: number | null;
	readonly included: boolean;
	readonly weight: number;
}

// company 軸へ合流する企業評判 1 件ぶんの寄与の最小形状（#117）。
// score=null（データなし・APIキー未設定・低信頼除外）は分母に入れない（unknown 中立）。
export interface CategoryReputationContribution {
	readonly score: number | null;
	readonly weight: number;
}

export function aggregateCategoryScores(
	rows: readonly CategoryBreakdownRow[],
	reputation?: CategoryReputationContribution | null,
): Record<CategoryKey, number | null> {
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const result = {} as Record<CategoryKey, number | null>;

	for (const category of CATEGORY_KEYS) {
		let weightedSum = 0;
		let weightTotal = 0;
		for (const key of KEYS_BY_CATEGORY[category]) {
			const row = byKey.get(key);
			// unknown 中立は分母に入れない。重みは正のみ採用する。
			if (row === undefined || !row.included || row.score === null) continue;
			const weight = row.weight > 0 ? row.weight : 0;
			weightedSum += weight * row.score;
			weightTotal += weight;
		}
		// 企業評判を company 軸の 1 項目として合流する（中立＝null は分母から外す・#117）。
		if (
			category === "company" &&
			reputation != null &&
			reputation.score !== null
		) {
			const weight = reputation.weight > 0 ? reputation.weight : 0;
			weightedSum += weight * reputation.score;
			weightTotal += weight;
		}
		result[category] = weightTotal > 0 ? weightedSum / weightTotal : null;
	}

	return result;
}
