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

// 正規キーの値型。§5.1 のカテゴリ（報酬 / 働き方 / 勤務条件 / 仕事内容 / 企業属性）の
// 初期セットに対応する。スコアリング（#12）はこのキー集合のみを参照する。
// フォーク先で増減できるよう union 型で一元管理する。
export type NormalizedKey =
	// 報酬 (compensation)
	| "annualSalary"
	| "monthlySalary"
	| "bonus"
	| "salaryRaise"
	| "retirementAllowance"
	// 働き方・WLB (work-life balance)
	| "overtime"
	| "annualHolidays"
	| "holidaySystem"
	| "paidLeaveRate"
	| "remoteWork"
	| "flexWork"
	// 勤務条件 (working conditions)
	| "workLocation"
	| "employmentType"
	| "employmentTerm"
	// 仕事内容・スキル (role & skills)
	| "techStack"
	| "requiredSkillsMatch"
	| "preferredSkillsMatch"
	| "businessDomain"
	| "languageRequirement"
	// 企業属性 (company attributes)
	| "companySize"
	| "companyPhase";

// 正規キーの一覧（実行時の網羅・反復用）。型の単一ソースとして保つため satisfies で同期する。
export const NORMALIZED_KEYS = [
	"annualSalary",
	"monthlySalary",
	"bonus",
	"salaryRaise",
	"retirementAllowance",
	"overtime",
	"annualHolidays",
	"holidaySystem",
	"paidLeaveRate",
	"remoteWork",
	"flexWork",
	"workLocation",
	"employmentType",
	"employmentTerm",
	"techStack",
	"requiredSkillsMatch",
	"preferredSkillsMatch",
	"businessDomain",
	"languageRequirement",
	"companySize",
	"companyPhase",
] as const satisfies readonly NormalizedKey[];

// ---------------------------------------------------------------------------
// 値の表現（unknown 中立）
// ---------------------------------------------------------------------------

// §5.2 の正規化3類型。スコアリングはこの kind で算出方式を分岐する。
export type NormalizationKind = "numericRange" | "categorical" | "aiJudged";

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

// AI判定値。抽出フェーズで 0〜100 相当の判定値として得る（§5.2 AI判定）。
export interface AiJudgedValue {
	readonly kind: "aiJudged";
	readonly score: number;
	readonly raw?: string;
}

// 値が取れない項目（§5.2 unknown 中立）。スコアリングで分母から外す目印になる。
export interface UnknownValue {
	readonly kind: "unknown";
	// 抽出元が "-" など未記載を返したときの生表記。デバッグ・UI「情報なし」表示用。
	readonly raw?: string;
}

// 正規キー1つに対する値。unknown を第一級で表現できることが本スキーマの肝。
export type NormalizedFieldValue =
	| NumericRangeValue
	| CategoricalValue
	| AiJudgedValue
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
	// 報酬
	["想定年収", "annualSalary"],
	["年収", "annualSalary"],
	["予定年収", "annualSalary"],
	["給与（年収）", "annualSalary"],
	["月給", "monthlySalary"],
	["基本給", "monthlySalary"],
	["月収", "monthlySalary"],
	["賞与", "bonus"],
	["ボーナス", "bonus"],
	["昇給", "salaryRaise"],
	["退職金", "retirementAllowance"],
	["退職金制度", "retirementAllowance"],
	// 働き方・WLB
	["残業", "overtime"],
	["時間外労働", "overtime"],
	["みなし残業", "overtime"],
	["固定残業", "overtime"],
	["固定残業代", "overtime"],
	["年間休日", "annualHolidays"],
	["年間休日数", "annualHolidays"],
	["休日制度", "holidaySystem"],
	["休日・休暇", "holidaySystem"],
	["休日", "holidaySystem"],
	["有給取得率", "paidLeaveRate"],
	["有給休暇取得率", "paidLeaveRate"],
	["有休取得率", "paidLeaveRate"],
	["リモート", "remoteWork"],
	["リモートワーク", "remoteWork"],
	["リモート可否", "remoteWork"],
	["在宅勤務", "remoteWork"],
	["テレワーク", "remoteWork"],
	["フレックス", "flexWork"],
	["フレックスタイム", "flexWork"],
	["裁量労働", "flexWork"],
	["裁量労働制", "flexWork"],
	// 勤務条件
	["勤務地", "workLocation"],
	["勤務場所", "workLocation"],
	["就業場所", "workLocation"],
	["雇用形態", "employmentType"],
	["雇用期間", "employmentTerm"],
	["契約期間", "employmentTerm"],
	// 仕事内容・スキル
	["技術スタック", "techStack"],
	["開発環境", "techStack"],
	["使用技術", "techStack"],
	["必須要件", "requiredSkillsMatch"],
	["応募資格", "requiredSkillsMatch"],
	["必須スキル", "requiredSkillsMatch"],
	["歓迎要件", "preferredSkillsMatch"],
	["歓迎スキル", "preferredSkillsMatch"],
	["尚可", "preferredSkillsMatch"],
	["業界", "businessDomain"],
	["事業ドメイン", "businessDomain"],
	["事業内容", "businessDomain"],
	["言語要件", "languageRequirement"],
	["語学", "languageRequirement"],
	["英語", "languageRequirement"],
	// 企業属性
	["企業規模", "companySize"],
	["従業員数", "companySize"],
	["社員数", "companySize"],
	// companyPhase は「上場区分」に意味を確定する（#88）。設立年（数値概念）は
	// categorical の本キーと型が異なり「正解」を不定にするため、エイリアスに含めない。
	["企業フェーズ", "companyPhase"],
	["上場区分", "companyPhase"],
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
