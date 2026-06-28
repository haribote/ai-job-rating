// 求人の正規スキーマ（normalized schema）と正規化方式の定義（要件定義 §5.2 / §5.3）。
//
// なぜこのモジュールが存在するか:
// - 抽出フェーズの出力をサイト依存ラベルから「正規キー」へ寄せ、スコアリング層が
//   正規キーのみを参照できるようにする（§5.2 ラベル正規化）。
// - 値が取れない項目を unknown として表現し、スコアリングで加重合計の分母から
//   外せるようにする（§5.2 unknown 中立）。
// - 本モジュールは「スキーマ・正規化」のみを担い、スコア計算は行わない
//   （§5.3 抽出とスコアリングの分離）。

// ---------------------------------------------------------------------------
// 正規キー（normalized criterion keys）
// ---------------------------------------------------------------------------

// 正規キーの値型。5軸カテゴリ（報酬 / 従業員への誠実さ / 柔軟な働き方 / 仕事・スキル / 企業）の
// 採点項目に対応する（5軸 ↔ 項目の対応表は shared/categories.ts が単一ソース）。
// スコアリング（#12）はこのキー集合のみを参照する。フォーク先で増減できるよう union 型で一元管理する。
// 5軸への削減・再カテゴリ化は #101（実装計画 Task 8）。削除キーは旧抽出に残っても unknown 中立で
// 自然に分母から外れる（移行は再抽出導線でカバー、設計書 §7）。
export type NormalizedKey =
	// 報酬 (compensation)
	| "annualSalary"
	| "bonus"
	// 従業員への誠実さ (integrity)
	| "overtime"
	| "annualHolidays"
	| "benefitsCoverage"
	// 柔軟な働き方 (flexibility)
	| "remoteWork"
	| "flexWork"
	// 仕事・スキル (role)
	| "skillMatch"
	// 企業 (company)
	| "companySize"
	| "capital";

// 正規キーの一覧（実行時の網羅・反復用）。型の単一ソースとして保つため satisfies で同期する。
export const NORMALIZED_KEYS = [
	"annualSalary",
	"bonus",
	"overtime",
	"annualHolidays",
	"benefitsCoverage",
	"remoteWork",
	"flexWork",
	"skillMatch",
	"companySize",
	"capital",
] as const satisfies readonly NormalizedKey[];

// ---------------------------------------------------------------------------
// 値の表現（unknown 中立）
// ---------------------------------------------------------------------------

// §5.2 の正規化類型。スコアリングはこの kind で算出方式を分岐する。
// coverage は benefitsCoverage（福利厚生の充足率）用（#101 で追加・設計書 §5.2）。
// skillMatch は categorical（求人スキル集合）で持ち、採点は config 側の keyword 突合で行う（#105）。
export type NormalizationKind = "numericRange" | "categorical" | "coverage";

// 数値レンジ値。レンジ求人は下限/上限で持ち、単一値は min === max で表す。
export interface NumericRangeValue {
	readonly kind: "numericRange";
	readonly min: number;
	readonly max: number;
	// 抽出元の生表記（例: "700万〜"）。監査・UI 表示用。スコアリングは参照しない。
	readonly raw?: string;
}

// カテゴリ値。正規化済みカテゴリ集合（例: リモート可否 → "full"/"partial"/"onsite"）。
export interface CategoricalValue {
	readonly kind: "categorical";
	readonly categories: readonly string[];
	readonly raw?: string;
}

// 充足率値（benefitsCoverage 用・設計書 §5.2）。canonical 閉集合のうち該当した signal 数（present）と
// 総数（total）を持ち、スコアは present / total（決定的）。canonical 集合の定義・signal 抽出は #102。
// signals は該当した signal キーの一覧（決定的順）。重視 signal 重みでの再採点・UI 内訳展開に使う。
// 設定変更での再スコアは AI を再実行せず保存済み signals から算出できる（§5.3 抽出とスコアリングの分離）。
export interface CoverageValue {
	readonly kind: "coverage";
	readonly present: number;
	readonly total: number;
	readonly signals?: readonly string[];
	readonly raw?: string;
}

// 値が取れない項目（§5.2 unknown 中立）。スコアリングで分母から外す目印になる。
export interface UnknownValue {
	readonly kind: "unknown";
	// 抽出元が "-" など未記載を返したときの生表記。デバッグ・UI「情報なし」表示用。
	readonly raw?: string;
	// 数量は読めないが「該当あり」と肯定的に明記されていたか（§5.2 unknown 中立の意図的例外）。
	// overtime の「有り明記だが定量なし」減点特例でのみ true を立てる。記載なし・否定（残業なし等）は
	// 未設定のまま＝従来通り中立。値（数量）自体は読めないため kind は unknown のまま保つ。
	readonly stated?: boolean;
}

// 正規キー1つに対する値。unknown を第一級で表現できることが本スキーマの肝。
export type NormalizedFieldValue =
	| NumericRangeValue
	| CategoricalValue
	| CoverageValue
	| UnknownValue;

// 正規化済み求人スキーマ。全正規キーを必須にし、取れない項目は UnknownValue で埋める。
// → スコアリングは「キーの欠落」を気にせず、kind === "unknown" だけで中立判定できる。
export type NormalizedJob = {
	readonly [K in NormalizedKey]: NormalizedFieldValue;
};

// ---------------------------------------------------------------------------
// unknown 判定（決定的）
// ---------------------------------------------------------------------------

// スコアリングが分母から外すべきかの単一判定点。値が unknown のときだけ true。
export function isUnknown(value: NormalizedFieldValue): value is UnknownValue {
	return value.kind === "unknown";
}

// 「有り明記だが定量なし」か（overtime 減点特例の単一判定点・§5.2 unknown 中立の意図的例外）。
// unknown かつ stated=true のときだけ true。スコアリングはこれを中立でなく減点として扱う。
export function isStatedUnquantified(value: NormalizedFieldValue): boolean {
	return value.kind === "unknown" && value.stated === true;
}

// 未記載を表す生表記の集合。求人ページは未記載を様々な記号で返す（§5.2）。
const UNKNOWN_RAW_TOKENS: ReadonlySet<string> = new Set([
	"",
	"-",
	"ー",
	"−",
	"–",
	"—",
	"なし",
	"記載なし",
	"未記載",
	"不明",
	"n/a",
	"na",
	"none",
	"null",
	"undefined",
]);

// 生の抽出文字列が「情報なし」を意味するか（決定的）。前後空白と大小文字を吸収する。
export function isUnknownRaw(raw: string | null | undefined): boolean {
	if (raw === null || raw === undefined) {
		return true;
	}
	return UNKNOWN_RAW_TOKENS.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// ラベル正規化（サイト依存ラベル → 正規キー）
// ---------------------------------------------------------------------------

// 正規化前のラベル文字列を比較用に整える。
// なぜ: 求人サイトごとに全角/半角・空白・記号が揺れるため、突き合わせ前に吸収する。
// 抽出側（extract.ts の categorical 照合）でも同方針の正規化が要るため export して共有する。
export function canonicalizeLabel(label: string): string {
	return label
		.normalize("NFKC") // 全角英数・記号を半角へ
		.trim()
		.toLowerCase()
		.replace(/[\s　・:：()（）[\]【】/／]/g, ""); // 区切り・装飾記号を除去
}

// サイト依存ラベル（揺れ）→ 正規キーの対応表。
// 値は canonicalizeLabel 適用後のキーで引けるよう、登録時に正規化する。
const LABEL_ALIASES: ReadonlyArray<readonly [string, NormalizedKey]> = [
	// 報酬 (compensation)
	["想定年収", "annualSalary"],
	["年収", "annualSalary"],
	["予定年収", "annualSalary"],
	["給与（年収）", "annualSalary"],
	["賞与", "bonus"],
	["ボーナス", "bonus"],
	// 従業員への誠実さ (integrity)
	["残業", "overtime"],
	["時間外労働", "overtime"],
	["みなし残業", "overtime"],
	["固定残業", "overtime"],
	["固定残業代", "overtime"],
	["年間休日", "annualHolidays"],
	["年間休日数", "annualHolidays"],
	// 福利厚生・休暇制度は benefitsCoverage の signal として吸収する（設計書 §5.2・#102 が充実化）。
	["福利厚生", "benefitsCoverage"],
	["待遇・福利厚生", "benefitsCoverage"],
	["休日制度", "benefitsCoverage"],
	["休日・休暇", "benefitsCoverage"],
	["休暇制度", "benefitsCoverage"],
	["退職金", "benefitsCoverage"],
	["退職金制度", "benefitsCoverage"],
	// 柔軟な働き方 (flexibility)
	["リモート", "remoteWork"],
	["リモートワーク", "remoteWork"],
	["リモート可否", "remoteWork"],
	["在宅勤務", "remoteWork"],
	["テレワーク", "remoteWork"],
	["フレックス", "flexWork"],
	["フレックスタイム", "flexWork"],
	// 仕事・スキル (role)。techStack/必須要件/歓迎要件を skillMatch へ統合する（設計書 §5.2・#106）。
	["技術スタック", "skillMatch"],
	["開発環境", "skillMatch"],
	["使用技術", "skillMatch"],
	["必須要件", "skillMatch"],
	["応募資格", "skillMatch"],
	["必須スキル", "skillMatch"],
	["歓迎要件", "skillMatch"],
	["歓迎スキル", "skillMatch"],
	// 企業 (company)
	["企業規模", "companySize"],
	["従業員数", "companySize"],
	["社員数", "companySize"],
	["資本金", "capital"],
];

// 正規化テーブル（canonicalize 済みキー → 正規キー）。モジュール初期化時に一度だけ構築。
const LABEL_LOOKUP: ReadonlyMap<string, NormalizedKey> = new Map(
	LABEL_ALIASES.map(([label, key]) => [canonicalizeLabel(label), key]),
);

// サイト依存ラベルを正規キーへ寄せる（§5.2 ラベル正規化）。
// 決定的: 同一ラベル → 常に同一の正規キー、未知ラベル → null。
export function normalizeLabel(label: string): NormalizedKey | null {
	return LABEL_LOOKUP.get(canonicalizeLabel(label)) ?? null;
}
