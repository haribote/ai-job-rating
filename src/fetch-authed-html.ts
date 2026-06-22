// 認証下（Cookie/セッション要）の単一詳細 URL を取得する取得層。
// 責務は「Cookie ヘッダ組立」と「取得（fetchHtml への委譲）」「認証失敗の分類」に限定する。
// 最小権限・最小保持（§8 / §10）: 受け取った Cookie は取得時のヘッダにだけ使い、
//   結果・例外・ログのいずれにも生値を残さない。永続化はこの層では行わない。

import {
	FetchHtmlError,
	type FetchHtmlOptions,
	type FetchHtmlResult,
	fetchHtml,
} from "./fetch-html";

// Cookie 入力。生の Cookie ヘッダ文字列、または name/value ペア配列のいずれかを受け取る。
// 生文字列は DevTools 等からのコピー貼り付け、ペアは構造化投入を想定する。
export interface CookiePair {
	name: string;
	value: string;
}
export type CookieInput = string | CookiePair[];

// Cookie ヘッダ組立の決定的結果。invalid は構文不正、empty は実質空入力。
export type CookieHeaderResult =
	| { ok: true; value: string }
	| { ok: false; reason: "empty" | "invalid" };

// 認証失敗の分類。auth は 401/403（Cookie 失効・権限不足）、invalid-credential は投入 Cookie の構文不正。
// http/network/timeout 等は取得層の FetchHtmlError をそのまま透過し二重に包まない。
export type AuthFetchErrorKind = "auth" | "invalid-credential";

// 認証下取得の失敗を表す例外。後続（#26）が失効/不正投入を判別できるよう種別を型で持つ。
// 最小保持: Cookie 生値は一切保持・出力しない（message も含めない）。
export class AuthFetchError extends Error {
	readonly kind: AuthFetchErrorKind;
	readonly url: string;
	readonly status?: number;

	constructor(args: {
		kind: AuthFetchErrorKind;
		url: string;
		status?: number;
		message: string;
		cause?: unknown;
	}) {
		super(args.message, { cause: args.cause });
		this.name = "AuthFetchError";
		this.kind = args.kind;
		this.url = args.url;
		this.status = args.status;
	}
}

// RFC6265 §4.1.1 token（cookie-name）。区切り文字・制御文字・空白を含まない。
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC6265 §4.1.1 cookie-octet（CTL・空白・DQUOTE・comma・semicolon・backslash を除く US-ASCII）。
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
// 制御文字（C0 + DEL）。生文字列に 1 つでも含めば取得層へ渡さず弾く。
// これらは fetch()/Headers が TypeError を投げ、その message に Cookie 生値が載って
// cause 経由で漏れる（最小保持違反）。取得前に遮断して漏洩経路自体を塞ぐ。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的のため意図的
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// 生 Cookie 文字列は前後 OWS のみ整え、制御文字を含めば弾く。
// 内部の name/value 構文は利用者がブラウザからコピーした正規の Cookie 前提で過剰に弾かないが、
// 制御文字（CR/LF・NUL 等）は注入・漏洩経路になるため必ず拒否する。
function buildFromString(raw: string): CookieHeaderResult {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: false, reason: "empty" };
	}
	if (CONTROL_CHAR_RE.test(trimmed)) {
		return { ok: false, reason: "invalid" };
	}
	return { ok: true, value: trimmed };
}

// ペア配列は各 name/value を RFC6265 構文で検証し "; "（semicolon + SP）で連結する。
function buildFromPairs(pairs: CookiePair[]): CookieHeaderResult {
	if (pairs.length === 0) {
		return { ok: false, reason: "empty" };
	}
	for (const { name, value } of pairs) {
		if (!COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value)) {
			return { ok: false, reason: "invalid" };
		}
	}
	const value = pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
	return { ok: true, value };
}

// Cookie 入力を Cookie ヘッダ値へ決定的に正規化する。失敗理由を型で返す（throw しない）。
export function buildCookieHeader(input: CookieInput): CookieHeaderResult {
	return typeof input === "string"
		? buildFromString(input)
		: buildFromPairs(input);
}

// 401/403 を認証失敗とみなす。Cookie 失効・権限不足の代表的ステータス。
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

export interface FetchAuthedHtmlOptions {
	timeoutMs?: number;
	// テスト用に fetch を差し替える。未指定時は fetchHtml が globalThis.fetch を使う
	fetcher?: FetchHtmlOptions["fetcher"];
}

// Cookie/セッションを付与して認証下ページを取得する。
// - Cookie 構文不正は取得を呼ばず AuthFetchError(invalid-credential) を投げる（無駄打ち・注入防止）。
// - 401/403 は AuthFetchError(auth) へ分類し、それ以外の取得失敗は FetchHtmlError を透過する。
// - 最小保持: Cookie 生値は取得ヘッダにのみ使い、結果・例外・ログへ残さない。
export async function fetchAuthedHtml(
	url: string,
	cookie: CookieInput,
	options: FetchAuthedHtmlOptions = {},
): Promise<FetchHtmlResult> {
	const header = buildCookieHeader(cookie);
	if (!header.ok) {
		// Cookie 生値は埋め込まず、不正の事実と理由だけを返す（最小保持・ログ漏洩防止）。
		throw new AuthFetchError({
			kind: "invalid-credential",
			url,
			message: `invalid cookie input (${header.reason}): ${url}`,
		});
	}

	try {
		return await fetchHtml(url, {
			fetcher: options.fetcher,
			timeoutMs: options.timeoutMs,
			headers: { cookie: header.value },
		});
	} catch (cause) {
		// 401/403 のみ認証失敗へ昇格する。Cookie 生値は cause にも持たせない（status だけ引き継ぐ）。
		if (
			cause instanceof FetchHtmlError &&
			cause.kind === "http" &&
			cause.status !== undefined &&
			AUTH_FAILURE_STATUSES.has(cause.status)
		) {
			throw new AuthFetchError({
				kind: "auth",
				url,
				status: cause.status,
				message: `authentication failed (HTTP ${cause.status}): ${url}`,
			});
		}
		// その他の取得失敗（http(他)/network/timeout）は取得層の型のまま透過する。
		throw cause;
	}
}
