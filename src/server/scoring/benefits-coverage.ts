// 福利厚生 充足率（benefitsCoverage）の canonical 閉集合・signal 検出・充足率算出（設計書 §5.2・#102）。
//
// なぜこのモジュールが存在するか:
// - 労働者にメリットのある制度・待遇を canonical 閉集合として固定し、求人本文に現れた signal の
//   充足率（該当数/総数）で決定的に採点する。閉集合に限定することで、記載過多なページを
//   「多いほど高得点」で過大評価するのを抑える（設計書 §5.2）。
// - 閉集合の定義は抽出（signal 検出）と採点（総数=分母）の両方が参照する単一ソース。抽出は
//   この検出器で boolean 集合を作って保存し、採点は保存済み集合から充足率を算出する（§5.3 分離）。
// - holidaySystem / retirementAllowance は独立キーを廃止し、本閉集合の signal として吸収する（#101）。

import { canonicalizeLabel } from "../../shared/job-schema";

// canonical signal キー（閉集合）。フォーク先で増減できるよう列挙を単一ソースに保つ。
export type BenefitSignalKey =
	// 休日制度
	| "twoDayWeekoff"
	| "completeTwoDayWeekoff"
	| "fourWeekEightOff"
	// 休暇制度
	| "paidLeave"
	| "condolenceLeave"
	| "seasonalLeave"
	| "refreshLeave"
	| "familyCareLeave"
	| "specialLeave"
	| "nursingLeave"
	// その他福利厚生
	| "retirementAllowance"
	| "allowances"
	| "trainingSupport"
	| "healthCare"
	| "equityProgram"
	| "sideJob"
	| "socialInsurance"
	| "parentalRecord"
	| "shorterHours"
	| "companyHousing";

// 該当した signal の集合。抽出が生成し採点が消費する（present/total の present 側）。
export type BenefitSignalSet = ReadonlySet<BenefitSignalKey>;

// signal 定義: canonical キー ＋ 検出 needle（生 JP 部分文字列）。
// needle は canonicalizeLabel 適用後の haystack に対し部分一致で照合する（全角/半角・区切り記号を吸収）。
interface BenefitSignal {
	readonly key: BenefitSignalKey;
	readonly needles: readonly string[];
}

// canonical 閉集合の初期セット（設計書 §5.2）。フォーク先で増減可。
// なぜ needle を複数持つか: 求人サイトごとの表記揺れ（育児休暇/育児休業 等）を 1 signal へ寄せるため。
// 否定誤検出を避けるため、肯定形に固有の stem を needle にする（例: sideJob は「副業可」で「副業不可」を拾わない）。
export const BENEFIT_SIGNALS: readonly BenefitSignal[] = [
	// 休日制度。完全週休2日制は「週休2日」も内包するため completeTwoDayWeekoff と twoDayWeekoff の
	// 双方が立つ → 充足率上は完全版が自然に高評価になる（設計書「完全週休2日制を高評価」を加点で表現）。
	{ key: "twoDayWeekoff", needles: ["週休2日", "週休二日"] },
	{ key: "completeTwoDayWeekoff", needles: ["完全週休2日", "完全週休二日"] },
	{ key: "fourWeekEightOff", needles: ["4週8休", "四週八休"] },
	// 休暇制度
	{ key: "paidLeave", needles: ["有給", "年次有給"] },
	{ key: "condolenceLeave", needles: ["慶弔"] },
	{ key: "seasonalLeave", needles: ["夏季休暇", "夏期休暇", "年末年始"] },
	{ key: "refreshLeave", needles: ["リフレッシュ休暇", "長期休暇"] },
	// 育児・介護休暇。「育休」単独は parentalRecord の「産休育休」と二重計上になるため含めない。
	{ key: "familyCareLeave", needles: ["育児休", "介護休"] },
	{ key: "specialLeave", needles: ["特別休暇"] },
	{ key: "nursingLeave", needles: ["看護休暇"] },
	// その他福利厚生
	{ key: "retirementAllowance", needles: ["退職金"] },
	{
		key: "allowances",
		needles: ["住宅手当", "家族手当", "通勤手当", "役職手当", "各種手当"],
	},
	{ key: "trainingSupport", needles: ["研修", "資格取得", "資格支援"] },
	{
		key: "healthCare",
		needles: ["人間ドック", "健康診断", "メンタルヘルス", "メンタルケア"],
	},
	{ key: "equityProgram", needles: ["持株会", "ストックオプション"] },
	{ key: "sideJob", needles: ["副業可", "副業ok", "兼業可"] },
	{
		key: "socialInsurance",
		needles: ["社会保険完備", "各種社会保険", "社会保険"],
	},
	{
		key: "parentalRecord",
		needles: ["産休育休", "育休取得実績", "産休取得実績"],
	},
	{ key: "shorterHours", needles: ["時短勤務", "短時間勤務"] },
	{ key: "companyHousing", needles: ["社宅", "独身寮", "社員寮"] },
];

// canonical signal キーの一覧（採点の総数=分母・反復用）。型と同期させる単一ソース。
export const BENEFIT_SIGNAL_KEYS: readonly BenefitSignalKey[] =
	BENEFIT_SIGNALS.map((s) => s.key);

// 重視 signal の重み。emphasis 指定された signal は分子・分母の双方で重く扱う
// （保有すれば加点が大きく、欠けば減点が大きい）。値はテストで境界を固定する。
const EMPHASIS_WEIGHT = 2;

// needle を canonicalize 済みで保持した検出テーブル（モジュール初期化時に一度だけ構築）。
const SIGNAL_NEEDLES: ReadonlyArray<
	readonly [BenefitSignalKey, readonly string[]]
> = BENEFIT_SIGNALS.map(
	(s) => [s.key, s.needles.map(canonicalizeLabel)] as const,
);

// 生抽出文字列から該当 signal の集合を検出する（決定的・閉集合限定）。
// 区切り記号や全角/半角の揺れは canonicalizeLabel で吸収し、needle の部分一致で判定する。
export function detectBenefitSignals(raw: string): Set<BenefitSignalKey> {
	const haystack = canonicalizeLabel(raw);
	const present = new Set<BenefitSignalKey>();
	for (const [key, needles] of SIGNAL_NEEDLES) {
		if (needles.some((n) => n !== "" && haystack.includes(n))) {
			present.add(key);
		}
	}
	return present;
}

// 充足率（0..100）を算出する（決定的）。emphasis を与えると当該 signal を重み付けする。
// 充足率 = Σ(該当 signal の重み) / Σ(全 signal の重み) ×100。emphasis 無指定なら該当数/総数 ×100。
// 閉集合外の emphasis キーは反復に現れず無害（充足率を変えない）。
export function computeBenefitsCoverage(
	present: BenefitSignalSet,
	emphasis: readonly BenefitSignalKey[] = [],
): number {
	const emphasized = new Set<BenefitSignalKey>(emphasis);
	let numerator = 0;
	let denominator = 0;
	for (const key of BENEFIT_SIGNAL_KEYS) {
		const weight = emphasized.has(key) ? EMPHASIS_WEIGHT : 1;
		denominator += weight;
		if (present.has(key)) numerator += weight;
	}
	return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
