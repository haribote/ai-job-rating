// 取得戦略のオーケストレーション層（#115 / 実装計画 Task 22）。
//
// なぜこのモジュールが存在するか:
// - fetch 優先 → 安価な SPA 検出 → 必要時のみ Browser Rendering（BR）という方針を、
//   既存の取得ユニット（fetch-html / render-html）の責務を保ったまま 1 か所に束ねるため。
// - SSR で本文が取れるページは BR を呼ばずに完結させ、未描画 SPA シェルのときだけ BR へ
//   フォールバックして BR 呼出（従量課金・同時実行枠）を必要最小に抑える（要件 §8・コスト最小化）。
// - transient/504 等の一過性失敗はバックオフ再試行で吸収する（再試行制御は rate-concurrency に委譲）。
// - SPA 検出・フォールバック条件・再試行判定はすべて決定的にしてユニットテスト可能に保つ。
//   実ブラウザ・実ネットワークは fetchHtml/renderHtml の DI 越しに差し替える（live 検証は #116）。

import { retryWithBackoff, type SleepFn } from "../queue/rate-concurrency";
import {
	RenderHtmlError,
	type RenderHtmlOptions,
	type RenderHtmlResult,
	renderHtml,
} from "../render-html";
import {
	AuthFetchError,
	type CookieInput,
	type CookiePair,
	type FetchAuthedHtmlOptions,
	fetchAuthedHtml,
	parseCookiePairs,
} from "./fetch-authed-html";
import {
	FetchHtmlError,
	type FetchHtmlOptions,
	type FetchHtmlResult,
	fetchHtml,
} from "./fetch-html";

// 取得経路の DI シグネチャ。テストが実ネットワーク・実ブラウザなしで差し替えられるよう最小型で持つ。
export type FetchHtmlFn = (
	url: string,
	options?: FetchHtmlOptions,
) => Promise<FetchHtmlResult>;
export type RenderHtmlFn = (
	binding: unknown,
	url: string,
	options?: RenderHtmlOptions,
) => Promise<RenderHtmlResult>;
// 認証下取得の DI シグネチャ。cookie 非空時に fetch 経路をこれへ切り替える。
export type FetchAuthedHtmlFn = (
	url: string,
	cookie: CookieInput,
	options?: FetchAuthedHtmlOptions,
) => Promise<FetchHtmlResult>;

// どの経路で取得したか。後段（取込・抽出）はこれを区別する必要はないが、観測・テスト用に保持する。
export type FetchSource = "fetch" | "render";

// 取得結果。fetch/BR いずれの経路でも同形（FetchHtmlResult と互換）にし、後段が経路を意識せず扱える。
export interface FetchStrategyResult {
	url: string;
	status: number;
	html: string;
	source: FetchSource;
}

// SPA 判定の既定しきい値（可視テキスト文字数）。これ未満かつマウント痕跡があれば未描画シェルとみなす。
// なぜ文字数か: 軽量・決定的に「本文が実質空か」を測れる。典型的な求人詳細は数千字あり余裕で超えるため
// SSR ページを SPA と誤判定して BR を無駄に呼ぶことがない（コスト最小化）。フォーク先は引数で上書きできる。
export const DEFAULT_SPA_MIN_TEXT_CHARS = 200;

// 既定の再試行回数・初回バックオフ。一過性失敗を数回だけ吸収する控えめな値にする（取得元への配慮 §8）。
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;

// 可視テキスト抽出用。script/style 等は中身ごと落とし、コメント・タグを除いて本文だけ残す（list-detail と同方針）。
const STRIP_WITH_CONTENT =
	/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ANY_TAG = /<[^>]+>/g;

// SPA マウント痕跡。空の root/app/__next コンテナや module/バンドルスクリプトは
// 「JS で後から描画されるシェル」を示す。本文が乏しいときのみこれらを根拠に BR へ回す。
const SPA_ROOT_HINT = /<(?:div|main)\b[^>]*\bid=["']?(?:root|app|__next)["']?/i;
const MODULE_SCRIPT = /<script\b[^>]*\btype=["']module["']/i;
const BUNDLE_SCRIPT = /<script\b[^>]*\bsrc=["'][^"']*\.(?:m?js|bundle\.js)/i;

// 取得 HTML が「未描画 SPA シェル」らしいかを安価・決定的に判定する。
// 可視テキストが minTextChars 以上あれば SSR とみなし false（BR 不要）。
// 乏しい場合のみ SPA マウント痕跡の有無で判定し、痕跡が無ければ false（誤って BR を呼ばない）。
export function isLikelySpa(
	html: string,
	minTextChars: number = DEFAULT_SPA_MIN_TEXT_CHARS,
): boolean {
	const text = html
		.replace(STRIP_WITH_CONTENT, " ")
		.replace(HTML_COMMENT, " ")
		.replace(ANY_TAG, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length >= minTextChars) {
		return false;
	}
	return (
		SPA_ROOT_HINT.test(html) ||
		MODULE_SCRIPT.test(html) ||
		BUNDLE_SCRIPT.test(html)
	);
}

// fetch の一過性失敗（バックオフ再試行対象）か判定する。
// network/timeout と 5xx（502/503/504 等）は時間を置けば回復しうる。4xx は恒久失敗で対象外。
export function isTransientFetchError(error: unknown): boolean {
	if (!(error instanceof FetchHtmlError)) {
		return false;
	}
	if (error.kind === "network" || error.kind === "timeout") {
		return true;
	}
	return (
		error.kind === "http" && error.status !== undefined && error.status >= 500
	);
}

// BR の一過性失敗か判定する。launch 失敗は同時実行枠超過・binding 不調など時間で回復しうる。
// timeout/render は再試行しても改善しないことが多いため対象外（無駄な BR 呼出を避ける）。
export function isTransientRenderError(error: unknown): boolean {
	return error instanceof RenderHtmlError && error.kind === "launch";
}

export interface FetchStrategyOptions {
	// BR バインディング（env.BROWSER）。未指定なら SPA を検出しても BR せず fetch 結果を返す
	// （フォーク容易性・テスト容易性: binding 無しでも取得戦略が成立する）。
	browser?: unknown;
	// 認証下取得の Cookie（生文字列 or name/value ペア）。非空なら fetch 経路を authed fetch に
	// 切り替え、BR フォールバック時は分解した pairs を renderHtml へ渡す（#189）。
	cookie?: CookieInput;
	// fetch 層へ渡すオプション（fetcher 注入・timeout・headers・redirect 等）。
	fetch?: FetchHtmlOptions;
	// BR 層へ渡すオプション（launch 注入・timeout）。
	render?: RenderHtmlOptions;
	// SPA 判定しきい値（可視テキスト文字数）。未指定は DEFAULT_SPA_MIN_TEXT_CHARS。
	spaMinTextChars?: number;
	// 一過性失敗の最大再試行回数。未指定は DEFAULT_RETRIES。
	retries?: number;
	// 初回バックオフ待機（ms）。未指定は DEFAULT_BASE_DELAY_MS。
	baseDelayMs?: number;
	// 待機関数。レート/バックオフの待ちに使う。テストでは注入して決定的にする。
	sleep?: SleepFn;
	// テスト用の取得経路差し替え。未指定は実体（fetchHtml / renderHtml / fetchAuthedHtml）。
	fetchHtmlFn?: FetchHtmlFn;
	renderHtmlFn?: RenderHtmlFn;
	fetchAuthedHtmlFn?: FetchAuthedHtmlFn;
}

// fetch 優先 → 安価な SPA 検出 → 必要時のみ BR、という取得戦略を 1 回の取得として実行する。
// - SSR で本文が取れれば BR を呼ばず即返す（コスト最小化）。
// - 未描画 SPA シェルかつ BR バインディングがあるときだけ BR へフォールバックする。
// - fetch/BR の一過性失敗はバックオフ再試行で吸収し、恒久失敗・回数超過はそのまま throw する。
export async function fetchWithStrategy(
	url: string,
	options: FetchStrategyOptions = {},
): Promise<FetchStrategyResult> {
	const fetchFn = options.fetchHtmlFn ?? fetchHtml;
	const renderFn = options.renderHtmlFn ?? renderHtml;
	const authedFetchFn = options.fetchAuthedHtmlFn ?? fetchAuthedHtml;
	const retries = options.retries ?? DEFAULT_RETRIES;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const sleep = options.sleep;

	// cookie が非空なら認証下取得へ分岐する（fetch 経路は authed、BR 経路は pairs を setCookie）。
	const cookie = options.cookie;
	const useAuthed =
		cookie !== undefined &&
		(typeof cookie === "string" ? cookie !== "" : cookie.length > 0);

	// 1) SSR fetch を優先する。一過性失敗のみバックオフ再試行（4xx 等は即 throw でコストを無駄にしない）。
	// AuthFetchError（auth/invalid-credential/redirect）は非 transient なのでそのまま透過する。
	const fetched = await retryWithBackoff(
		() =>
			cookie !== undefined && useAuthed
				? authedFetchFn(url, cookie, {
						fetcher: options.fetch?.fetcher,
						timeoutMs: options.fetch?.timeoutMs,
					})
				: fetchFn(url, options.fetch),
		{
			retries,
			baseDelayMs,
			isRetryable: isTransientFetchError,
			sleep,
		},
	);

	// 2) 安価な SPA 検出。本文が取れていれば BR を呼ばない（必要最小の BR 呼出）。
	const needsRender = isLikelySpa(fetched.html, options.spaMinTextChars);
	if (!needsRender || options.browser === undefined) {
		return {
			url: fetched.url,
			status: fetched.status,
			html: fetched.html,
			source: "fetch",
		};
	}

	// 3) SPA のみ BR フォールバック。認証下なら cookie を pairs へ分解して渡す（url 限定 setCookie）。
	// 分解不能な cookie は BR へ渡す前に弾く（無駄な起動を避け、生値も載せない・最小保持）。
	let cookiePairs: CookiePair[] | undefined;
	if (cookie !== undefined && useAuthed) {
		const parsed = parseCookiePairs(cookie);
		if (!parsed.ok) {
			throw new AuthFetchError({
				kind: "invalid-credential",
				url,
				message: `invalid cookie input (${parsed.reason}): ${url}`,
			});
		}
		cookiePairs = parsed.pairs;
	}
	const rendered = await retryWithBackoff(
		() =>
			renderFn(options.browser, url, {
				...options.render,
				cookie: cookiePairs,
			}),
		{
			retries,
			baseDelayMs,
			isRetryable: isTransientRenderError,
			sleep,
		},
	);
	return {
		url: rendered.url,
		status: rendered.status,
		html: rendered.html,
		source: "render",
	};
}
