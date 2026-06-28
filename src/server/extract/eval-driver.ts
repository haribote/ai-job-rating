// #106 live golden eval ドライバの純粋ロジック（決定的・I/O なし）。
//
// なぜこのモジュールが存在するか:
// - live ドライバ（scripts/eval/eval-models.mjs）の「どのファイルを送るか」「結果をどう読むか」を
//   ファイル I/O・fetch から切り離し、ユニットテスト可能に保つ（normalize-lockfile.mjs と同じ責務分離）。
// - .mjs は本モジュールを動的 import して薄い I/O ラッパに留める（型は実行時に erase される前提で型注釈のみ）。

import type { ModelSelection } from "./model-eval";

// driver が dev route の応答を待つ上限（ms）。route は baseline+候補を逐次 runGolden で実行し、
// 総時間が global fetch（undici）既定 headersTimeout=300s を超える。
// #144 修正後は全候補が json-mode で実走する（旧: FC 7 候補が即時失敗し fast fail で ~910s に収まっていた）ため、
// 9 モデル×6 件×分割パス＋gpt-oss reasoning で 30 分を超過し得る。実測で driver が 30 分上限に達したため延長。
// driver(.mjs) は EVAL_REQUEST_TIMEOUT_MS 環境変数で上書きでき、本値はその既定。
export const EVAL_REQUEST_TIMEOUT_MS = 90 * 60 * 1000;

// golden ディレクトリのファイル名一覧から POST 対象の golden JSON だけを選ぶ（決定的）。
// 実体（*.json）とサニタイズ雛形（*.example.json）の双方を含め、README.md / .gitignore 等の非 JSON は除く。
// 名前順に整列して driver の出力順を安定させる。
export function selectGoldenFiles(filenames: readonly string[]): string[] {
	return filenames.filter((name) => name.endsWith(".json")).sort();
}

// accuracy（0..1 or null）を人間可読な % へ。採点外（null）は n/a。
function formatPercent(accuracy: number | null): string {
	return accuracy === null ? "n/a" : `${(accuracy * 100).toFixed(1)}%`;
}

// delta（候補 - 現行, null 可）を符号付き % へ。採点外は空文字（行を汚さない）。
function formatDelta(delta: number | null): string {
	if (delta === null) return "";
	const sign = delta >= 0 ? "+" : "";
	return ` delta ${sign}${(delta * 100).toFixed(1)}%`;
}

// ModelSelection を人間可読な複数行テキストへ整形する（決定的）。
// baseline overall → 候補ごとに overall delta・acceptable・regressed フィールド一覧 → 末尾に勝者/changed。
export function formatModelSelection(selection: ModelSelection): string {
	const lines: string[] = [];
	// baseline overall は全候補で同一（同分母前提）。先頭比較から 1 度だけ表示する。
	const first = selection.comparisons[0];
	if (first) {
		const b = first.overall.baseline;
		lines.push(
			`baseline: ${selection.baselineModel}  overall ${b.correct}/${b.total} (${formatPercent(b.accuracy)})`,
		);
	} else {
		lines.push(`baseline: ${selection.baselineModel}`);
	}

	for (const c of selection.comparisons) {
		const cand = c.overall.candidate;
		lines.push(
			`- ${c.candidateModel}  overall ${cand.correct}/${cand.total} (${formatPercent(cand.accuracy)})${formatDelta(c.overall.delta)}  acceptable=${c.acceptable ? "yes" : "no"}`,
		);
		const regressed = c.perField.filter((f) => f.regressed).map((f) => f.key);
		lines.push(
			`    regressed: ${regressed.length ? regressed.join(", ") : "none"}`,
		);
	}

	lines.push(
		`=> selected: ${selection.selectedModel} (changed: ${selection.changed ? "yes" : "no"})`,
	);
	return lines.join("\n");
}
