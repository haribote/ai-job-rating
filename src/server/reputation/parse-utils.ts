// 評判の補助/フォールバック経路（#35）の入力検証で共有する小さなヘルパ。
//
// なぜ存在するか:
// - manual.ts / url-html.ts の純関数バリデータが同じ「unknown → Record 絞り込み」「有限・非負数の判定」を
//   必要とするため、#35 の 2 経路で 1 箇所に集約して重複を避ける（reputation-config.ts の asRecord と同方針。
//   あちらは設定経路専用で配列も許容するため別実装のまま残す）。

// unknown を Record として安全に絞り込む。配列・null・プリミティブは null へ倒す。
export function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

// 有限かつ非負の数値かを判定する。評判スコア・件数・サブ項目に共通する受理条件
// （スケールは取得元依存のため上限は課さない・#33）。NaN/Infinity/負数/非数は false。
export function isFiniteNonNegativeNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
