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

// 認証失敗の分類。auth は 401/403（Cookie 失効・権限不足）、invalid-credential は投入 Cookie の構文不正、
// redirect は安全に追従できない redirect（クロスオリジン・Location 不明・追従上限超過）。
// http/network/timeout 等は取得層の FetchHtmlError をそのまま透過し二重に包まない。
export type AuthFetchErrorKind = "auth" | "invalid-credential" | "redirect";

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

// name/value ペア分解の決定的結果。invalid は構文不正、empty は実質空入力。
export type CookiePairsResult =
	| { ok: true; pairs: CookiePair[] }
	| { ok: false; reason: "empty" | "invalid" };

// 生 Cookie 文字列を name/value ペアへ分解する。";" で分割し各要素を最初の "=" で割る。
// 制御文字は注入・漏洩経路になるため取得前に弾く（buildFromString と同方針）。
function parsePairsFromString(raw: string): CookiePairsResult {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: false, reason: "empty" };
	}
	if (CONTROL_CHAR_RE.test(trimmed)) {
		return { ok: false, reason: "invalid" };
	}
	const pairs: CookiePair[] = [];
	for (const segment of trimmed.split(";")) {
		const part = segment.trim();
		if (part === "") {
			continue;
		}
		const eq = part.indexOf("=");
		if (eq <= 0) {
			// "=" 無し・空 name（"=value"）は分解不能。
			return { ok: false, reason: "invalid" };
		}
		const name = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (!COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value)) {
			return { ok: false, reason: "invalid" };
		}
		pairs.push({ name, value });
	}
	if (pairs.length === 0) {
		return { ok: false, reason: "empty" };
	}
	return { ok: true, pairs };
}

// ペア配列を RFC6265 構文で検証してそのまま返す（buildFromPairs と同じ検証）。
function parsePairsFromArray(input: CookiePair[]): CookiePairsResult {
	if (input.length === 0) {
		return { ok: false, reason: "empty" };
	}
	for (const { name, value } of input) {
		if (!COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value)) {
			return { ok: false, reason: "invalid" };
		}
	}
	return { ok: true, pairs: input.map(({ name, value }) => ({ name, value })) };
}

// Cookie 入力を name/value ペアへ決定的に分解する（BR の page.setCookie 用）。
// buildCookieHeader と同じ RFC6265 検証を用い、失敗時は理由だけ返す（生値を戻り値に載せない・最小保持）。
export function parseCookiePairs(input: CookieInput): CookiePairsResult {
	return typeof input === "string"
		? parsePairsFromString(input)
		: parsePairsFromArray(input);
}

// 401/403 を認証失敗とみなす。Cookie 失効・権限不足の代表的ステータス。
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

// Location で追従先を示す redirect ステータス（RFC9110）。これら以外の 3xx は追従しない。
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 認証下取得で追従する redirect の上限。リダイレクトループ・遅延攻撃を防ぐ。
const MAX_AUTH_REDIRECTS = 5;

// redirect 先が認可済みオリジン（取得開始 URL と同一オリジン）かを判定し、絶対 URL を返す。
// 別オリジン・scheme ダウングレード・Location 不明・解決不能はすべて null（追従不可）。
function resolveSameOriginRedirect(
	location: string | undefined,
	currentUrl: string,
	authorizedOrigin: string,
): string | null {
	if (location === undefined) {
		return null;
	}
	let target: URL;
	try {
		target = new URL(location, currentUrl);
	} catch {
		return null;
	}
	return target.origin === authorizedOrigin ? target.href : null;
}

export interface FetchAuthedHtmlOptions {
	timeoutMs?: number;
	// テスト用に fetch を差し替える。未指定時は fetchHtml が globalThis.fetch を使う
	fetcher?: FetchHtmlOptions["fetcher"];
}

// Cookie/セッションを付与して認証下ページを取得する。
// - Cookie 構文不正は取得を呼ばず AuthFetchError(invalid-credential) を投げる（無駄打ち・注入防止）。
// - redirect は手動追従し、認可済みオリジン（取得開始 URL と同一オリジン）にのみ Cookie を再送する。
//   別オリジンへの redirect は AuthFetchError(redirect) で弾き、Cookie を一切渡さない（漏洩防止）。
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

	// Cookie を再送してよいのは取得開始 URL と同一オリジンのみ。不正 URL は origin を空にして全 redirect を弾く。
	let authorizedOrigin = "";
	try {
		authorizedOrigin = new URL(url).origin;
	} catch {
		authorizedOrigin = "";
	}

	let currentUrl = url;
	for (let hop = 0; hop <= MAX_AUTH_REDIRECTS; hop++) {
		try {
			// redirect:"manual" で 3xx を捕捉し、追従可否を origin で自前判断する（runtime 任せにしない）。
			return await fetchHtml(currentUrl, {
				fetcher: options.fetcher,
				timeoutMs: options.timeoutMs,
				headers: { cookie: header.value },
				redirect: "manual",
			});
		} catch (cause) {
			if (
				cause instanceof FetchHtmlError &&
				cause.kind === "http" &&
				cause.status !== undefined
			) {
				// 401/403 のみ認証失敗へ昇格する。Cookie 生値は cause にも持たせない（status だけ引き継ぐ）。
				if (AUTH_FAILURE_STATUSES.has(cause.status)) {
					throw new AuthFetchError({
						kind: "auth",
						url,
						status: cause.status,
						message: `authentication failed (HTTP ${cause.status}): ${url}`,
					});
				}
				// redirect は同一オリジンのみ追従する。別オリジン等は Cookie を渡さず弾く。
				if (REDIRECT_STATUSES.has(cause.status)) {
					const next = resolveSameOriginRedirect(
						cause.location,
						currentUrl,
						authorizedOrigin,
					);
					if (next === null) {
						// クロスオリジン・Location 不明: 追従先へ fetch せず Cookie を漏らさない。
						throw new AuthFetchError({
							kind: "redirect",
							url,
							status: cause.status,
							message: `blocked unsafe redirect in authed fetch: ${url}`,
						});
					}
					currentUrl = next;
					continue;
				}
			}
			// その他の取得失敗（http(他)/network/timeout）は取得層の型のまま透過する。
			throw cause;
		}
	}
	// 追従上限超過。Cookie 生値は載せない。
	throw new AuthFetchError({
		kind: "redirect",
		url,
		message: `too many redirects in authed fetch: ${url}`,
	});
}
