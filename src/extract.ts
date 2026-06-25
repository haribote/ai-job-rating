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
	canonicalizeLabel,
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
// description は任意。構造的に誤りやすいキーに「何を抜き出すか」を載せ曖昧さを潰す（#88）。
export interface ExtractionJsonSchema {
	readonly type: "object";
	readonly properties: Readonly<
		Record<string, { readonly type: "string"; readonly description?: string }>
	>;
}

// 構造的に誤りやすいキーへ付ける抽出指示（#88）。モデル非依存に揃って誤るのを、
// プロパティ名の英単語だけに推測を委ねず description で「正解の定義」を明示して防ぐ。
const KEY_DESCRIPTIONS: Partial<Record<NormalizedKey, string>> = {
	companyPhase:
		"企業の上場区分のみ（上場／未上場／上場準備）。設立年は含めない。",
	holidaySystem:
		"休日制度の区分（完全週休2日制・週休2日制・シフト制など）。年間休日の日数は含めない。",
	workLocation: "勤務地の地名を原文のまま簡潔に。複数あれば併記する。",
	techStack:
		"使用技術・開発環境を原文の表記のまま列挙する。要約・翻訳・補完をしない。",
	businessDomain:
		"事業ドメイン・業界を原文のまま簡潔に（長い事業説明文にしない）。",
};

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
	"各キーの description に従い、要約・翻訳・言い換え・情報の補完はしないでください。",
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
	const properties: Record<string, { type: "string"; description?: string }> =
		{};
	for (const key of NORMALIZED_KEYS) {
		const description = KEY_DESCRIPTIONS[key];
		properties[key] = description
			? { type: "string", description }
			: { type: "string" };
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
		.replace(/[※＊].*$/gm, ""); // ※/＊ 以降の注記を各行末まで除去（多行値でも行単位で効かせる）
}

// 生表記から数値を取り出す（決定的）。「700万〜900万」「122日」「700万」等を扱う。
// 同一項目内の表記は単位が揃う前提で、表記上の数値（700万→700）をそのまま min/max 比較に使う。
// 通貨の単位換算（円 → 万円）は salaryToManYen が別途担う（数値だけが欲しい非通貨項目はこちらを使う）。
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

// 通貨（年収・月給）を扱う numericRange キー。これらだけ円 → 万円の単位正規化を施す。
// なぜ extract 側で正規化するか: DEFAULT_SCORING_CONFIG の希望値は万円前提で、抽出は 1 回・保存して
// 再利用する（§5.3）。単位を「正規スキーマのキーへ寄せる」のは抽出（ラベル正規化）の関心事（§5.2）。
const SALARY_KEYS: ReadonlySet<NormalizedKey> = new Set<NormalizedKey>([
	"annualSalary",
	"monthlySalary",
]);

// 通貨表記の各数値を「万円」へ正規化して取り出す（決定的）。
// なぜ: 求人は「700万」(万円) と「9,000,000円」(円) が混在する一方、年収欄には「賞与年2回」の "2" の
// ようなノイズ数値も混じる（#57）。通貨単位（万/円/万円）を伴う数値だけを採り、単位無しの裸数値は
// ノイズとして捨てて min/max を汚染させない。「万」「万円」→ そのまま万円、「円」（生の円額）→ 1/10000。
function salaryToManYen(raw: string): number[] {
	const normalized = stripAnnotations(raw.normalize("NFKC"));
	const numbers: number[] = [];
	// 数値の直後に続く通貨単位（万円 / 万 / 円）を捕捉する。単位が無ければ採らない（ノイズ除去）。
	const re = /([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(万円|万|円)?/g;
	for (const match of normalized.matchAll(re)) {
		const unit = match[2];
		if (unit === undefined) continue; // 通貨単位を伴わない裸の数値はノイズとして無視
		const value = Number(match[1].replace(/,/g, ""));
		if (!Number.isFinite(value)) continue;
		// 「万」「万円」付きは万円単位。「円」は生の円額とみなして万円へ換算する。
		numbers.push(unit === "円" ? value / 10000 : value);
	}
	return numbers;
}

// 否定表現の検出用 needle（canonicalizeLabel 適用後で照合）。
// なぜ: 部分一致＋登録順だと「フレックス不可」が positive(flex) に化ける。否定の有無を先に判定し、
// positive canonical を抑止する（remoteWork は否定を onsite へ寄せる）。決定的に評価する。
const NEGATION_NEEDLES: readonly string[] = ["不可", "なし", "不要", "無"];

// 主要 categorical の canonical 集合（生 JP → canonical トークン）。
// なぜ: 抽出は生 JP を保持するが scoring の preferred は canonical 前提のため、抽出時に寄せる（§5.2）。
// 照合は canonicalizeLabel 後の部分一致で行い、エントリの登録順（具体的→一般的）に最初の一致を採る。
// 裸の「あり」「可」のような過度に汎用な needle は誤爆（「残業あり」→yes）するため固有 stem に絞る。
type CategoryRule = readonly [needle: string, canonical: string];
const CATEGORY_RULES: Partial<Record<NormalizedKey, readonly CategoryRule[]>> =
	{
		// リモート可否 → full / partial / onsite。否定は別途 onsite へ寄せる（下記参照）。
		remoteWork: [
			["フルリモート", "full"],
			["完全リモート", "full"],
			["フル在宅", "full"],
			["一部リモート", "partial"],
			["ハイブリッド", "partial"],
			["リモート可", "partial"],
			["在宅可", "partial"],
			["リモートあり", "partial"],
			["出社", "onsite"],
			["常駐", "onsite"],
		],
		// フレックス・裁量労働 → flex / discretionary。固有 stem のみ（裸の「あり/可」は撤去）。
		flexWork: [
			["フレックス", "flex"],
			["裁量労働", "discretionary"],
			["裁量", "discretionary"],
			["みなし労働", "discretionary"],
			["みなし", "discretionary"],
		],
		// 休日制度 → 制度区分。年間休日「数」は annualHolidays の責務なので規則に入れない（#88）。
		// 「完全週休2日」を「週休2日」より先に置く（部分一致先勝ち）。
		holidaySystem: [
			["完全週休2日", "fullTwoDayWeekoff"],
			["週休2日", "twoDayWeekoff"],
			["シフト", "shift"],
			["交代", "shift"],
			["4週8休", "fourWeekEightOff"],
		],
		// 上場区分 → listed / preIpo / private（#88: companyPhase の意味を上場区分に確定）。
		// 「未上場/非上場」「上場準備」を「上場」より先に置く（「上場」は両者の部分文字列）。
		companyPhase: [
			["未上場", "private"],
			["非上場", "private"],
			["上場準備", "preIpo"],
			["IPO準備", "preIpo"],
			["東証", "listed"],
			["プライム", "listed"],
			["スタンダード", "listed"],
			["グロース", "listed"],
			["上場", "listed"],
		],
	};

// 否定マーカーを含むときに onsite へ寄せるキー。リモートの「不可/なし」は明確な否定意味を持つ。
const NEGATION_TO_ONSITE: ReadonlySet<NormalizedKey> = new Set<NormalizedKey>([
	"remoteWork",
]);

// 否定表現を含むか（canonicalizeLabel 後で部分一致）。
// なぜ「みなし」を除くか: 否定 needle「なし」は「みなし（労働）」の部分文字列に一致してしまい、
// 裁量労働の positive を否定と誤判定する。みなしは否定でなく discretionary の語なので先に除去する。
function hasNegation(haystack: string): boolean {
	const withoutDeemed = haystack.replace(/みなし/g, "");
	return NEGATION_NEEDLES.some((n) =>
		withoutDeemed.includes(canonicalizeLabel(n)),
	);
}

// categorical の生表記を canonical トークン 1 つへ寄せる（決定的・best-effort）。
// 否定表現は positive canonical へ化けさせない。マッピングに無い値は null を返し、呼び出し側が
// 生表記を残せるようにする（情報を捨てない）。
function canonicalizeCategoryValue(
	key: NormalizedKey,
	raw: string,
): string | null {
	const rules = CATEGORY_RULES[key];
	if (rules === undefined) return null;
	const haystack = canonicalizeLabel(raw);
	// 否定を先に評価し positive canonical の誤判定を防ぐ（§修正1）。
	if (hasNegation(haystack)) {
		return NEGATION_TO_ONSITE.has(key) ? "onsite" : null;
	}
	for (const [needle, canonical] of rules) {
		if (haystack.includes(canonicalizeLabel(needle))) return canonical;
	}
	return null;
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
		// 通貨項目だけ円 → 万円へ単位正規化する（scoring の希望値が万円前提・§5.2）。
		const numbers = SALARY_KEYS.has(key)
			? salaryToManYen(value)
			: parseNumbers(value);
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
		// Phase 0 では aiJudged を unknown 中立とし分母から除外する（§5.2）。判定基準が未確定で
		// （希望スキル集合不在・実 AI 再呼出は §5.3 抵触）、#7 設定UI/#15 スパイクまで保留。生表記は監査用に保持。
		return { kind: "unknown", raw: value };
	}

	// categorical: 主要キーは canonical トークンへ寄せ scoring の preferred と突合可能にする（§5.2）。
	// マッピングに無い値は生表記を 1 カテゴリとして残す（情報を捨てない）。
	const canonical = canonicalizeCategoryValue(key, value);
	return {
		kind: "categorical",
		categories: [canonical ?? value],
		raw: value,
	};
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
