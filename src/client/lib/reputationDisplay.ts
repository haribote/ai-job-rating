// 企業評判（Phase 2）の UI 表示状態を導出する決定的純関数（#37）。
//
// なぜ client 側で再定義するか:
// - server（src/server/scoring/reputation-score.ts）は別バンドルで import できないため、信頼度の閉集合を
//   client 側に複製して一貫消費する（jobDetail.ts / reputation.ts の流儀）。表示ロジックは UI の責務。
// - 「中立扱い」と「低信頼フラグ」は要件 §5.2（unknown 中立）の UI 表現。データなし・APIキー未設定・低件数を
//   それぞれ中立/低信頼として明示し、0 点に潰さない。実データ（score/confidence）の供給は #117。

// 評判寄与の信頼度（server ReputationConfidence と整合）。
export type ReputationConfidence = "none" | "low" | "ok";

export interface ReputationDisplayInput {
	// ANTHROPIC_API_KEY の構成状態（GET /api/reputation/config 由来）。未設定なら評判は取得できず中立。
	readonly apiKeyConfigured: boolean;
	// 評判寄与スコア（0..1）。データなし・中立は null/省略。実データ供給は #117。
	readonly score?: number | null;
	// 信頼度。省略時は none（データなし＝中立）扱い。
	readonly confidence?: ReputationConfidence;
}

export interface ReputationDisplay {
	// company 軸の分母から除外される中立扱いか（true なら 0 点でなく「中立」）。
	readonly neutral: boolean;
	// 低信頼フラグ（データなし・APIキー未設定・低件数）。
	readonly lowConfidence: boolean;
	// スコア表示（0..1 を 2 桁、または「—」）。
	readonly scoreText: string;
	// 状態見出し。
	readonly statusLabel: string;
	// 補足説明（中立/低信頼の理由）。
	readonly note: string;
}

// 値なしの表示。BreakdownTable と揃える。
const EMPTY_MARK = "—";

// スコア表示。null は「—」、それ以外は 0..1 を 2 桁（BreakdownTable formatScore と同流儀）。
function formatScore(score: number | null): string {
	return score === null ? EMPTY_MARK : score.toFixed(2);
}

// 入力から表示状態を導出する（決定的）。
export function describeReputationDisplay(
	input: ReputationDisplayInput,
): ReputationDisplay {
	// APIキー未設定では評判検索（#30）が不可能。寄与に関わらず中立・低信頼として明示する。
	if (!input.apiKeyConfigured) {
		return {
			neutral: true,
			lowConfidence: true,
			scoreText: EMPTY_MARK,
			statusLabel: "中立（評判なし）",
			note: "ANTHROPIC_API_KEY が未設定のため、評判はスコアから除外され中立として扱われます。",
		};
	}

	const score = input.score ?? null;
	const confidence: ReputationConfidence = input.confidence ?? "none";

	// データなし・評価不能は中立（分母除外）。0 点に潰さない。
	if (confidence === "none" || score === null) {
		return {
			neutral: true,
			lowConfidence: true,
			scoreText: EMPTY_MARK,
			statusLabel: "中立（データなし）",
			note: "評判データがないため、スコアから除外され中立として扱われます。",
		};
	}

	// 件数が少なく中立 prior へ収縮した低信頼な値。スコアは出すが低信頼フラグを立てる。
	if (confidence === "low") {
		return {
			neutral: false,
			lowConfidence: true,
			scoreText: formatScore(score),
			statusLabel: "評判スコア（低信頼）",
			note: "口コミ件数が少なく、中立寄りに収縮した低信頼な評価です。",
		};
	}

	return {
		neutral: false,
		lowConfidence: false,
		scoreText: formatScore(score),
		statusLabel: "評判スコア",
		note: "",
	};
}
