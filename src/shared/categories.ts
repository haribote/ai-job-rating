// 5軸カテゴリ ↔ 採点項目（正規キー）の対応の単一ソース（設計書 §5.1・実装計画 Task 8 / #101）。
//
// なぜこのモジュールが存在するか:
// - スコアリングの内訳・レーダー（Wave3 UI）・企業評判合流（#24）が「どの正規キーがどの軸に
//   属するか」を一貫して参照できるよう、対応表を 1 箇所に集約する。後続 UI/評判はここを消費する。
// - 5軸 = compensation / integrity / flexibility / role / company。この公開型・定数を安定させる。
// - 表示名（ラベル）は CATEGORY_LABELS に分離し、integrity の表示名が未確定でも後日差し替え
//   できる構造にする（内部カテゴリキー integrity は固定、表示文字列のみ変更可能）。

import { NORMALIZED_KEYS, type NormalizedKey } from "./job-schema";

// 5軸カテゴリキー（内部キー・安定）。表示名とは独立に保つ。
export type CategoryKey =
	| "compensation"
	| "integrity"
	| "flexibility"
	| "role"
	| "company";

// 軸の表示順（レーダー・内訳の決定的順序）。型の単一ソースとして satisfies で同期する。
export const CATEGORY_KEYS = [
	"compensation",
	"integrity",
	"flexibility",
	"role",
	"company",
] as const satisfies readonly CategoryKey[];

// 正規キー → 所属軸の対応（単一ソース）。全 NormalizedKey が必ず 1 軸に属する（型で網羅）。
export const CATEGORY_OF: Record<NormalizedKey, CategoryKey> = {
	// 報酬
	annualSalary: "compensation",
	bonus: "compensation",
	// 従業員への誠実さ
	overtime: "integrity",
	annualHolidays: "integrity",
	benefitsCoverage: "integrity",
	// 柔軟な働き方
	remoteWork: "flexibility",
	flexWork: "flexibility",
	// 仕事・スキル
	skillMatch: "role",
	// 企業（口コミ評判は正規キーでなく、company 軸への集約時に 1 項目として合流する・#117/#36）
	companySize: "company",
	capital: "company",
};

// 軸の表示名（UI ラベル）。integrity の表示名は未確定（候補: 働きやすさ／待遇の手厚さ）。
// 内部キーは integrity 固定で、ここの文字列のみ後日差し替える（#101 申し送り）。
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
	compensation: "報酬",
	integrity: "従業員への誠実さ",
	flexibility: "柔軟な働き方",
	role: "仕事・スキル",
	company: "企業",
};

// 軸 → 所属する正規キー一覧（CATEGORY_OF から決定的に導出・NORMALIZED_KEYS 順）。
// レーダー/内訳が「軸ごとの項目」を引くための逆引き。CATEGORY_OF を単一ソースに保つため導出する。
export const KEYS_BY_CATEGORY: Record<CategoryKey, readonly NormalizedKey[]> =
	(() => {
		const map: Record<CategoryKey, NormalizedKey[]> = {
			compensation: [],
			integrity: [],
			flexibility: [],
			role: [],
			company: [],
		};
		for (const key of NORMALIZED_KEYS) {
			map[CATEGORY_OF[key]].push(key);
		}
		return map;
	})();

// 正規キーの所属軸を引く（決定的）。
export function categoryOf(key: NormalizedKey): CategoryKey {
	return CATEGORY_OF[key];
}
