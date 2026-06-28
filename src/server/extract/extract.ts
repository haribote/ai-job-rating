// 求人本文（trim 済みプレーンテキスト）から構造化データを抽出する（要件 §7.1 JSON Mode / §5.3）。
//
// なぜこのモジュールが存在するか:
// - Workers AI の JSON Mode（structured output）で、求人本文を正規スキーマへ構造化抽出する。
// - AI には「正規キーごとの生抽出文字列」だけを出させ、kind 判定・数値パース等の
//   ラベル正規化はこちら側の決定的ロジックで行う（§5.2 ラベル正規化の責務をコードに保つ）。
// - 抽出は求人 1 件 1 回・結果を保存して再利用する。ExtractionResult に model/extractedAt を
//   持たせ、重み・希望値の変更で再実行しない契約を型・関数境界で表現する（§5.3）。
// - live 推論は account/secrets 依存のため、テストでは AiRunner を fake して整形・分岐を検証する。

import {
	canonicalizeLabel,
	isUnknownRaw,
	NORMALIZED_KEYS,
	type NormalizationKind,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "../../shared/job-schema";
import {
	BENEFIT_SIGNAL_KEYS,
	detectBenefitSignals,
} from "../scoring/benefits-coverage";
import type { AiRunner } from "./ai";
import {
	mergeBenefitFields,
	type PrepareContentOptions,
	prepareExtractionContent,
} from "./content-extract";
import {
	resolveExtractionMaxTokens,
	resolveExtractionMechanism,
} from "./mechanism";
import type { ExtractionMechanism } from "./model-eval";

// 抽出に使う既定モデル（コード側の最終フォールバック）。要件 §7.1 候補のうち JSON Mode 対応の Llama 3.3。
// 一次ソース（Workers AI JSON Mode の Supported Models）に掲載されるモデルから選ぶ。
// フォーク容易性（§8）: 実運用の既定はここを直接書き換えず wrangler.jsonc の vars.EXTRACTION_MODEL /
//   .dev.vars で上書きする。本定数は env 未設定時のフォールバックに限る（既定変更は wrangler.jsonc 1 箇所）。
// 既定の最終確定はモデル再評価スパイク（#106）の live golden 横並びで行う（要手動検証）。
export const EXTRACTION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 設定値（env.EXTRACTION_MODEL）から実効モデル ID を解決する（アダプタの差し戻し点・#106）。
// 空文字・未設定はコード既定へフォールバックし、フォーク先が vars 未設定でも動くようにする。
export function resolveExtractionModel(configured?: string): string {
	const trimmed = configured?.trim();
	return trimmed ? trimmed : EXTRACTION_MODEL;
}

// 抽出結果のステータス。呼び出し側が「unknown 中立」と「抽出失敗」を区別できるようにする（§5.2）。
// - ok: AI 呼出が成功（個々の項目が unknown でも、それは中立として正しく扱える）。
// - extraction_failed: upstream 障害等でそもそも抽出できなかった。全 unknown は「失敗の畳み込み」であり中立ではない。
export type ExtractionStatus = "ok" | "extraction_failed";

// 抽出結果。スコアリング（#12）が再利用するため、正規スキーマと監査用メタを保存できる形にする。
// §5.3: この結果を保存しておけば重み・希望値の変更では再実行しない。
export interface ExtractionResult {
	readonly job: NormalizedJob;
	readonly model: string;
	// 実際に使った出力機構（json-mode / function-calling）。永続化の mechanism 列・監査に使う（#107）。
	readonly mechanism: ExtractionMechanism;
	// ISO8601。再取得・再抽出の要否判断（ページ内容変更時のみ）に使う監査メタ。
	readonly extractedAt: string;
	// 抽出が成立したか。extraction_failed の全 unknown を中立スコアと誤認させないための区別。
	readonly status: ExtractionStatus;
}

// transient な upstream 障害のリトライ上限（初回 + リトライ）。Phase 0 では過剰にせず最小限に抑える。
export const MAX_EXTRACTION_ATTEMPTS = 3;

// 既定の指数バックオフ基準（ms）。テストでは 0 を注入して即時化する。
const DEFAULT_BACKOFF_MS = 200;

// extractJob の任意オプション。リトライ挙動・使用モデルを呼び出し側／テストから調整できるようにする。
export interface ExtractJobOptions {
	// 指数バックオフの基準値（ms）。attempt 回目の待機は backoffMs * 2^(attempt-1)。
	readonly backoffMs?: number;
	// 抽出に使うモデル ID。未指定はコード既定（EXTRACTION_MODEL）。
	// モデル横断 golden 評価（#106）が候補ごとに注入し、本番は env 解決値が渡る（アダプタの差し戻し点）。
	readonly model?: string;
	// 出力機構の明示指定（json-mode / function-calling）。未指定はモデル ID から解決する（#107）。
	// eval や検証で機構だけ差し替えたい場合の差し戻し点。
	readonly mechanism?: ExtractionMechanism;
	// ai.run の max_tokens 上限の明示指定（#147）。未指定はモデル ID からカタログ解決し、無ければモデル既定。
	readonly maxTokens?: number;
}

// 抽出時に AI へ要求する「正規キーごとの生抽出文字列」。値は素のテキスト（正規化前）。
export type RawExtractionFields = Partial<Record<NormalizedKey, string>>;

// 各正規キーを抽出時にどの値種別（NormalizedFieldValue.kind）へ寄せるか（§5.2）。
// numericRange: 数値レンジ（年収・休日数・人数・資本金）/ categorical: 正規化済みカテゴリ /
// coverage: 福利厚生の充足率（signal 抽出は #102。#101 では unknown 中立に畳む）。
// 注: skillMatch は値としては categorical（求人スキル集合）で持ち、採点側は config kind keywordMatch
//     （ユーザー keyword とのヒット率・#105）で評価する。値種別と config kind の役割が異なる。
const KIND_BY_KEY: Record<NormalizedKey, NormalizationKind> = {
	annualSalary: "numericRange",
	bonus: "numericRange",
	overtime: "numericRange",
	annualHolidays: "numericRange",
	benefitsCoverage: "coverage",
	remoteWork: "categorical",
	flexWork: "categorical",
	skillMatch: "categorical",
	companySize: "numericRange",
	capital: "numericRange",
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
	skillMatch:
		"使用技術・スキル・必須/歓迎要件を原文の表記のまま列挙する。要約・翻訳・補完をしない。",
	// 賞与は金額でなく年間支給回数で評価する（#142）。金額・月数・「業績連動」は回数でないので返さない。
	bonus:
		"賞与の年間支給回数を数値で返す（例: 年2回→2）。賞与額・月数・『業績連動』等の文言は支給回数ではないので返さない。回数の記載が無ければ『-』。",
	benefitsCoverage:
		"福利厚生・休日制度・休暇制度・各種手当・退職金などの待遇を原文のまま列挙する。",
	annualHolidays:
		"年間休日の日数のみ（例: 125日）。休日制度の区分名は含めない。",
	// 残業は定量を優先（①平均残業時間 → ②みなし/固定残業時間の順・設計 §5.2）。
	// 数値が無く残業の有無のみ書かれている場合はその文言（例: 残業あり）を返させ、コード側で減点特例に寄せる。
	overtime:
		"残業時間を数値で抜き出す（例: 月平均20時間）。平均残業時間を優先し、無ければ固定・みなし残業時間。数値が無く有無の記載のみなら原文の文言（例: 残業あり）を返す。",
	capital: "企業の資本金のみ（例: 1億円）。売上高・従業員数は含めない。",
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

// 全正規キー（＋ description）を prompt 用テキストへ整形する（決定的・#147）。
// なぜ prompt にも schema を出すか: 一部モデル（gpt-oss 等）は response_format.json_schema を参照せず
// 「schema が無い」と迷走して 504/content=null になる。response_format に加え prompt にもキーを明示し、
// response_format を見ないモデルでも抽出できるようにする（json_schema と同一の properties を単一ソースに保つ）。
function buildSchemaPromptSection(): string {
	const { properties } = buildExtractionJsonSchema();
	const lines = Object.entries(properties).map(([key, prop]) =>
		prop.description ? `- ${key}: ${prop.description}` : `- ${key}`,
	);
	return [
		"抽出して JSON で返すキー一覧（下記の各キーを持つ JSON オブジェクトを1つだけ出力する）:",
		...lines,
	].join("\n");
}

// trim 済み本文から抽出用 messages を組み立てる（決定的）。schema は prompt にも明示する（#147）。
export function buildExtractionMessages(body: string): ExtractionMessage[] {
	return [
		{
			role: "system",
			content: `${SYSTEM_PROMPT}\n${buildSchemaPromptSection()}`,
		},
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

// FC（Function calling）で要求するツール定義（Workers AI traditional FC 形・一次ソース:
// https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/ ）。
// JSON Mode の json_schema と同じ properties を tools.parameters へ写し、両機構で出力スキーマを揃える。
export interface ExtractionTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: {
		readonly type: "object";
		readonly properties: Readonly<
			Record<string, { readonly type: "string"; readonly description?: string }>
		>;
		// 全キーを required にする。なぜ: #15 で llama-4-scout は required 未指定だとキーを取りこぼした。
		// 未記載キーは system プロンプトに従い "-" を返させ、コード側で unknown 中立へ寄せる。
		readonly required: readonly string[];
	};
}

// FC ツール名。レスポンス（tool_calls[].name）の同定に使う。
export const EXTRACTION_TOOL_NAME = "extract_job_fields";

// FC 用のツール定義を組み立てる（決定的）。json_schema と同じ properties を共有する。
export function buildExtractionTool(): ExtractionTool {
	const schema = buildExtractionJsonSchema();
	return {
		name: EXTRACTION_TOOL_NAME,
		description:
			"求人本文から正規スキーマの各キーに対応する記載を原文の表記のまま抽出する。",
		parameters: {
			type: "object",
			properties: schema.properties,
			required: [...NORMALIZED_KEYS],
		},
	};
}

// 機構に応じた ai.run の inputs を組み立てる（決定的）。
// json-mode は response_format(json_schema)、function-calling は tools + tool_choice を渡す。
// maxTokens は与えられたときだけ max_tokens として載せる（未指定はモデル既定に委ねる・#147）。
// 注: 一律の高い max_tokens は禁物。mistral 等は JSON 後に退化したタブ列を吐くため、高い値はタブ生成で 504 を
//     招く（#146）。一方 gpt-oss は reasoning で budget を食うため十分な値が要る（#147）。上限はモデル別に持つ。
function buildExtractionRequest(
	body: string,
	mechanism: ExtractionMechanism,
	maxTokens?: number,
): unknown {
	const messages = buildExtractionMessages(body);
	const maxTokensPart = maxTokens ? { max_tokens: maxTokens } : {};
	if (mechanism === "function-calling") {
		const tool = buildExtractionTool();
		return {
			messages,
			...maxTokensPart,
			tools: [tool],
			// 単一ツールを強制し、平文応答に逃げさせない（OpenAI 互換 tool_choice 形）。
			// 受理形はモデル依存のため live で要確認（#106 eval）。非対応モデルは throw → extraction_failed。
			tool_choice: { type: "function", function: { name: tool.name } },
		};
	}
	return {
		messages,
		...maxTokensPart,
		response_format: {
			type: "json_schema",
			json_schema: buildExtractionJsonSchema(),
		},
	};
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
]);

// 「回」単位を伴う数値を支給回数として numericRange へ寄せるキー（#142）。
// なぜ: 賞与は金額開示が乏しく「年N回」の頻度のみのことが多い。回数（多いほど良い）で採点するため、
// 金額・月数ではなく「N回」の N だけを採る（salaryToManYen が通貨単位限定で数値を採るのと同じ発想）。
const PAYOUT_COUNT_KEYS: ReadonlySet<NormalizedKey> = new Set<NormalizedKey>([
	"bonus",
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

// 「年N回」の支給回数だけを取り出す（決定的・#142）。
// なぜ: 賞与欄には「2ヶ月分」「30万円」「業績連動」など回数でない数値が混じる。parseNumbers の裸数値拾い
// だと「2ヶ月分」の 2 まで回数に化けるため、直後に「回」を伴う数値に限定する（salaryToManYen の通貨単位
// 限定と同じ発想）。注記（※以降・括弧）は stripAnnotations が先に除く（「年2回 ※業績連動」→ 2）。
function parsePayoutCount(raw: string): number[] {
	const normalized = stripAnnotations(raw.normalize("NFKC"));
	const numbers: number[] = [];
	// 数値の直後に（空白を挟んでも）「回」が続くものだけを採る。
	const re = /([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*回/g;
	for (const match of normalized.matchAll(re)) {
		const value = Number(match[1].replace(/,/g, ""));
		if (Number.isFinite(value)) numbers.push(value);
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
		// フレックス（労働者が始業終業を選べる）→ flex のみ。裁量労働=みなし労働は別物のため寄せない（§5.2）。
		flexWork: [["フレックス", "flex"]],
	};

// flexWork は flex の有無のみを表す closed categorical。canonical(=flex)に寄らない値（裁量労働・
// 「フレックス不可」・裸の「有/あり」）は生表記を残さず unknown 中立へ畳む（§5.2）。open categorical
// （remoteWork 等）は情報を捨てず生表記をカテゴリに残す従来挙動を保つ。
const CLOSED_CATEGORICAL_KEYS: ReadonlySet<NormalizedKey> =
	new Set<NormalizedKey>(["flexWork"]);

// 否定マーカーを含むときに onsite へ寄せるキー。リモートの「不可/なし」は明確な否定意味を持つ。
const NEGATION_TO_ONSITE: ReadonlySet<NormalizedKey> = new Set<NormalizedKey>([
	"remoteWork",
]);

// 否定表現を含むか（canonicalizeLabel 後で部分一致）。
// なぜ「みなし」を除くか: 否定 needle「なし」は「みなし（労働）」の部分文字列に一致し否定と誤判定する。
// みなしは否定語ではないため先に除去する（flexWork 以外の categorical でも安全側に効く汎用ガード）。
function hasNegation(haystack: string): boolean {
	const withoutDeemed = haystack.replace(/みなし/g, "");
	return NEGATION_NEEDLES.some((n) =>
		withoutDeemed.includes(canonicalizeLabel(n)),
	);
}

// overtime が「残業の存在」を肯定的に明記する語（canonicalizeLabel 後で部分一致）。
// なぜ: 「有り明記だが定量なし」を中立でなく減点する特例の検出に使う（§5.2 意図的例外）。
// 裸の「あり」は「残業はありません」を誤検出する（NEGATION_NEEDLES は「ありません」を拾わない）ため避け、
// 残業を肯定する語に限定する。誤って減点する（中立にすべきを減点）害の方が大きいので precision 優先。
const OVERTIME_PRESENCE_NEEDLES: readonly string[] = [
	"残業あり",
	"残業有",
	"固定残業",
	"みなし残業",
	"見込み残業",
	"時間外労働あり",
	"超過勤務あり",
];

// overtime の生表記が「残業の存在」を肯定的に明記しているか（決定的）。
// 否定（残業なし等）は false。時間が数値で読める場合は呼び出し側が numericRange を優先するため、
// 本関数は定量値が取れなかったときのみ評価される。
function statesOvertimePresence(raw: string): boolean {
	const haystack = canonicalizeLabel(raw);
	// 否定を先に評価し「残業なし」等を減点しない（時間ゼロ寄りの良い情報のため）。
	if (hasNegation(haystack)) return false;
	return OVERTIME_PRESENCE_NEEDLES.some((n) =>
		haystack.includes(canonicalizeLabel(n)),
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
		// 通貨項目だけ円 → 万円へ単位正規化、回数項目は「N回」だけを採る、他は素の数値（§5.2・#142）。
		const numbers = SALARY_KEYS.has(key)
			? salaryToManYen(value)
			: PAYOUT_COUNT_KEYS.has(key)
				? parsePayoutCount(value)
				: parseNumbers(value);
		// 数値が取れなければ unknown 中立（値を持たせない）
		if (numbers.length === 0) {
			// overtime 特例: 残業の存在を肯定的に明記しているのに時間が読めない場合は、
			// 中立でなく減点対象として stated を立てる（§5.2 unknown 中立の意図的例外・設計 §5.2）。
			// 否定（残業なし等）・記載なしは stated を立てず従来通り中立。
			if (key === "overtime" && statesOvertimePresence(value)) {
				return { kind: "unknown", raw: value, stated: true };
			}
			return { kind: "unknown", raw: value };
		}
		return {
			kind: "numericRange",
			min: Math.min(...numbers),
			max: Math.max(...numbers),
			raw: value,
		};
	}

	if (kind === "coverage") {
		// benefitsCoverage は canonical 閉集合に対する signal 検出で present/total を作る（設計書 §5.2・#102）。
		// signals は決定的順（sort）で保存し、設定変更時に AI 非再実行で重視 signal 再採点できるようにする（§5.3）。
		// 生表記があるのに該当 signal が 0 なら 0%（閉集合限定の充足率）。生表記が未記載なら上の isUnknownRaw で中立。
		const signals = [...detectBenefitSignals(value)].sort();
		return {
			kind: "coverage",
			present: signals.length,
			total: BENEFIT_SIGNAL_KEYS.length,
			signals,
			raw: value,
		};
	}

	// categorical: 主要キーは canonical トークンへ寄せ scoring の preferred と突合可能にする（§5.2）。
	const canonical = canonicalizeCategoryValue(key, value);
	// closed categorical（flexWork）は canonical に寄らない値を unknown 中立にする（生表記を残さない）。
	if (canonical === null && CLOSED_CATEGORICAL_KEYS.has(key)) {
		return { kind: "unknown", raw: value };
	}
	// open categorical はマッピングに無い値も生表記を 1 カテゴリとして残す（情報を捨てない）。
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

// 任意のオブジェクトから「正規キー = 文字列」のペアだけを拾う（両機構の最終合流点）。
// 想定外（非オブジェクト・非文字列値）は無視し、取れたキーのみ返す（落とさない）。
function fieldsFromObject(obj: unknown): RawExtractionFields {
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

// OpenAI 互換レスポンスの message.content（JSON 文字列 or object）を順に集める。
// 一部 CF モデル（qwen3 / gemma / mistral 等）は json-mode でも WAI の { response } でなく
// { choices: [{ message: { content: "<json>" } }] } で返すため、ここで content を回収する（#145）。
function collectMessageContents(output: unknown): unknown[] {
	const choices = (output as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) return [];
	const contents: unknown[] = [];
	for (const choice of choices) {
		const content = (choice as { message?: { content?: unknown } })?.message
			?.content;
		if (content !== undefined && content !== null) contents.push(content);
	}
	return contents;
}

// AiRunner の戻り値（JSON Mode）から生フィールドを安全に取り出す。
// 一次形は WAI native の { response: <object|string> }（§7.1）。フィールドが取れない場合は
// OpenAI 互換 { choices: [{ message: { content } }] } へフォールバックする（#145・FC の機構差吸収と同様）。
function extractRawFields(output: unknown): RawExtractionFields {
	if (typeof output !== "object" || output === null) return {};
	const response = (output as { response?: unknown }).response;
	if (response !== undefined && response !== null) {
		const obj = typeof response === "string" ? safeParse(response) : response;
		const fields = fieldsFromObject(obj);
		if (Object.keys(fields).length > 0) return fields;
	}
	for (const content of collectMessageContents(output)) {
		const obj = typeof content === "string" ? safeParse(content) : content;
		const fields = fieldsFromObject(obj);
		if (Object.keys(fields).length > 0) return fields;
	}
	return {};
}

// 1 件の tool call（機構間の差を吸収した形）。arguments は object か JSON 文字列。
interface ToolCall {
	readonly name?: string;
	readonly arguments: unknown;
}

// FC レスポンスから tool_calls を機構差を吸収して集める。
// Workers AI traditional: { tool_calls: [{ name, arguments }] }
//   （一次ソース: function-calling/traditional/。arguments は object か JSON 文字列）。
// OpenAI 互換: { choices: [{ message: { tool_calls: [{ function: { name, arguments } }] } }] }。
function collectToolCalls(output: unknown): ToolCall[] {
	if (typeof output !== "object" || output === null) return [];
	const root = output as { tool_calls?: unknown; choices?: unknown };
	const calls: ToolCall[] = [];
	pushToolCalls(root.tool_calls, calls);
	if (Array.isArray(root.choices)) {
		for (const choice of root.choices) {
			const messageCalls = (choice as { message?: { tool_calls?: unknown } })
				?.message?.tool_calls;
			pushToolCalls(messageCalls, calls);
		}
	}
	return calls;
}

function pushToolCalls(raw: unknown, into: ToolCall[]): void {
	if (!Array.isArray(raw)) return;
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as {
			name?: unknown;
			arguments?: unknown;
			// OpenAI 形は name/arguments を function 配下に持つ。
			function?: { name?: unknown; arguments?: unknown };
		};
		const fn = obj.function;
		const name =
			typeof obj.name === "string"
				? obj.name
				: typeof fn?.name === "string"
					? fn.name
					: undefined;
		into.push({ name, arguments: obj.arguments ?? fn?.arguments });
	}
}

// FC（tool_calls）レスポンスから生フィールドを取り出す。想定外・該当無しは {}（落とさない）。
// 目的のツール（EXTRACTION_TOOL_NAME）を優先し、無ければ先頭の有効な call を採る。
function extractFcRawFields(output: unknown): RawExtractionFields {
	const calls = collectToolCalls(output);
	const ordered = [
		...calls.filter((c) => c.name === EXTRACTION_TOOL_NAME),
		...calls.filter((c) => c.name !== EXTRACTION_TOOL_NAME),
	];
	for (const call of ordered) {
		const obj =
			typeof call.arguments === "string"
				? safeParse(call.arguments)
				: call.arguments;
		const fields = fieldsFromObject(obj);
		if (Object.keys(fields).length > 0) return fields;
	}
	return {};
}

// 機構に応じてレスポンスを生フィールドへパースする（決定的）。両機構とも fieldsFromObject へ合流する。
function parseExtractionOutput(
	output: unknown,
	mechanism: ExtractionMechanism,
): RawExtractionFields {
	return mechanism === "function-calling"
		? extractFcRawFields(output)
		: extractRawFields(output);
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

// 求人本文を構造化抽出し、正規スキーマへ寄せた抽出結果を返す（§7.1 / §5.3）。
// - 出力機構（json-mode / function-calling）はモデル ID から解決する（options.mechanism で上書き可・#107）。
//   両機構とも同じ正規化（rawFieldsToNormalizedJob）へ合流する。
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
	// 使用モデルは options.model（注入）を優先し、未指定はコード既定へ解決する（アダプタの差し戻し点・#106）。
	const model = resolveExtractionModel(options.model);
	// 機構は options.mechanism を優先し、未指定はモデル ID から解決する（カタログ駆動・#107）。
	const mechanism = options.mechanism ?? resolveExtractionMechanism(model);
	// max_tokens は options.maxTokens を優先し、未指定はモデル ID からカタログ解決する（#147）。
	const maxTokens = options.maxTokens ?? resolveExtractionMaxTokens(model);
	// 空判定は trimHtml の出力契約（空文字の可能性）に従う。AI 呼出前に弾く。
	if (body.trim() === "") {
		return {
			job: allUnknownJob(),
			model,
			mechanism,
			extractedAt,
			status: "ok",
		};
	}

	const inputs = buildExtractionRequest(body, mechanism, maxTokens);
	for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
		try {
			const output = await ai.run(model, inputs);
			// throw されない想定外レスポンス（スキーマ未充足等）は upstream 障害ではない。
			// 全 unknown へ畳むが status は ok（リトライ対象外）。
			const fields = parseExtractionOutput(output, mechanism);
			return {
				job: rawFieldsToNormalizedJob(fields),
				model,
				mechanism,
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
		model,
		mechanism,
		extractedAt,
		status: "extraction_failed",
	};
}

// extractJobFromHtml の任意オプション。extractJob のオプションにコンテンツ予算を加える（#107 Task 14）。
export interface ExtractFromHtmlOptions
	extends ExtractJobOptions,
		PrepareContentOptions {}

// 生 HTML からコンテンツ準備（セクション保持つきトリミング）→ 抽出までを束ねる（#107 Task 14）。
// - 予算内: 主パス 1 回（従来の extractJob(trimHtml(html)) と同等。golden 入力を変えない）。
// - 予算超過: 主パス（切り詰め本文）＋ benefits パス（福利厚生/休暇セクション）の分割パスで抽出し、
//   benefits 系キーを統合する。長文での 504 / context 超過を避けつつ benefitsCoverage を落とさない。
export async function extractJobFromHtml(
	ai: AiRunner,
	rawHtml: string,
	options: ExtractFromHtmlOptions = {},
): Promise<ExtractionResult> {
	const prepared = prepareExtractionContent(rawHtml, {
		maxChars: options.maxChars,
	});
	const mainResult = await extractJob(ai, prepared.main, options);
	if (!prepared.split) return mainResult;

	// 分割パス: benefits セクションだけで再抽出し、福利厚生/年間休日を主パスへ統合する。
	const benefitsResult = await extractJob(ai, prepared.benefits, options);
	return {
		job: mergeBenefitFields(mainResult.job, benefitsResult.job),
		model: mainResult.model,
		mechanism: mainResult.mechanism,
		extractedAt: mainResult.extractedAt,
		// どちらかのパスが成立すれば抽出は成立。両方失敗のときだけ extraction_failed。
		status:
			mainResult.status === "ok" || benefitsResult.status === "ok"
				? "ok"
				: "extraction_failed",
	};
}
