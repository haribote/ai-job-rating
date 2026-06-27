// 抽出機構（JSON Mode / Function calling）の解決アダプタ（#107 / #106 follow-up・要件 §7.1 / §8）。
//
// なぜこのモジュールが存在するか:
// - extractJob の出力機構を JSON Mode 固定にせず、モデルごとに切り替える（#15: JSON Mode 公式対応は
//   incumbent と llama-3.1-8b のみ。広 context・高速・安価な FC 系を射程に入れるには機構の切替が要る）。
// - 「モデル ID → 機構」の対応は model-eval.ts の EXTRACTION_MODEL_CANDIDATES（ModelCandidate.mechanism）を
//   単一ソースにする。機構をコードに直書きせずカタログ駆動にすることでフォーク容易性を保つ（§8）。

import {
	EXTRACTION_MODEL_CANDIDATES,
	type ExtractionMechanism,
} from "./model-eval";

// カタログ未掲載モデル（incumbent / フォーク先の独自モデル）の既定機構。
// なぜ json-mode を既定にするか: JSON Mode 公式対応は incumbent / llama-3.1-8b のみ。未知モデルを FC と
// 仮定すると JSON Mode 専用モデルで tool_calls 不在になり抽出不能になる。保守的に json-mode へ寄せる。
export const DEFAULT_MECHANISM: ExtractionMechanism = "json-mode";

// モデル ID から抽出機構を解決する（決定的・カタログ駆動）。
// EXTRACTION_MODEL_CANDIDATES に載るモデルはその mechanism を、未掲載は DEFAULT_MECHANISM を返す。
export function resolveExtractionMechanism(model: string): ExtractionMechanism {
	const found = EXTRACTION_MODEL_CANDIDATES.find((c) => c.id === model);
	return found ? found.mechanism : DEFAULT_MECHANISM;
}
