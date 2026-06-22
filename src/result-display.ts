// 単一求人のスコア結果（総合＋項目別内訳）を SSR HTML へ落とす表示層（要件 §5.2 / roadmap Phase 0）。
//
// なぜこのモジュールが存在するか:
// - 責務は「表示」のみ。取得 #8 / 抽出 #11 / スコアリング #12 のロジックは呼ぶだけで作り込まない。
// - scoreJob の戻り値（ScoreResult）と NormalizedJob を忠実にレンダリングする。回避策はハードコードせず、
//   raw 値・included を内訳に出すことで既知の統合縮退（#59）も可視化される設計にする。
// - 抽出本文・raw 値を埋め込むため、ユーザ由来文字列は必ず escapeHtml で XSS を防ぐ。
// - 描画は決定的な純関数に切り出し、null/included の分岐・エスケープをユニットテストで担保する。

import type { NormalizedJob, NormalizedKey } from "./job-schema";
import type { ScoreResult } from "./score";

// HTML 特殊文字をエスケープする（XSS 防止）。
// & を最初に置換しないと後続の実体参照を二重エスケープしてしまうため順序が重要。
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// 総合スコア（0..1）を整数 % へ。null は 0 と区別し「評価できる項目なし」と表示する（unknown 中立の可視化）。
export function formatScorePercent(total: number | null): string {
	if (total === null) return "評価できる項目なし";
	return `${Math.round(total * 100)}%`;
}

// 項目別サブスコア（0..1）を % へ。除外項目（null）は「情報なし」と表示する。
export function formatSubScore(score: number | null): string {
	if (score === null) return "情報なし";
	return `${Math.round(score * 100)}%`;
}

// 正規キーの日本語ラベル。スコアリング設定のキー集合に対応する（表示用途のみ）。
// ランキング一覧（#18）も同じラベル集合を参照するため export する（表示語彙の単一ソース）。
export const JP_LABELS: Record<NormalizedKey, string> = {
	annualSalary: "年収",
	monthlySalary: "月給",
	bonus: "賞与",
	salaryRaise: "昇給",
	retirementAllowance: "退職金",
	overtime: "残業",
	annualHolidays: "年間休日",
	holidaySystem: "休日制度",
	paidLeaveRate: "有給取得率",
	remoteWork: "リモートワーク",
	flexWork: "フレックス・裁量労働",
	workLocation: "勤務地",
	employmentType: "雇用形態",
	employmentTerm: "雇用期間",
	techStack: "技術スタック",
	requiredSkillsMatch: "必須スキル適合",
	preferredSkillsMatch: "歓迎スキル適合",
	businessDomain: "事業ドメイン",
	languageRequirement: "言語要件",
	companySize: "企業規模",
	companyPhase: "企業フェーズ",
};

// kind の日本語ラベル（評価方式の可読化）。ランキング一覧（#18）と共有する。
export const KIND_LABELS: Record<
	ScoreResult["breakdown"][number]["kind"],
	string
> = {
	numericRange: "数値レンジ",
	categorical: "カテゴリ",
	aiJudged: "AI 判定",
};

// 正規キーの値から表示用の生表記を取り出す。raw が無ければ空文字（情報なし行で十分）。
function rawOf(job: NormalizedJob, key: NormalizedKey): string {
	const value = job[key];
	return "raw" in value && typeof value.raw === "string" ? value.raw : "";
}

// 内訳テーブル 1 行を描画する。ユーザ由来の raw 値は escapeHtml で必ずエスケープする。
function renderRow(
	row: ScoreResult["breakdown"][number],
	job: NormalizedJob,
): string {
	const raw = rawOf(job, row.key);
	return [
		"<tr>",
		`<td>${escapeHtml(JP_LABELS[row.key])}</td>`,
		`<td>${escapeHtml(KIND_LABELS[row.kind])}</td>`,
		`<td>${row.weight}</td>`,
		`<td>${formatSubScore(row.score)}</td>`,
		`<td>${row.included ? "採用" : "情報なし"}</td>`,
		`<td>${escapeHtml(raw)}</td>`,
		"</tr>",
	].join("");
}

// ScoreResult と NormalizedJob から結果ページ HTML を組み立てる（決定的）。
// breakdown は scoreJob が決定的順序で返すため、そのままの順序で描画する。
export function renderResultPage(
	result: ScoreResult,
	job: NormalizedJob,
): string {
	const rows = result.breakdown.map((row) => renderRow(row, job)).join("");
	return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>スコア結果 — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>スコア結果</h1>
      <p>総合スコア: <strong>${escapeHtml(formatScorePercent(result.total))}</strong></p>
      <table>
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
        <tbody>${rows}</tbody>
      </table>
      <p><a href="/paste">別の HTML を入力する</a></p>
    </main>
  </body>
</html>`;
}
