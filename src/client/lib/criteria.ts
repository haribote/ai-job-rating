// 設定ビュー（#114）の決定的変換とメタデータ。
//
// なぜ存在するか:
// - GET /api/config の item（保存済み JSON 形）↔ フォーム編集状態 ↔ PUT /api/config の入力、という
//   3 形態の相互変換を純関数に閉じ、CriteriaForm（DOM 結合）から切り離して単体テスト可能にする（§9）。
// - 設計ガードレール（抽出↔スコア分離・unknown 中立・ラベル正規化）は API 側の責務。本モジュールは
//   契約（criterion = NormalizedKey 一貫消費）を消費するだけで再実装しない。PUT は AI を呼ばない。
// - kind ごとの希望値（desired）の形はサーバ criteria-config.ts が単一ソース。本モジュールはその形へ
//   寄せるだけ。numericRange の方向（floor/ceil）のみ GET 契約に含まれないため、表示メタとして mirror する。

import type { NormalizedKey } from "../../shared/job-schema";
import type { ApiClient } from "./api";
import { apiGet, apiPut } from "./api";

// ---------------------------------------------------------------------------
// 契約型（client 側定義。server は別バンドルのため import 不可）
// ---------------------------------------------------------------------------

export type CriterionKind =
	| "numericRange"
	| "categorical"
	| "keywordMatch"
	| "coverage";

export type HardFilter = "none" | "required" | "exclude";

// GET /api/config の 1 項目（全正規キーぶん返る）。desired は kind 依存の保存済み JSON 形。
export interface CriteriaConfigItem {
	readonly criterion: NormalizedKey;
	readonly kind: CriterionKind;
	readonly weight: number;
	readonly hardFilter: HardFilter;
	readonly desired: unknown;
}

// PUT /api/config の 1 入力。desired は未指定で希望値なし（評価不能 = 中立 §5.2）。
export interface CriteriaConfigInput {
	readonly criterion: NormalizedKey;
	readonly weight: number;
	readonly hardFilter: HardFilter;
	readonly desired?: unknown;
}

// ---------------------------------------------------------------------------
// 表示メタデータ（client 専用 UI。スコアリングはサーバ registry を参照する）
// ---------------------------------------------------------------------------

// numericRange は方向（高い/低いほど良い）で反対端のキーが決まる。GET 契約に方向は含まれないため、
// サーバ NORMALIZED_KEY_KINDS の方向を表示メタとして mirror する（ドリフトは criteria.test.ts が検知）。
interface NumericMeta {
	readonly kind: "numericRange";
	readonly label: string;
	readonly unit: string;
	readonly boundKey: "floor" | "ceil";
	readonly boundLabel: string;
}

interface CategoricalMeta {
	readonly kind: "categorical";
	readonly label: string;
	readonly options: readonly {
		readonly value: string;
		readonly label: string;
	}[];
}

interface KeywordMeta {
	readonly kind: "keywordMatch";
	readonly label: string;
	readonly placeholder: string;
}

interface CoverageMeta {
	readonly kind: "coverage";
	readonly label: string;
	readonly placeholder: string;
}

export type CriterionMeta =
	| NumericMeta
	| CategoricalMeta
	| KeywordMeta
	| CoverageMeta;

// 正規キー → 表示メタ。5軸の所属は shared/categories.ts が単一ソース（フォームはそちらで群化する）。
export const CRITERION_META: Record<NormalizedKey, CriterionMeta> = {
	annualSalary: {
		kind: "numericRange",
		label: "想定年収",
		unit: "万円",
		boundKey: "floor",
		boundLabel: "下限",
	},
	bonus: {
		kind: "numericRange",
		label: "賞与",
		unit: "万円",
		boundKey: "floor",
		boundLabel: "下限",
	},
	overtime: {
		kind: "numericRange",
		label: "残業時間",
		unit: "時間/月",
		boundKey: "ceil",
		boundLabel: "上限",
	},
	annualHolidays: {
		kind: "numericRange",
		label: "年間休日",
		unit: "日",
		boundKey: "floor",
		boundLabel: "下限",
	},
	benefitsCoverage: {
		kind: "coverage",
		label: "福利厚生の充実",
		placeholder: "重視する制度（例: retirementAllowance, childcareLeave）",
	},
	remoteWork: {
		kind: "categorical",
		label: "リモートワーク",
		options: [
			{ value: "full", label: "フルリモート" },
			{ value: "partial", label: "一部リモート" },
			{ value: "onsite", label: "出社" },
		],
	},
	flexWork: {
		kind: "categorical",
		label: "フレックス",
		options: [{ value: "flex", label: "フレックスあり" }],
	},
	skillMatch: {
		kind: "keywordMatch",
		label: "スキル適合",
		placeholder: "希望スキル（例: go, typescript）",
	},
	companySize: {
		kind: "numericRange",
		label: "企業規模",
		unit: "人",
		boundKey: "floor",
		boundLabel: "下限",
	},
	capital: {
		kind: "numericRange",
		label: "資本金",
		unit: "万円",
		boundKey: "floor",
		boundLabel: "下限",
	},
};

// ---------------------------------------------------------------------------
// フォーム編集状態（kind 判別共用体）
// ---------------------------------------------------------------------------

interface BaseRow {
	readonly criterion: NormalizedKey;
	// input は文字列で持ち、PUT 構築時に数値へ確定する（編集中の中間状態を許容）。
	readonly weight: string;
	readonly hardFilter: HardFilter;
}

export type CriteriaFormRow =
	| (BaseRow & {
			readonly kind: "numericRange";
			readonly desired: string;
			readonly bound: string;
			readonly boundKey: "floor" | "ceil";
	  })
	| (BaseRow & {
			readonly kind: "categorical";
			readonly preferred: readonly string[];
	  })
	| (BaseRow & { readonly kind: "keywordMatch"; readonly keywords: string })
	| (BaseRow & { readonly kind: "coverage"; readonly emphasis: string });

// ---------------------------------------------------------------------------
// 変換（決定的・純関数）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: null;
}

function numToStr(v: unknown): string {
	return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function stringArray(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: [];
}

// カンマ/空白区切りの自由入力を正規化（trim・空除去・重複除去・順序保持）。
function splitList(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of raw.split(/[,\s]+/)) {
		const t = token.trim();
		if (t === "" || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

// 数値文字列を有限数へ。空・非数は null（希望値なし = 中立）。
function parseFiniteOrNull(raw: string): number | null {
	if (raw.trim() === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

// GET 契約 item → フォーム編集状態。
export function itemToFormRow(item: CriteriaConfigItem): CriteriaFormRow {
	const base: BaseRow = {
		criterion: item.criterion,
		weight: String(item.weight),
		hardFilter: item.hardFilter,
	};
	const meta = CRITERION_META[item.criterion];
	const desired = asRecord(item.desired);
	switch (item.kind) {
		case "numericRange": {
			const boundKey = meta.kind === "numericRange" ? meta.boundKey : "floor";
			return {
				...base,
				kind: "numericRange",
				boundKey,
				desired: numToStr(desired?.desired),
				bound: numToStr(desired?.[boundKey]),
			};
		}
		case "categorical":
			return {
				...base,
				kind: "categorical",
				preferred: stringArray(desired?.preferred),
			};
		case "keywordMatch":
			return {
				...base,
				kind: "keywordMatch",
				keywords: stringArray(desired?.keywords).join(", "),
			};
		case "coverage":
			return {
				...base,
				kind: "coverage",
				emphasis: stringArray(desired?.emphasis).join(", "),
			};
	}
}

// フォーム編集状態 → PUT 入力。kind ごとに desired を整形する。空は希望値なし（中立）。
export function formRowToInput(row: CriteriaFormRow): CriteriaConfigInput {
	const weight = Number(row.weight);
	const base = { criterion: row.criterion, weight, hardFilter: row.hardFilter };
	switch (row.kind) {
		case "numericRange": {
			const desired = parseFiniteOrNull(row.desired);
			if (desired === null) return base;
			const value: Record<string, number> = { desired };
			const bound = parseFiniteOrNull(row.bound);
			if (bound !== null) value[row.boundKey] = bound;
			return { ...base, desired: value };
		}
		case "categorical":
			return row.preferred.length === 0
				? base
				: { ...base, desired: { preferred: [...row.preferred] } };
		case "keywordMatch": {
			const keywords = splitList(row.keywords);
			return keywords.length === 0 ? base : { ...base, desired: { keywords } };
		}
		case "coverage": {
			const emphasis = splitList(row.emphasis);
			return emphasis.length === 0 ? base : { ...base, desired: { emphasis } };
		}
	}
}

// ---------------------------------------------------------------------------
// API 呼び出し（薄いラッパ。fetch は api クライアント経由で注入可能）
// ---------------------------------------------------------------------------

interface ConfigResponse {
	readonly items: CriteriaConfigItem[];
}

export interface RescoreResult {
	readonly status: "rescored";
	readonly count: number;
}

export async function fetchConfig(
	get: ApiClient["get"] = apiGet,
): Promise<CriteriaConfigItem[]> {
	const res = await get<ConfigResponse>("/config");
	return res.items;
}

// 設定保存。PUT のみ＝再スコアのトリガ（サーバが決定的に再採点）。AI は再実行しない（§5.3）。
export async function saveConfig(
	inputs: readonly CriteriaConfigInput[],
	put: ApiClient["put"] = apiPut,
): Promise<RescoreResult> {
	return put<RescoreResult>("/config", { items: inputs });
}

// ---------------------------------------------------------------------------
// 企業評判 対象サイト（評判機能 #30–#37 は未実装のため、設定値の保存のみ）
// ---------------------------------------------------------------------------

const REPUTATION_SITES_KEY = "ai-job-rating:reputation-sites";

// 改行・カンマ区切りの自由入力 → サイト集合（trim・空除去・重複除去）。
export function parseSitesInput(raw: string): string[] {
	return splitList(raw.replace(/\n/g, " "));
}

// 評判 対象サイトを永続化（フォーク容易性: 既定は空。アカウント固有値を直書きしない）。
export function loadReputationSites(storage: Storage = localStorage): string[] {
	try {
		const raw = storage.getItem(REPUTATION_SITES_KEY);
		return raw ? stringArray(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

export function saveReputationSites(
	sites: readonly string[],
	storage: Storage = localStorage,
): void {
	try {
		storage.setItem(REPUTATION_SITES_KEY, JSON.stringify(sites));
	} catch {
		// localStorage 不可（プライベートモード等）でも設定保存の主経路は阻害しない。
	}
}
