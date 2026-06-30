// 評判の補助/フォールバック経路（#35）の入力検証で共有する小さなヘルパ。
//
// なぜ存在するか:
// - manual.ts / url-html.ts の純関数バリデータが同じ「unknown → Record 絞り込み」を必要とするため、
//   reputation-config.ts の流儀（同じ asRecord）を 1 箇所に集約して重複を避ける。

// unknown を Record として安全に絞り込む。配列・null・プリミティブは null へ倒す。
export function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}
