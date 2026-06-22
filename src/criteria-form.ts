// 重み・希望値・ハードフィルタの設定 UI（SSR フォーム）と保存→即再ランキング導線（#19）。
//
// なぜこのモジュールが存在するか:
// - ユーザーが各正規キー基準の重み・希望値・ハードフィルタを編集し、保存時に criteria_config を
//   更新する受け口（責務は「設定の入出力」のみ、§9）。
// - 保存後は #20 の決定的 rescoreAll を呼んで全 job を即再ランキングする。AI は再実行しない
//   （抽出とスコアリングの分離 §5.3 / ガードレール）。
// - フォーム値 → criteria_config 行の変換・バリデーション（weight>=0・hard_filter 集合・
//   desired_value JSON 化）は決定的な純関数に切り出し、ユニットテストで担保する（§8）。
// - kind ごとの希望値の意味（numericRange の desired/floor|ceil・categorical の preferred）は
//   criteria-config.ts の NORMALIZED_KEY_KINDS を単一ソースとして参照する（ラベル正規化 §5.2）。

import { Hono } from "hono";
import type { Bindings } from "./app";
import { NORMALIZED_KEY_KINDS } from "./criteria-config";
import {
	type CriteriaConfigRow,
	type HardFilter,
	TABLE_NAMES,
} from "./db-schema";
import { NORMALIZED_KEYS, type NormalizedKey } from "./job-schema";
import { rescoreAll } from "./rescore";
import { escapeHtml } from "./result-display";

// ---------------------------------------------------------------------------
// 正規キーの表示ラベル（UI 専用）
// ---------------------------------------------------------------------------

// 正規キーの日本語ラベル。result-display.ts と同集合だが、表示層ごとに独立して持つ
// （#18 一覧 UI と責務分離し、相互に編集し合わないため共有モジュール化はしない）。
const JP_LABELS: Record<NormalizedKey, string> = {
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

// ハードフィルタの選択肢ラベル（UI 専用）。
const HARD_FILTER_LABELS: Record<HardFilter, string> = {
	none: "なし（スコアのみ）",
	required: "必須（満たさない求人を除外）",
	exclude: "除外（満たす求人を除外）",
};

const HARD_FILTERS: readonly HardFilter[] = ["none", "required", "exclude"];

// ---------------------------------------------------------------------------
// 決定的バリデーション・変換（純関数・ユニットテスト対象）
// ---------------------------------------------------------------------------

// フォーム値は criterion ごとに `<field>__<criterion>` の名前で送られる。
type FormValues = Record<string, string>;

// 重みの決定的バリデーション。非負の有限数のみ受理する（weight>=0 ガードレール §5.2）。
export function parseWeight(
	raw: string,
): { ok: true; value: number } | { ok: false } {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: false };
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value < 0) return { ok: false };
	return { ok: true, value };
}

// hard_filter の決定的バリデーション。集合 {none, required, exclude} のみ受理する。
function parseHardFilter(raw: string): HardFilter | null {
	return (HARD_FILTERS as readonly string[]).includes(raw)
		? (raw as HardFilter)
		: null;
}

// categorical の希望集合をカンマ区切り文字列からパースする。空白を除去し空要素は落とす。
export function preferredToList(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

// numericRange の希望値（desired と反対端 floor|ceil）を JSON 文字列へ詰める。
// desired 未入力（空・非数）は評価不能とみなし null を返す（unknown 中立 §5.2）。
function numericDesiredJson(
	values: FormValues,
	key: NormalizedKey,
	direction: "higherBetter" | "lowerBetter",
): string | null {
	const desiredRaw = (values[`desired__${key}`] ?? "").trim();
	if (desiredRaw === "") return null;
	const desired = Number(desiredRaw);
	if (!Number.isFinite(desired)) return null;

	// higherBetter は floor（下限）、lowerBetter は ceil（上限）が反対端。
	const boundKey = direction === "higherBetter" ? "floor" : "ceil";
	const boundRaw = (values[`${boundKey}__${key}`] ?? "").trim();
	const payload: Record<string, number> = { desired };
	if (boundRaw !== "") {
		const bound = Number(boundRaw);
		if (Number.isFinite(bound)) payload[boundKey] = bound;
	}
	return JSON.stringify(payload);
}

// categorical の希望集合を JSON 文字列へ詰める。空集合は評価不能として null（中立）。
function categoricalDesiredJson(
	values: FormValues,
	key: NormalizedKey,
): string | null {
	const preferred = preferredToList(values[`preferred__${key}`] ?? "");
	if (preferred.length === 0) return null;
	return JSON.stringify({ preferred });
}

// フォーム値群を criteria_config 行へ変換する（決定的）。
// 重みが送られた正規キーのみを対象にする（部分更新を許す）。不正な weight / hard_filter は
// 全体を拒否し、保存・再スコアリングへ進ませない（AI/再スコアの前に弾く）。
export function formToConfigRows(
	values: FormValues,
):
	| { ok: true; rows: CriteriaConfigRow[] }
	| { ok: false; reason: "weight" | "hard_filter" } {
	const rows: CriteriaConfigRow[] = [];
	// NORMALIZED_KEYS の順で走査し、決定的な行順を保つ。
	for (const key of NORMALIZED_KEYS) {
		const weightRaw = values[`weight__${key}`];
		// この基準が送信されていない（重み欄なし）なら対象外（部分更新）。
		if (weightRaw === undefined) continue;

		const weight = parseWeight(weightRaw);
		if (!weight.ok) return { ok: false, reason: "weight" };

		const hardFilter = parseHardFilter(values[`hardFilter__${key}`] ?? "none");
		if (hardFilter === null) return { ok: false, reason: "hard_filter" };

		const keyKind = NORMALIZED_KEY_KINDS[key];
		let desiredValue: string | null = null;
		switch (keyKind.kind) {
			case "numericRange":
				desiredValue = numericDesiredJson(values, key, keyKind.direction);
				break;
			case "categorical":
				desiredValue = categoricalDesiredJson(values, key);
				break;
			case "aiJudged":
				// aiJudged は希望値を desired_value に持たない（突合は抽出側 #68）。
				desiredValue = null;
				break;
		}

		rows.push({
			criterion: key,
			desired_value: desiredValue,
			weight: weight.value,
			hard_filter: hardFilter,
			// updated_at は DB 既定（unixepoch()）に委ねるため保存時は無視される。
			updated_at: 0,
		});
	}
	return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// SSR フォーム描画（決定的）
// ---------------------------------------------------------------------------

// 既存設定（criterion → 行）を引きやすい Map へ。
type ConfigByCriterion = Map<string, CriteriaConfigRow>;

// numericRange 行から desired/floor|ceil の初期値を取り出す（描画用、不正は空文字）。
function numericInitials(row: CriteriaConfigRow | undefined): {
	desired: string;
	bound: string;
} {
	if (row?.desired_value == null) return { desired: "", bound: "" };
	try {
		const v = JSON.parse(row.desired_value) as Record<string, unknown>;
		const desired = typeof v.desired === "number" ? String(v.desired) : "";
		const boundRaw = v.floor ?? v.ceil;
		const bound = typeof boundRaw === "number" ? String(boundRaw) : "";
		return { desired, bound };
	} catch {
		return { desired: "", bound: "" };
	}
}

// categorical 行から preferred 集合の初期値（カンマ区切り）を取り出す。
function categoricalInitial(row: CriteriaConfigRow | undefined): string {
	if (row?.desired_value == null) return "";
	try {
		const v = JSON.parse(row.desired_value) as Record<string, unknown>;
		return Array.isArray(v.preferred)
			? v.preferred.filter((p) => typeof p === "string").join(", ")
			: "";
	} catch {
		return "";
	}
}

// ハードフィルタの <select> を描画する（保存済み値を selected に）。
function renderHardFilterSelect(
	key: NormalizedKey,
	current: HardFilter,
): string {
	const options = HARD_FILTERS.map((hf) => {
		const sel = hf === current ? " selected" : "";
		return `<option value="${hf}"${sel}>${escapeHtml(HARD_FILTER_LABELS[hf])}</option>`;
	}).join("");
	return `<select name="hardFilter__${key}">${options}</select>`;
}

// 希望値入力欄を kind ごとに描画する（numericRange: desired+反対端 / categorical: preferred / aiJudged: なし）。
function renderDesiredFields(
	key: NormalizedKey,
	row: CriteriaConfigRow | undefined,
): string {
	const keyKind = NORMALIZED_KEY_KINDS[key];
	switch (keyKind.kind) {
		case "numericRange": {
			const { desired, bound } = numericInitials(row);
			const boundName = keyKind.direction === "higherBetter" ? "floor" : "ceil";
			const boundLabel =
				keyKind.direction === "higherBetter" ? "下限(0点)" : "上限(0点)";
			return [
				`<label>希望値<input type="number" step="any" name="desired__${key}" value="${escapeHtml(desired)}" /></label>`,
				`<label>${escapeHtml(boundLabel)}<input type="number" step="any" name="${boundName}__${key}" value="${escapeHtml(bound)}" /></label>`,
			].join("");
		}
		case "categorical": {
			const preferred = categoricalInitial(row);
			return `<label>歓迎カテゴリ(カンマ区切り)<input type="text" name="preferred__${key}" value="${escapeHtml(preferred)}" /></label>`;
		}
		case "aiJudged":
			// 希望値は抽出側に集約（#68）。設定 UI には希望値欄を出さない。
			return '<span class="ajr-config-note">希望値なし（抽出時に判定）</span>';
	}
}

// 1 基準の設定行（fieldset）を描画する。
function renderCriterionFieldset(
	key: NormalizedKey,
	row: CriteriaConfigRow | undefined,
): string {
	const weight = row !== undefined ? String(row.weight) : "1";
	const hardFilter: HardFilter = row?.hard_filter ?? "none";
	return `<fieldset>
      <legend>${escapeHtml(JP_LABELS[key])}</legend>
      <label>重み<input type="number" step="any" min="0" name="weight__${key}" value="${escapeHtml(weight)}" /></label>
      <label>ハードフィルタ${renderHardFilterSelect(key, hardFilter)}</label>
      ${renderDesiredFields(key, row)}
    </fieldset>`;
}

// 設定フォームページ全体を描画する（決定的）。saved=true で保存完了の導線を出す。
export function renderConfigForm(
	rows: readonly CriteriaConfigRow[],
	saved = false,
): string {
	const byCriterion: ConfigByCriterion = new Map(
		rows.map((r) => [r.criterion, r]),
	);
	const fieldsets = NORMALIZED_KEYS.map((key) =>
		renderCriterionFieldset(key, byCriterion.get(key)),
	).join("\n      ");
	const savedNotice = saved
		? '<p class="ajr-config-saved">設定を保存し、全求人を再ランキングしました（AI は再実行していません）。</p>'
		: "";
	return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>評価条件の設定 — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>評価条件の設定</h1>
      <p>各項目の重み・希望値・ハードフィルタを設定します。保存すると保存済みの抽出結果のまま全求人を即再ランキングします（AI は再実行しません）。</p>
      ${savedNotice}
      <form method="post" action="/config">
      ${fieldsets}
        <button type="submit">保存して再ランキング</button>
      </form>
    </main>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// DB I/O（設定の読み書き）
// ---------------------------------------------------------------------------

// criteria_config 全行を読む（描画の初期値用）。
async function readCriteriaConfig(
	db: D1Database,
): Promise<CriteriaConfigRow[]> {
	const { results } = await db
		.prepare(
			`SELECT criterion, desired_value, weight, hard_filter, updated_at FROM ${TABLE_NAMES.criteriaConfig}`,
		)
		.all<CriteriaConfigRow>();
	return results;
}

// criteria_config 行群を upsert する（criterion を PK に冪等上書き）。updated_at は DB 既定に委ねる。
async function upsertConfigRows(
	db: D1Database,
	rows: readonly CriteriaConfigRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const stmt = db.prepare(
		`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES (?, ?, ?, ?)
		 ON CONFLICT(criterion) DO UPDATE SET
		   desired_value = excluded.desired_value,
		   weight = excluded.weight,
		   hard_filter = excluded.hard_filter,
		   updated_at = unixepoch()`,
	);
	await db.batch(
		rows.map((r) =>
			stmt.bind(r.criterion, r.desired_value, r.weight, r.hard_filter),
		),
	);
}

// ---------------------------------------------------------------------------
// ルート配線（app.ts へは最小配線・静的フォールスルーより前に評価）
// ---------------------------------------------------------------------------

export const criteriaForm = new Hono<{ Bindings: Bindings }>();

// 設定フォームを SSR で返す（保存済み設定を初期値に）。
criteriaForm.get("/config", async (c) => {
	const rows = await readCriteriaConfig(c.env.DB);
	return c.html(renderConfigForm(rows));
});

// 設定を保存し、保存済み抽出のまま全求人を即再ランキングする（AI 非実行・§5.3）。
criteriaForm.post("/config", async (c) => {
	const form = await c.req.parseBody();
	// parseBody は string|File を返す。文字列のみ採用し、それ以外は空に倒す。
	const values: Record<string, string> = {};
	for (const [k, v] of Object.entries(form)) {
		if (typeof v === "string") values[k] = v;
	}

	const parsed = formToConfigRows(values);
	if (!parsed.ok) {
		// 不正入力は保存・再スコアリングの前に弾く（コスト保護・決定性）。
		return c.json({ ok: false, reason: parsed.reason }, 400);
	}

	await upsertConfigRows(c.env.DB, parsed.rows);
	// 設定変更のトリガで決定的に全 job を再スコアリングする（#20）。AI は呼ばない。
	await rescoreAll(c.env.DB);

	// 保存後は最新設定でフォームを再描画し、再ランキング完了を通知する。
	const rows = await readCriteriaConfig(c.env.DB);
	return c.html(renderConfigForm(rows, true));
});
