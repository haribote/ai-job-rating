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

// 抽出結果のステータス。呼び出し側が「unknown 中立」と「抽出失敗」を区別できるようにする（§5.2）。
// - ok: AI 呼出が成功（個々の項目が unknown でも、それは中立として正しく扱える）。
// - extraction_failed: upstream 障害等でそもそも抽出できなかった。全 unknown は「失敗の畳み込み」であり中立ではない。
export type ExtractionStatus = "ok" | "extraction_failed";

// 抽出結果。スコアリング（#12）が再利用するため、正規スキーマと監査用メタを保存できる形にする。
// §5.3: この結果を保存しておけば重み・希望値の変更では再実行しない。
export interface ExtractionResult {
	readonly job: NormalizedJob;
	readonly model: string;
	// ISO8601。再取得・再抽出の要否判断（ページ内容変更時のみ）に使う監査メタ。
	readonly extractedAt: string;
	// 抽出が成立したか。extraction_failed の全 unknown を中立スコアと誤認させないための区別。
	readonly status: ExtractionStatus;
}

// transient な upstream 障害のリトライ上限（初回 + リトライ）。Phase 0 では過剰にせず最小限に抑える。
export const MAX_EXTRACTION_ATTEMPTS = 3;

// 既定の指数バックオフ基準（ms）。テストでは 0 を注入して即時化する。
const DEFAULT_BACKOFF_MS = 200;

// extractJob の任意オプション。リトライ挙動を呼び出し側／テストから調整できるようにする。
export interface ExtractJobOptions {
	// 指数バックオフの基準値（ms）。attempt 回目の待機は backoffMs * 2^(attempt-1)。
	readonly backoffMs?: number;
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

// 注記・補足を除去する（決定的）。NFKC 後に括弧（半角/全角どちらも () へ正規化済み）の中身と
// ※/＊ 以降の注記を落とす。
// なぜ: 「442名（グループ全体 ※2025年11月時点）」の括弧内日付（2025/11）を本体の数値と混ぜると
// min/max が破損するため、数値抽出より前にノイズ源を除く（単位換算・categorical 化には踏み込まない）。
function stripAnnotations(normalized: string): string {
	return normalized
		.replace(/\([^)]*\)/g, "") // 括弧（補足）ごと除去
		.replace(/[※＊].*$/g, ""); // ※/＊ 以降の注記を行末まで除去
}

// 生表記から数値を取り出す（決定的）。「700万〜900万」「122日」「700万」等を扱う。
// 同一項目内の表記は単位が揃う前提で、表記上の数値（700万→700）をそのまま min/max 比較に使う。
// 単位を跨いだ換算（万円 ↔ 円）はスコアリング側の関心事のため、ここでは行わない。
function parseNumbers(raw: string): number[] {
	const normalized = stripAnnotations(raw.normalize("NFKC"));
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

// throw された値が transient な upstream 障害（504 等）か判定する（決定的）。
// なぜ: live 検証ができないため、Workers AI の InferenceUpstreamError の正確な形に依存せず、
// 典型的なエラー形（httpCode/status/code/name/message）から 504 / gateway timeout の兆候を拾う。
// 恒久的エラー（400 系等）はリトライ対象外として即失敗にするため、ここで弾く。
function isTransientUpstreamError(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) return false;
	const e = cause as {
		httpCode?: unknown;
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		name?: unknown;
		message?: unknown;
	};
	const codes = [e.httpCode, e.status, e.statusCode, e.code];
	if (codes.some((c) => c === 504 || c === "504")) return true;
	const text = `${typeof e.name === "string" ? e.name : ""} ${
		typeof e.message === "string" ? e.message : ""
	}`.toLowerCase();
	return text.includes("504") || text.includes("gateway timeout");
}

// 指定 ms だけ待つ（バックオフ）。0 以下なら即時に解決する。
function delay(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// 求人本文を JSON Mode で構造化抽出し、正規スキーマへ寄せた抽出結果を返す（§7.1 / §5.3）。
// - 空本文では AI を呼ばず全 unknown を返す（unknown 中立・コスト最小化）。
// - AI が想定外形を返しても落とさず全 unknown へ畳む（抽出は堅牢に）。throw でなければ status は ok。
// - transient な upstream 504 は指数バックオフで限定回数リトライする。枯渇／非 transient エラーは
//   extraction_failed として全 unknown を返し、呼び出し側が「unknown 中立」と区別できるようにする（§5.2）。
export async function extractJob(
	ai: AiRunner,
	body: string,
	options: ExtractJobOptions = {},
): Promise<ExtractionResult> {
	const extractedAt = new Date().toISOString();
	const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
	// 空判定は trimHtml の出力契約（空文字の可能性）に従う。AI 呼出前に弾く。
	if (body.trim() === "") {
		return {
			job: allUnknownJob(),
			model: EXTRACTION_MODEL,
			extractedAt,
			status: "ok",
		};
	}

	for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
		try {
			const output = await ai.run(EXTRACTION_MODEL, {
				messages: buildExtractionMessages(body),
				response_format: {
					type: "json_schema",
					json_schema: buildExtractionJsonSchema(),
				},
			});
			// throw されない想定外レスポンス（JSON Mode 未充足等）は upstream 障害ではない。
			// 全 unknown へ畳むが status は ok（リトライ対象外）。
			const fields = extractRawFields(output);
			return {
				job: rawFieldsToNormalizedJob(fields),
				model: EXTRACTION_MODEL,
				extractedAt,
				status: "ok",
			};
		} catch (cause) {
			const lastAttempt = attempt === MAX_EXTRACTION_ATTEMPTS;
			// transient 504 のみリトライ。非 transient は即失敗（無駄なリトライをしない）。
			if (isTransientUpstreamError(cause) && !lastAttempt) {
				await delay(backoffMs * 2 ** (attempt - 1));
				continue;
			}
			break;
		}
	}

	// リトライ枯渇 or 非 transient エラー。抽出は落とさず全 unknown を返すが、
	// status: extraction_failed で「抽出失敗」を呼び出し側に伝える（中立スコアと誤認させない）。
	return {
		job: allUnknownJob(),
		model: EXTRACTION_MODEL,
		extractedAt,
		status: "extraction_failed",
	};
}
