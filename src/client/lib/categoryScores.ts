import {
	CATEGORY_KEYS,
	type CategoryKey,
	KEYS_BY_CATEGORY,
} from "../../shared/categories";
import type { BreakdownRow } from "./jobDetail";

// フラット内訳（NormalizedKey 別）→ 5軸カテゴリスコアの集約（決定的純関数・#110 申し送り）。
//
// なぜ consumer 側に置くか:
// - ScoreRadar は `Record<CategoryKey, number|null>` だけを受け取る純表示部品。軸への集約は呼び出し側の責務。
// - 軸 ↔ 正規キーの対応は shared/categories の KEYS_BY_CATEGORY を単一ソースに参照する（重複定義しない）。
//
// 集約規則（§5.2 unknown 中立）:
// - 軸内の included かつ score!=null の行のみを weight で加重平均する。
// - unknown 中立（included=false / score=null）は分母から除外する（0 点に潰さない）。
// - 有効行が無い（または重み合計 0）軸は null（中立）として返す。ScoreRadar が穴として描く。
export function aggregateCategoryScores(
	rows: readonly BreakdownRow[],
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
		result[category] = weightTotal > 0 ? weightedSum / weightTotal : null;
	}

	return result;
}
