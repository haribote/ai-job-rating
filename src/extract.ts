// 求人本文（trim 済みプレーンテキスト）から構造化データを抽出する（要件 §7.1 JSON Mode / §5.3）。
//
// なぜこのモジュールが存在するか:
// - Workers AI の JSON Mode（structured output）で、求人本文を正規スキーマへ構造化抽出する。
// - AI には「正規キーごとの生抽出文字列」だけを出させ、kind 判定・数値パース等の
//   ラベル正規化はこちら側の決定的ロジックで行う（§5.2 ラベル正規化の責務をコードに保つ）。
// - 抽出は求人 1 件 1 回・結果を保存して再利用する。ExtractionResult に model/extractedAt を
//   持たせ、重み・希望値の変更で再実行しない契約を型・関数境界で表現する（§5.3）。
// - live 推論は account/secrets 依存のため、テストでは AiRunner を fake して整形・分岐を検証する。

import type { AiRunner } from "./ai";
import {
	isUnknownRaw,
	NORMALIZED_KEYS,
	type NormalizationKind,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "./job-schema";

// 抽出に使う既定モデル。要件 §7.1 候補のうち JSON Mode 対応かつ日本語実用域の Llama 3.3 を採用する。
// 一次ソース（Workers AI JSON Mode の Supported Models）に掲載されるモデルから選ぶ。
// 最終的なデフォルトモデルは日本語抽出精度の比較スパイク（#15）で確定する（要手動検証）。
export const EXTRACTION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 抽出結果。スコアリング（#12）が再利用するため、正規スキーマと監査用メタを保存できる形にする。
// §5.3: この結果を保存しておけば重み・希望値の変更では再実行しない。
export interface ExtractionResult {
	readonly job: NormalizedJob;
	readonly model: string;
	// ISO8601。再取得・再抽出の要否判断（ページ内容変更時のみ）に使う監査メタ。
	readonly extractedAt: string;
}

// 抽出時に AI へ要求する「正規キーごとの生抽出文字列」。値は素のテキスト（正規化前）。
export type RawExtractionFields = Partial<Record<NormalizedKey, string>>;

// 各正規キーをどの正規化種別へ寄せるか（§5.2 の 3 類型）。
// numericRange: 数値レンジ（年収・休日数など）/ categorical: 正規化済みカテゴリ /
// aiJudged: AI 判定スコア（スキルマッチ等、判定値は後段スパイクで詳細化）。
const KIND_BY_KEY: Record<NormalizedKey, NormalizationKind> = {
	annualSalary: "numericRange",
	monthlySalary: "numericRange",
	bonus: "categorical",
	salaryRaise: "categorical",
	retirementAllowance: "categorical",
	overtime: "numericRange",
	annualHolidays: "numericRange",
	holidaySystem: "categorical",
	paidLeaveRate: "numericRange",
	remoteWork: "categorical",
	flexWork: "categorical",
	workLocation: "categorical",
	employmentType: "categorical",
	employmentTerm: "categorical",
	techStack: "categorical",
	requiredSkillsMatch: "aiJudged",
	preferredSkillsMatch: "aiJudged",
	businessDomain: "categorical",
	languageRequirement: "categorical",
	companySize: "numericRange",
	companyPhase: "categorical",
};

// JSON Schema の最小形（Workers AI/OpenAI 互換）。json_schema にそのまま渡せる object 型のみ扱う。
export interface ExtractionJsonSchema {
	readonly type: "object";
	readonly properties: Readonly<Record<string, { readonly type: "string" }>>;
}

// 抽出メッセージ（OpenAI 互換）。AiRunner.run の inputs.messages に渡す。
export interface ExtractionMessage {
	readonly role: "system" | "user";
	readonly content: string;
}

// system プロンプト。正規キーごとの素の抽出文字列だけを出させ、判定・正規化はコード側に保つ。
// 未記載は "-" を返させ、isUnknownRaw が unknown 中立へ寄せられるようにする（§5.2）。
const SYSTEM_PROMPT = [
	"あなたは求人票から事実を抽出するアシスタントです。",
	"与えられた求人本文から、指定スキーマの各キーに対応する記載を原文の表記のまま短く抜き出してください。",
	"記載が見つからない項目は必ず「-」を返してください。推測や創作はしないでください。",
].join("");

// trim 済み本文から抽出用 messages を組み立てる（決定的）。
export function buildExtractionMessages(body: string): ExtractionMessage[] {
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: `求人本文:\n${body}` },
	];
}

// 全正規キーを string property に持つ JSON Schema を組み立てる（決定的）。
// 正規スキーマ外のキーは含めない（ラベル正規化の責務をコードに保つ）。
export function buildExtractionJsonSchema(): ExtractionJsonSchema {
	const properties: Record<string, { type: "string" }> = {};
	for (const key of NORMALIZED_KEYS) {
		properties[key] = { type: "string" };
	}
	return { type: "object", properties };
}

// 生表記から数値を取り出す（決定的）。「700万〜900万」「122日」「700万」等を扱う。
// 同一項目内の表記は単位が揃う前提で、表記上の数値（700万→700）をそのまま min/max 比較に使う。
// 単位を跨いだ換算（万円 ↔ 円）はスコアリング側の関心事のため、ここでは行わない。
function parseNumbers(raw: string): number[] {
	const normalized = raw.normalize("NFKC");
	const numbers: number[] = [];
	// 数値（カンマ・小数点許容）を順に拾う
	const re = /[0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?/g;
	for (const match of normalized.matchAll(re)) {
		const value = Number(match[0].replace(/,/g, ""));
		if (Number.isFinite(value)) {
			numbers.push(value);
		}
	}
	return numbers;
}

// 生抽出文字列 1 つを正規キーの値（NormalizedFieldValue）へ寄せる（決定的）。
function rawToFieldValue(
	key: NormalizedKey,
	raw: string | undefined,
): NormalizedFieldValue {
	// 未記載・空は unknown 中立（スコアリングで分母から外せる）
	if (isUnknownRaw(raw ?? null)) {
		return { kind: "unknown", ...(raw ? { raw } : {}) };
	}
	const value = raw as string;
	const kind = KIND_BY_KEY[key];

	if (kind === "numericRange") {
		const numbers = parseNumbers(value);
		// 数値が取れなければ unknown 中立（値を持たせない）
		if (numbers.length === 0) {
			return { kind: "unknown", raw: value };
		}
		return {
			kind: "numericRange",
			min: Math.min(...numbers),
			max: Math.max(...numbers),
			raw: value,
		};
	}

	if (kind === "aiJudged") {
		// AI 判定スコア（0〜100）の算定詳細は後段スパイク（#15）。
		// Phase 0 では生表記を保持し、スコア値は中立扱いの 0 で持つ（分母除外は #12 が判断）。
		return { kind: "aiJudged", score: 0, raw: value };
	}

	// categorical: 正規化済みカテゴリ集合は項目ごとに定義予定。
	// Phase 0 では生表記を 1 カテゴリとして保持する（カテゴリ正規化の詳細化は後続）。
	return { kind: "categorical", categories: [value], raw: value };
}

// AI の生出力（キーごとの生文字列）を NormalizedJob へ寄せる（決定的・全キー必須）。
// 取れない項目は unknown で埋め、スコアリングが kind === "unknown" だけで中立判定できる形にする。
export function rawFieldsToNormalizedJob(
	fields: RawExtractionFields,
): NormalizedJob {
	const entries = NORMALIZED_KEYS.map((key) => [
		key,
		rawToFieldValue(key, fields[key]),
	]);
	return Object.fromEntries(entries) as NormalizedJob;
}

// 全正規キーが unknown の求人を作る（空入力・抽出失敗時のフォールバック）。
function allUnknownJob(): NormalizedJob {
	return rawFieldsToNormalizedJob({});
}

// AiRunner の戻り値（JSON Mode）から生フィールドを安全に取り出す。
// JSON Mode のレスポンスは { response: <object|string> } 形（一次ソース §7.1）。想定外は {} へ。
function extractRawFields(output: unknown): RawExtractionFields {
	if (typeof output !== "object" || output === null) return {};
	const response = (output as { response?: unknown }).response;
	const obj =
		typeof response === "string" ? safeParse(response) : (response ?? {});
	if (typeof obj !== "object" || obj === null) return {};
	const fields: RawExtractionFields = {};
	for (const key of NORMALIZED_KEYS) {
		const value = (obj as Record<string, unknown>)[key];
		if (typeof value === "string") {
			fields[key] = value;
		}
	}
	return fields;
}

// JSON 文字列を安全に解釈する（壊れていれば null）。
function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// 求人本文を JSON Mode で構造化抽出し、正規スキーマへ寄せた抽出結果を返す（§7.1 / §5.3）。
// - 空本文では AI を呼ばず全 unknown を返す（unknown 中立・コスト最小化）。
// - AI が想定外形を返す/throw しても落とさず全 unknown へ畳む（抽出は堅牢に）。
// model はデフォルト確定前の比較スパイク（#15）のため後方互換で受ける任意引数。
// 省略時は EXTRACTION_MODEL。結果の model は「実際に使ったモデル」を指し、
// 保存した抽出結果の出所を一意にする（比較記録・§5.3 の再利用契約のため）。
export async function extractJob(
	ai: AiRunner,
	body: string,
	model: string = EXTRACTION_MODEL,
): Promise<ExtractionResult> {
	const extractedAt = new Date().toISOString();
	// 空判定は trimHtml の出力契約（空文字の可能性）に従う。AI 呼出前に弾く。
	if (body.trim() === "") {
		return { job: allUnknownJob(), model, extractedAt };
	}

	try {
		const output = await ai.run(model, {
			messages: buildExtractionMessages(body),
			response_format: {
				type: "json_schema",
				json_schema: buildExtractionJsonSchema(),
			},
		});
		const fields = extractRawFields(output);
		return {
			job: rawFieldsToNormalizedJob(fields),
			model,
			extractedAt,
		};
	} catch {
		// JSON Mode 未充足・upstream 障害等。抽出は落とさず全 unknown を返し、後段で中立に扱う。
		return { job: allUnknownJob(), model, extractedAt };
	}
}
