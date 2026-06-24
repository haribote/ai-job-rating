// 投入済み求人をスコア順に並べ、項目別内訳・除外理由を SSR HTML へ落とす表示層（#18 / roadmap Phase 1）。
//
// なぜこのモジュールが存在するか:
// - 責務は「表示」のみ。並び順は #20 の rankJobs に委ねる（決定的・§8）。本モジュールは
//   渡された順序のまま順位を振り、AI も再スコアリングも実行しない（§5.3 抽出とスコアリングの分離）。
// - scores（#16 確定スキーマ）由来の RescoredJob と raw 値を忠実にレンダリングする。
//   included=false は「情報なし・分母除外」として可視化し unknown 中立を見える化する（§5.2）。
// - ハードフィルタ除外求人は別枠に出し、除外理由（criterion・種別）を表示する（rejectedBy）。
// - raw 値・source_url はユーザ由来文字列のため escapeHtml で必ず XSS を防ぐ。
// - 描画は決定的な純関数。DB I/O は持たない（読み出しは ranking.ts、責務分離 §9）。

import type { NormalizedJob, NormalizedKey } from "./job-schema";
import type { HardFilterResult, RescoredJob } from "./rescore-core";
import {
	escapeHtml,
	formatScorePercent,
	formatSubScore,
	JP_LABELS,
	KIND_LABELS,
} from "./result-display";
import type { ScoreResult } from "./score";

// 一覧 1 行の項目別内訳。score/included/weight は scores 由来、raw は抽出値（表示用）。
export interface RankedBreakdownRow {
	readonly key: NormalizedKey;
	readonly kind: ScoreResult["breakdown"][number]["kind"];
	readonly weight: number;
	readonly score: number | null;
	readonly included: boolean;
	readonly raw: string;
}

// ランキング一覧の 1 求人ビュー。並び順は呼び出し側（rankJobs）が確定済み。
export interface RankedJobView {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly total: number | null;
	readonly breakdown: readonly RankedBreakdownRow[];
	// ハードフィルタ除外の理由（通過した求人は null）。
	readonly rejectedBy: HardFilterResult["rejectedBy"];
}

// 正規キーの値から表示用の生表記を取り出す。raw が無ければ空文字。
function rawOf(job: NormalizedJob, key: NormalizedKey): string {
	const value = job[key];
	return "raw" in value && typeof value.raw === "string" ? value.raw : "";
}

// RescoredJob（#20）+ 取得元 URL + 抽出済み求人 → 表示ビュー。
// score/included/weight は RescoredJob 由来（= 永続 scores と同値・決定的）、raw は抽出値。
export function rescoredToView(
	rescored: RescoredJob,
	sourceUrl: string,
	job: NormalizedJob,
): RankedJobView {
	return {
		jobId: rescored.jobId,
		sourceUrl,
		total: rescored.score.total,
		breakdown: rescored.score.breakdown.map((row) => ({
			key: row.key,
			kind: row.kind,
			weight: row.weight,
			score: row.score,
			included: row.included,
			raw: rawOf(job, row.key),
		})),
		rejectedBy: rescored.hardFilter.rejectedBy,
	};
}

// ハードフィルタ種別の可読化。
const FILTER_LABELS: Record<"required" | "exclude", string> = {
	required: "必須",
	exclude: "除外",
};

// 内訳テーブル 1 行を描画する。included=false は「情報なし・分母除外」と注記し中立を可視化する。
function renderBreakdownRow(row: RankedBreakdownRow): string {
	const inclusion = row.included ? "採用" : "情報なし（分母除外）";
	return [
		"<tr>",
		`<td>${escapeHtml(JP_LABELS[row.key])}</td>`,
		`<td>${escapeHtml(KIND_LABELS[row.kind])}</td>`,
		`<td>${row.weight}</td>`,
		`<td>${formatSubScore(row.score)}</td>`,
		`<td>${inclusion}</td>`,
		`<td>${escapeHtml(row.raw)}</td>`,
		"</tr>",
	].join("");
}

// 内訳テーブル全体を描画する。
function renderBreakdownTable(rows: readonly RankedBreakdownRow[]): string {
	const body = rows.map(renderBreakdownRow).join("");
	return `<table>
        <thead>
          <tr>
            <th>項目</th>
            <th>評価方式</th>
            <th>重み</th>
            <th>サブスコア</th>
            <th>採否</th>
            <th>抽出値</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
}

// ランキング 1 件（順位つき）を描画する。順位は渡された順序のまま振る。
function renderRankedJob(view: RankedJobView, rank: number): string {
	return `<section>
      <h2>${rank} 位: <a href="${escapeHtml(view.sourceUrl)}">${escapeHtml(view.jobId)}</a></h2>
      <p>総合スコア: <strong>${escapeHtml(formatScorePercent(view.total))}</strong></p>
      ${renderBreakdownTable(view.breakdown)}
    </section>`;
}

// 除外求人 1 件を描画する。除外理由（criterion・種別）を明示する。
function renderExcludedJob(view: RankedJobView): string {
	const reason =
		view.rejectedBy === null
			? ""
			: `<p>除外理由: <strong>${escapeHtml(JP_LABELS[view.rejectedBy.criterion])}</strong>（${FILTER_LABELS[view.rejectedBy.filter]}）</p>`;
	return `<section>
      <h3><a href="${escapeHtml(view.sourceUrl)}">${escapeHtml(view.jobId)}</a></h3>
      ${reason}
      ${renderBreakdownTable(view.breakdown)}
    </section>`;
}

// ランキング一覧ページ HTML を組み立てる（決定的）。
// ranked: ハードフィルタ通過済みをスコア降順に並べた配列（rankJobs の出力）。
// excluded: ハードフィルタで除外された求人（理由つきで別枠表示）。
export function renderRankingPage(
	ranked: readonly RankedJobView[],
	excluded: readonly RankedJobView[],
): string {
	const rankedHtml =
		ranked.length === 0
			? "<p>求人がありません。</p>"
			: ranked.map((view, i) => renderRankedJob(view, i + 1)).join("");
	const excludedHtml =
		excluded.length === 0
			? ""
			: `<h2>除外された求人</h2>
      <p>ハードフィルタにより順位対象から外れた求人です。</p>
      ${excluded.map(renderExcludedJob).join("")}`;
	return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>ランキング — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>求人ランキング</h1>
      ${rankedHtml}
      ${excludedHtml}
    </main>
  </body>
</html>`;
}
