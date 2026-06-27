// 取得 HTML → 抽出入力のコンテンツ準備（#107 / 実装計画 Task 14・要件 §7.1）。
//
// なぜこのモジュールが存在するか:
// - 単純 trimHtml だけでは長文ページで入力トークンが膨らみ、incumbent の実効 context（#15: 24k）超過や
//   504 を招く。本文を予算内へ切り詰めつつ、benefitsCoverage / annualHolidays に必要な
//   福利厚生・休日・休暇セクションを落とさないための「セクション保持つきトリミング」を担う。
// - 重い benefits 集合は分割パス（主パス＋benefits パス）で抽出し、context 超過/504 を回避する。
//   分割の判断・入力組み立て・統合は決定的にしてユニットテスト可能に保つ（live 推論は extractJob 側）。

import {
	isUnknown,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "../../shared/job-schema";
import { trimHtml } from "./trim-html";

// 主パスの文字予算（既定）。これを超える長文のみ切り詰め＋分割パスの対象にする。
// なぜ文字数か: トークン数はモデル依存で決定的に測れない。日本語求人は概ね 1 文字 ≦ 1 トークンで、
// 文字予算は安全側（トークンはこれ以下）に効く。典型的な求人ページ（数千字）は予算内で素通りし、
// golden 入力を変えない（回帰させない）。フォーク先は maxChars で上書きできる（§8）。
export const DEFAULT_MAIN_MAX_CHARS = 12000;

// 福利厚生/休日/休暇セクションの開始を示す語（trimHtml 後のプレーンテキスト行に対して部分一致）。
// なぜこの集合か: benefitsCoverage / annualHolidays の抽出に必要な記載を取りこぼさないため。
// 過不足は golden で検証する（語を増やしすぎると主パスへ無関係行が混ざり token 削減効果が薄れる）。
const BENEFIT_SECTION_KEYWORDS: readonly string[] = [
	"福利厚生",
	"待遇",
	"手当",
	"保険",
	"退職金",
	"賞与",
	"休日",
	"休暇",
	"年間休日",
	"産休",
	"育休",
	"介護休",
	"リモート",
	"在宅",
	"フレックス",
	"裁量労働",
	"研修",
	"制度",
];

// セクション見出し行にぶら下がる箇条書き等を取り込むための後続行数。
// なぜ固定窓か: HTML 構造に依存せず決定的に「見出し＋直後のリスト」を拾える最小の手段。
const SECTION_CONTEXT_LINES = 8;

// benefits パスの結果で上書きする正規キー（分割パス統合の対象）。
// 福利厚生・年間休日は benefits セクションに集中するため、benefits パスの値を優先する。
export const BENEFIT_OVERLAY_KEYS: readonly NormalizedKey[] = [
	"benefitsCoverage",
	"annualHolidays",
];

// 準備済みコンテンツ。主パス入力と benefits パス入力、分割パス推奨フラグを持つ。
export interface PreparedContent {
	// 主パス（全キー抽出）の入力。予算内なら全文、超過なら先頭優先で切り詰めたテキスト。
	readonly main: string;
	// benefits パス（福利厚生/休暇キーの抽出）の入力。福利厚生セクションを集約したテキスト。
	readonly benefits: string;
	// 分割パスを推奨するか（主パスが予算超過で切り詰められ、かつ benefits セクションがある）。
	readonly split: boolean;
}

export interface PrepareContentOptions {
	// 主パスの文字予算。未指定は DEFAULT_MAIN_MAX_CHARS。
	readonly maxChars?: number;
}

// trim 済みテキストから福利厚生/休暇セクションを集約する（決定的）。
// 見出し語を含む行と、その直後 SECTION_CONTEXT_LINES 行（箇条書き等）を行番号で集合化し重複なく連結する。
export function collectBenefitSections(text: string): string {
	const lines = text.split("\n");
	const include = new Set<number>();
	for (let i = 0; i < lines.length; i += 1) {
		if (!hasBenefitKeyword(lines[i])) continue;
		const end = Math.min(lines.length - 1, i + SECTION_CONTEXT_LINES);
		for (let j = i; j <= end; j += 1) include.add(j);
	}
	return lines
		.filter((_, i) => include.has(i))
		.join("\n")
		.trim();
}

function hasBenefitKeyword(line: string): boolean {
	return BENEFIT_SECTION_KEYWORDS.some((k) => line.includes(k));
}

// 生 HTML を抽出入力へ準備する（決定的）。
// - 予算内: main=全文・split=false（従来どおり 1 パス。golden 入力を変えない）。
// - 予算超過: main=先頭優先で切り詰め・benefits=セクション集約。benefits があれば split=true。
//   先頭を残すのは年収・職種・必須要件など主要情報がページ上部に集中するため。
export function prepareExtractionContent(
	rawHtml: string,
	options: PrepareContentOptions = {},
): PreparedContent {
	const maxChars = options.maxChars ?? DEFAULT_MAIN_MAX_CHARS;
	const text = trimHtml(rawHtml);
	if (text.length <= maxChars) {
		return { main: text, benefits: collectBenefitSections(text), split: false };
	}
	const benefits = collectBenefitSections(text);
	const main = text.slice(0, maxChars);
	// benefits セクションが無ければ分割しても得る情報がない。主パスの切り詰めのみ（token 削減）。
	return { main, benefits, split: benefits !== "" };
}

// 主パスと benefits パスの抽出結果を統合する（決定的）。
// benefits パスが値を取れたキー（BENEFIT_OVERLAY_KEYS）はそれを採り、取れなければ主パスを残す。
// 福利厚生/年間休日が主パスの切り詰めで欠けても benefits パスで補える形にする（情報を捨てない）。
export function mergeBenefitFields(
	mainJob: NormalizedJob,
	benefitsJob: NormalizedJob,
): NormalizedJob {
	const merged: Record<NormalizedKey, NormalizedFieldValue> = { ...mainJob };
	for (const key of BENEFIT_OVERLAY_KEYS) {
		if (!isUnknown(benefitsJob[key])) {
			merged[key] = benefitsJob[key];
		}
	}
	return merged;
}
