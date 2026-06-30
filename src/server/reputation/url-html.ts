// 評判ページの URL/HTML 投入 → AI 抽出経路（fetch_method = "url_html"・#35）。
//
// なぜこのモジュールが存在するか:
// - #30 の web_search 自動取得が使えない/不十分なとき、評判ページの URL か HTML を投入して構造化スコアを
//   取り出す補助経路を用意する（§7.2 の補助/フォールバック）。
// - 抽出は Workers AI（既存抽出機構の AiRunner / resolveExtractionModel を再利用）。Claude API は使わないため
//   ANTHROPIC_API_KEY 非依存（#31 の前提を満たさなくても動く）。json_mode に固定せず、prompt で JSON を促し
//   応答を防御的にパースして堅牢にする（モデル差異に強くする・gpt-oss 等は CF JSON Mode 非対応・#106）。
// - 取得は fetchWithStrategy（#115）を再利用（fetch 優先 → SPA 検出 → 必要時 BR・backoff）。HTML 直接投入は
//   ネットワーク不要。取得・構造化・保存までで止め、加重合算（#36）・カテゴリ合流（#117）には踏み込まない（§5.3）。
// - 入力検証は決定的な純関数（reputation-config.ts の流儀）。AI を呼ぶ前に不正入力を弾く（コスト保護）。

import type { CorporateNumberClient } from "../companies/houjin-bangou";
import type { AiRunner } from "../extract/ai";
import { resolveExtractionModel } from "../extract/extract";
import { trimHtml } from "../extract/trim-html";
import { FetchHtmlError, type FetchHtmlErrorKind } from "../fetch/fetch-html";
import {
	type FetchStrategyOptions,
	fetchWithStrategy,
} from "../fetch/fetch-strategy";
import { validateJobUrl, validatePastedHtml } from "../jobs";
import type { CompaniesStoreOptions } from "../storage/companies-store";
import type { ReputationSnapshotRow } from "../storage/db-schema";
import {
	type ReputationStoreOptions,
	saveReputationSnapshot,
} from "../storage/reputation-store";
import { resolveCompanyForReputation } from "./attach";
import { asRecord, isFiniteNonNegativeNumber } from "./parse-utils";

// ---------------------------------------------------------------------------
// 入力検証（純関数）
// ---------------------------------------------------------------------------

// 入力検証の失敗分類。body=url/html 排他違反、too-large は 413、それ以外は 400 にルートが対応させる。
export type UrlHtmlReputationInputError =
	| "companyName"
	| "source"
	| "body"
	| "url"
	| "html"
	| "too-large";

// URL 投入と HTML 直接投入を判別した検証済み値。company 解決用 companyName と上書き対象 source を伴う。
export type UrlHtmlReputationValue =
	| { companyName: string; source: string; mode: "url"; url: string }
	| { companyName: string; source: string; mode: "html"; html: string };

// URL/HTML 投入の入力を決定的に検証する純関数。url と html は排他（POST /api/jobs と同方針）。
export function parseUrlHtmlReputationInput(
	raw: unknown,
):
	| { ok: true; value: UrlHtmlReputationValue }
	| { ok: false; reason: UrlHtmlReputationInputError } {
	const o = asRecord(raw);
	if (o === null) return { ok: false, reason: "companyName" };

	if (typeof o.companyName !== "string")
		return { ok: false, reason: "companyName" };
	const companyName = o.companyName.trim();
	if (companyName === "") return { ok: false, reason: "companyName" };

	if (typeof o.source !== "string") return { ok: false, reason: "source" };
	const source = o.source.trim();
	if (source === "") return { ok: false, reason: "source" };

	const hasUrl = typeof o.url === "string";
	const hasHtml = typeof o.html === "string";
	// url と html は排他。両方・どちらも無いは入力エラー。
	if (hasUrl === hasHtml) return { ok: false, reason: "body" };

	if (hasUrl) {
		const validated = validateJobUrl(o.url as string);
		if (!validated.ok) return { ok: false, reason: "url" };
		return {
			ok: true,
			value: { companyName, source, mode: "url", url: validated.url },
		};
	}

	const validated = validatePastedHtml(o.html as string);
	if (!validated.ok) {
		return {
			ok: false,
			reason: validated.reason === "too-large" ? "too-large" : "html",
		};
	}
	return {
		ok: true,
		value: { companyName, source, mode: "html", html: validated.html },
	};
}

// ---------------------------------------------------------------------------
// AI 抽出（Workers AI・構造化スコア）
// ---------------------------------------------------------------------------

// 抽出された評判スコア（snapshot 保存形に対応）。取れなければ NULL（unknown 中立・分母除外は #36）。
export interface ReputationExtraction {
	overallScore: number | null;
	reviewCount: number | null;
	subScores: Record<string, number> | null;
}

// 抽出結果。status: extraction_failed は AI 障害（中立スコアと誤認させない・negative cache を汚さない）。
export type ReputationExtractionResult = ReputationExtraction & {
	model: string;
	status: "ok" | "extraction_failed";
};

// 抽出の任意オプション。model はアダプタの差し戻し点（未指定はコード既定へ解決・#106）。
export interface ReputationExtractOptions {
	model?: string;
}

// 抽出させる JSON の形を prompt で明示する。判定・正規化はコード側に保ち、モデルには素の値だけ出させる。
const REPUTATION_SYSTEM_PROMPT = [
	"あなたは企業の評判ページ（口コミサイト等）から事実を抽出するアシスタントです。",
	"与えられた本文から、企業の評判スコアを次の JSON オブジェクト 1 つだけで返してください:",
	'{ "overallScore": number|null, "reviewCount": number|null, "subScores": { [key: string]: number }|null }',
	"overallScore は総合評価スコアの数値。reviewCount は口コミ件数の整数。",
	"subScores は成長/年収/残業 等の項目別スコア（項目名→数値）。",
	"値が本文に無い項目は null にしてください。推測や創作はせず、本文に書かれた数値のみを使ってください。",
].join("\n");

// trim 済み本文から抽出用 messages を組み立てる（決定的）。
export function buildReputationExtractionMessages(
	body: string,
): { role: "system" | "user"; content: string }[] {
	return [
		{ role: "system", content: REPUTATION_SYSTEM_PROMPT },
		{ role: "user", content: body },
	];
}

// 数値を有限・非負に正規化する。範囲外・非数は null（unknown 中立）。
function finiteNonNegative(value: unknown): number | null {
	return isFiniteNonNegativeNumber(value) ? value : null;
}

// AI 応答から評判スコアを決定的に取り出す純関数。想定外形は全 null へ畳む（落とさない）。
// Workers AI の {response: ...} と OpenAI 互換の {choices:[{message:{content}}]} の双方に対応する。
export function parseReputationAiOutput(output: unknown): ReputationExtraction {
	const obj = extractJsonObject(output);
	if (obj === null) {
		return { overallScore: null, reviewCount: null, subScores: null };
	}

	const overallScore = finiteNonNegative(obj.overallScore);

	// review_count は整数列。小数は四捨五入し、負・非数は null。
	const rawCount = finiteNonNegative(obj.reviewCount);
	const reviewCount = rawCount === null ? null : Math.round(rawCount);

	// subScores は有限非負の数値項目のみ採用。空になれば null（取得したが該当なし）。
	let subScores: Record<string, number> | null = null;
	const sub = asRecord(obj.subScores);
	if (sub !== null) {
		const out: Record<string, number> = {};
		for (const [key, value] of Object.entries(sub)) {
			const num = finiteNonNegative(value);
			if (num !== null) out[key] = num;
		}
		if (Object.keys(out).length > 0) subScores = out;
	}

	return { overallScore, reviewCount, subScores };
}

// AI 応答（多様な形）から JSON オブジェクトを取り出す。失敗は null。
function extractJsonObject(output: unknown): Record<string, unknown> | null {
	// 既にオブジェクトで対象キーを持つならそのまま使う。
	const direct = asRecord(output);
	if (direct !== null) {
		const response = direct.response;
		// Workers AI: { response: object|string }。response が record でない（配列等）の場合は
		// ここで null へ畳まず、下の choices / 素のオブジェクト候補へフォールスルーする。
		if (typeof response === "object" && response !== null) {
			const record = asRecord(response);
			if (record !== null) return record;
		}
		if (typeof response === "string") {
			return parseJsonLoose(response);
		}
		// OpenAI 互換: { choices: [{ message: { content: string } }] }
		const content = readChoicesContent(direct);
		if (content !== null) return parseJsonLoose(content);
		// 対象キーを直接持つ素のオブジェクト。
		if (
			"overallScore" in direct ||
			"reviewCount" in direct ||
			"subScores" in direct
		) {
			return direct;
		}
	}
	if (typeof output === "string") return parseJsonLoose(output);
	return null;
}

// choices[0].message.content（文字列）を安全に取り出す（ai.ts の extractReply と同方針）。
function readChoicesContent(obj: Record<string, unknown>): string | null {
	const choices = obj.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const content = (choices[0] as { message?: { content?: unknown } })?.message
		?.content;
	return typeof content === "string" ? content : null;
}

// 文字列を JSON として緩くパースする。```json フェンスや前後の地の文を許容する。
function parseJsonLoose(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		// フェンスや前後テキストを含む場合に最初の { ... } を取り出して再試行する。
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) return null;
		try {
			return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
		} catch {
			return null;
		}
	}
}

// 生 HTML を trim → Workers AI で評判スコアを抽出する。空本文は AI を呼ばず全 null（コスト最小化）。
// AI が throw しても落とさず extraction_failed に畳む（negative cache を汚さない判断は呼び出し側）。
export async function extractReputationFromHtml(
	ai: AiRunner,
	rawHtml: string,
	options: ReputationExtractOptions = {},
): Promise<ReputationExtractionResult> {
	const model = resolveExtractionModel(options.model);
	const body = trimHtml(rawHtml);
	if (body.trim() === "") {
		return {
			overallScore: null,
			reviewCount: null,
			subScores: null,
			model,
			status: "ok",
		};
	}

	try {
		const output = await ai.run(model, {
			messages: buildReputationExtractionMessages(body),
		});
		return { ...parseReputationAiOutput(output), model, status: "ok" };
	} catch {
		return {
			overallScore: null,
			reviewCount: null,
			subScores: null,
			model,
			status: "extraction_failed",
		};
	}
}

// ---------------------------------------------------------------------------
// オーケストレーション（取得 → 抽出 → 保存）
// ---------------------------------------------------------------------------

// URL/HTML 投入の依存。fetchStrategy / extract はテストで差し替え可能にし live を避ける。
export interface UrlHtmlReputationDeps {
	db: D1Database;
	ai: AiRunner;
	client: CorporateNumberClient;
	// BR バインディング（env.BROWSER）。SPA の評判ページ取得フォールバックに使う（任意）。
	browser?: unknown;
	fetchStrategy?: typeof fetchWithStrategy;
	extract?: typeof extractReputationFromHtml;
	fetchOptions?: FetchStrategyOptions;
	extractOptions?: ReputationExtractOptions;
	snapshotOpts?: ReputationStoreOptions;
	companyOpts?: CompaniesStoreOptions;
}

// 取得 → 抽出 → 保存の結果。ルートが HTTP ステータスへ対応させる判別共用体。
export type IngestUrlHtmlReputationResult =
	| { kind: "saved"; snapshot: ReputationSnapshotRow }
	| { kind: "job-not-found" }
	| { kind: "company-unresolved" }
	| { kind: "fetch-error"; reason: FetchHtmlErrorKind | "unknown" }
	| { kind: "extraction-failed" };

// URL/HTML 投入を取得（必要なら）→ AI 抽出 → company 単位 snapshot へ保存する高レベル経路。
export async function ingestUrlHtmlReputation(
	deps: UrlHtmlReputationDeps,
	jobId: string,
	value: UrlHtmlReputationValue,
): Promise<IngestUrlHtmlReputationResult> {
	// company 解決を先に行い、不正な job / 名寄せ不能では取得・AI を呼ばない（コスト保護）。
	const resolved = await resolveCompanyForReputation(
		deps.db,
		jobId,
		value.companyName,
		deps.client,
		deps.companyOpts,
	);
	if (!resolved.ok) {
		return resolved.reason === "job_not_found"
			? { kind: "job-not-found" }
			: { kind: "company-unresolved" };
	}

	let html: string;
	if (value.mode === "url") {
		const fetchStrategy = deps.fetchStrategy ?? fetchWithStrategy;
		try {
			const result = await fetchStrategy(value.url, {
				browser: deps.browser,
				...deps.fetchOptions,
			});
			html = result.html;
		} catch (cause) {
			const reason = cause instanceof FetchHtmlError ? cause.kind : "unknown";
			return { kind: "fetch-error", reason };
		}
	} else {
		html = value.html;
	}

	const extract = deps.extract ?? extractReputationFromHtml;
	const extracted = await extract(deps.ai, html, deps.extractOptions);
	// AI 障害時は保存しない（全 null の negative cache で「該当なし」を装わない）。
	if (extracted.status === "extraction_failed") {
		return { kind: "extraction-failed" };
	}

	const snapshot = await saveReputationSnapshot(
		deps.db,
		{
			companyId: resolved.companyId,
			source: value.source,
			overallScore: extracted.overallScore,
			reviewCount: extracted.reviewCount,
			subScores: extracted.subScores,
		},
		deps.snapshotOpts,
	);
	return { kind: "saved", snapshot };
}
