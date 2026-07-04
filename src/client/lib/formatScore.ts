// スコアの表示整形（決定的）。未スコア（null）は中立記号、それ以外は小数2桁。
export function formatScore(score: number | null): string {
	return score === null ? "—" : score.toFixed(2);
}
