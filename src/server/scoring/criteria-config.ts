// criteria_config 行（D1）→ ScoringConfig への決定的マッピング（#16→#20）。
//
// なぜこのモジュールが存在するか:
// - 再スコアリングは保存済みの criteria_config（重み・希望値・ハードフィルタ）だけを読み、
//   AI を再実行せず決定的に scores を再計算する（§5.3 抽出とスコアリングの分離）。
// - criteria_config.desired_value は kind 依存のため JSON 文字列で保持される（#16）。
//   どの正規キーがどの kind かは DB に持たないため、本モジュールの NORMALIZED_KEY_KINDS を
//   単一ソースとして参照し、desired_value JSON を kind ごとに解釈する。
// - 解釈は純粋関数。DB アクセス・AI 呼び出しは持たない（責務分離 §9）。

import type { NormalizedKey } from "../../shared/job-schema";
import type { CriteriaConfigRow, HardFilter } from "../storage/db-schema";
import type {
	NumericDirection,
	ScoringConfig,
	ScoringItemConfig,
} from "./score";

// ---------------------------------------------------------------------------
// 正規キーごとの kind レジストリ（単一ソース）
// ---------------------------------------------------------------------------

// 正規キーがどの算出方式（kind）かを一元管理する。criteria_config は kind を持たないため、
// desired_value JSON の解釈・既定設定の生成・ハードフィルタ判定はすべてここを参照する。
// numericRange のみ方向（higher/lower better）が要るため direction も併せて持つ。
// フォーク先・後続フェーズ（#7 設定UI）はこのレジストリを差し替えるだけで項目を増減できる。
export type NormalizedKeyKind =
	| { readonly kind: "numericRange"; readonly direction: NumericDirection }
	| { readonly kind: "categorical" }
	| { readonly kind: "aiJudged" }
	| { readonly kind: "coverage" };

// 正規キー → kind の対応。NormalizedKey の全キーを網羅する（型で担保）。5軸再カテゴリ化は #101。
export const NORMALIZED_KEY_KINDS: Record<NormalizedKey, NormalizedKeyKind> = {
	// 報酬: 高いほど良い。
	annualSalary: { kind: "numericRange", direction: "higherBetter" },
	bonus: { kind: "numericRange", direction: "higherBetter" },
	// 従業員への誠実さ: 残業は低いほど良い、年間休日は高いほど良い、福利厚生は充足率。
	overtime: { kind: "numericRange", direction: "lowerBetter" },
	annualHolidays: { kind: "numericRange", direction: "higherBetter" },
	benefitsCoverage: { kind: "coverage" },
	// 柔軟な働き方。
	remoteWork: { kind: "categorical" },
	flexWork: { kind: "categorical" },
	// 仕事・スキル。希望キーワードとの AI 非依存の決定的突合（aiJudged 機構を流用・#106 で keyword 化）。
	skillMatch: { kind: "aiJudged" },
	// 企業: 規模・資本金は高いほど良い。
	companySize: { kind: "numericRange", direction: "higherBetter" },
	capital: { kind: "numericRange", direction: "higherBetter" },
};

// ---------------------------------------------------------------------------
// desired_value JSON の形（kind ごと）
// ---------------------------------------------------------------------------

// numericRange の desired_value: 希望値と反対端（floor/ceil）。
// 例: 年収 → { "desired": 700, "floor": 300 } / 残業 → { "desired": 10, "ceil": 45 }。
interface NumericDesiredValue {
	readonly desired: number;
	readonly floor?: number;
	readonly ceil?: number;
}

// categorical の desired_value: 歓迎するカテゴリ集合。
// 例: リモート可否 → { "preferred": ["full", "partial"] }。
interface CategoricalDesiredValue {
	readonly preferred: readonly string[];
}

// aiJudged の desired_value: 希望スキル集合（#68）。スコアリング側で求人スキルと突合する。
// 例: 必須スキル適合 → { "skills": ["go", "typescript"] }。
interface SkillsDesiredValue {
	readonly skills: readonly string[];
}

// coverage の desired_value: 重視する benefitsCoverage signal 集合（#102）。
// 例: 福利厚生充足率 → { "emphasis": ["completeTwoDayWeekoff", "retirementAllowance"] }。
interface CoverageDesiredValue {
	readonly emphasis: readonly string[];
}

// 型ガード（決定的・実行時検証）。不正な JSON は評価不能として扱えるよう false を返す。
function isNumericDesiredValue(v: unknown): v is NumericDesiredValue {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.desired === "number";
}

function isCategoricalDesiredValue(v: unknown): v is CategoricalDesiredValue {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		Array.isArray(o.preferred) &&
		o.preferred.every((p) => typeof p === "string")
	);
}

function isSkillsDesiredValue(v: unknown): v is SkillsDesiredValue {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		Array.isArray(o.skills) && o.skills.every((s) => typeof s === "string")
	);
}

function isCoverageDesiredValue(v: unknown): v is CoverageDesiredValue {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		Array.isArray(o.emphasis) && o.emphasis.every((e) => typeof e === "string")
	);
}

// desired_value(JSON 文字列|null) を構造化値へ復元する（不正・null は null）。
// 取得/詳細 API（GET /api/config・GET /api/jobs/:id）の表示用。スコアリング内部の
// parseDesiredValue（不在を undefined で表す）とは sentinel が異なるため別関数にする。
export function parseDesired(raw: string | null): unknown {
	if (raw == null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// desired_value(JSON 文字列|null) を安全に parse する。不正・null は undefined。
function parseDesiredValue(raw: string | null): unknown {
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// criteria_config 行 → ScoringItemConfig（1 項目）
// ---------------------------------------------------------------------------

// 1 行を ScoringItemConfig へ変換する（決定的）。
// 正規キーでない criterion（'__total__' 等の番兵を含む）・desired_value が kind と
// 整合しない行は null を返し、呼び出し側が設定から除外する（評価不能 = 中立）。
export function criteriaRowToItemConfig(
	row: CriteriaConfigRow,
): ScoringItemConfig | null {
	const keyKind = NORMALIZED_KEY_KINDS[row.criterion as NormalizedKey];
	if (keyKind === undefined) return null;

	switch (keyKind.kind) {
		case "numericRange": {
			const dv = parseDesiredValue(row.desired_value);
			if (!isNumericDesiredValue(dv)) return null;
			return {
				weight: row.weight,
				kind: "numericRange",
				direction: keyKind.direction,
				desired: dv.desired,
				...(dv.floor !== undefined ? { floor: dv.floor } : {}),
				...(dv.ceil !== undefined ? { ceil: dv.ceil } : {}),
			};
		}
		case "categorical": {
			const dv = parseDesiredValue(row.desired_value);
			if (!isCategoricalDesiredValue(dv)) return null;
			return {
				weight: row.weight,
				kind: "categorical",
				preferred: dv.preferred,
			};
		}
		case "aiJudged":
			// aiJudged は希望値を desired_value に持たない（突合は抽出側の score に集約、#68）。
			return { weight: row.weight, kind: "aiJudged" };
		case "coverage": {
			// coverage の充足率は抽出済みの signal 集合から算出する。重視 signal があれば重み付けする（#102）。
			const dv = parseDesiredValue(row.desired_value);
			if (isCoverageDesiredValue(dv) && dv.emphasis.length > 0) {
				return { weight: row.weight, kind: "coverage", emphasis: dv.emphasis };
			}
			return { weight: row.weight, kind: "coverage" };
		}
	}
}

// ---------------------------------------------------------------------------
// criteria_config 行群 → ScoringConfig
// ---------------------------------------------------------------------------

// criteria_config 全行から ScoringConfig を組み立てる（決定的）。
// criterion をキーに昇順ソートしてから走査することで、scoreJob の breakdown 順序を
// 行の取得順に依存させない（同一設定→同一スコア・同一内訳順、§8）。
export function buildScoringConfig(
	rows: readonly CriteriaConfigRow[],
): ScoringConfig {
	const items: Partial<Record<NormalizedKey, ScoringItemConfig>> = {};
	const sorted = [...rows].sort((a, b) =>
		a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0,
	);
	for (const row of sorted) {
		const itemConfig = criteriaRowToItemConfig(row);
		if (itemConfig === null) continue;
		items[row.criterion as NormalizedKey] = itemConfig;
	}
	return { items };
}

// ---------------------------------------------------------------------------
// aiJudged の希望スキル集合（#68 拡張点）
// ---------------------------------------------------------------------------

// aiJudged 項目ごとの希望スキル集合。求人スキルとの突合（skill-matcher）に渡す。
// ScoringItemConfig に載せないのは、score.ts が希望集合を参照せず（aiJudged は weight のみ）、
// 突合は rescore-core の拡張点で行うため。希望集合の在り処をここに一元化する（§5.3）。
export type DesiredSkillsMap = Partial<
	Record<NormalizedKey, readonly string[]>
>;

// criteria_config から aiJudged キーの希望スキル集合を抽出する（決定的）。
// desired_value({skills:[...]}) を持つ aiJudged 行だけを拾う。skills 不在・壊れた JSON・
// aiJudged でないキーは持たない（= 未設定。matcher 側で中立扱い）。
export function buildDesiredSkills(
	rows: readonly CriteriaConfigRow[],
): DesiredSkillsMap {
	const map: Record<string, readonly string[]> = {};
	for (const row of rows) {
		const keyKind = NORMALIZED_KEY_KINDS[row.criterion as NormalizedKey];
		if (keyKind?.kind !== "aiJudged") continue;
		const dv = parseDesiredValue(row.desired_value);
		if (!isSkillsDesiredValue(dv)) continue;
		map[row.criterion] = dv.skills;
	}
	return map;
}

// ---------------------------------------------------------------------------
// ハードフィルタ（criterion → hard_filter）の抽出
// ---------------------------------------------------------------------------

// 正規キーごとのハードフィルタ設定。none の行は持たない（スコアのみ）。
export type HardFilterMap = Partial<Record<NormalizedKey, HardFilter>>;

// criteria_config から none 以外のハードフィルタだけを抽出する（決定的）。
export function buildHardFilterMap(
	rows: readonly CriteriaConfigRow[],
): HardFilterMap {
	const map: HardFilterMap = {};
	for (const row of rows) {
		if (row.hard_filter === "none") continue;
		if (NORMALIZED_KEY_KINDS[row.criterion as NormalizedKey] === undefined) {
			continue;
		}
		map[row.criterion as NormalizedKey] = row.hard_filter;
	}
	return map;
}
