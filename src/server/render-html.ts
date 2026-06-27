// SPA（クライアントレンダリング）ページを Browser Rendering で取得する取得層。
// 静的 fetch（fetch-html.ts）で本文が取れないケースのフォールバック経路として設計する。
// 責務は「取得」のみ: ナビゲーション・レンダリング後 HTML(text) 返却・エラー整形に限定し、
// 本文トリミング（trim-html）や構造化抽出（extract）はこの層に持ち込まない。
// ブラウザ起動は DI（BrowserLauncher 注入）して実ブラウザなしでユニットテスト可能にする。

// 取得結果。成功時はレンダリング後の HTML を返す。
// 静的取得（FetchHtmlResult）と同形にし、後続層（trim/抽出・#26 のエラー導線）が両経路を同じく扱える。
export interface RenderHtmlResult {
	url: string;
	// Browser Rendering はナビゲーション後の DOM を返すため、到達できた時点で 200 とみなす。
	status: 200;
	html: string;
}

// 取得失敗の分類。呼び出し側（#26 のエラー導線等）が分岐できるよう種別を型で表現する。
// - launch: ブラウザ起動失敗（同時実行枠超過・binding 不調）。時間を置けば回復しうる。
// - timeout: ナビゲーションが時間内に完了しなかった。
// - render: その他のレンダリング失敗（DNS・遷移エラー・content 取得失敗）。
export type RenderHtmlErrorKind = "launch" | "timeout" | "render";

// 取得失敗を表す例外。種別を保持し、呼び出し側が再試行・フォールバック判断できるようにする。
// fetch-html.ts の FetchHtmlError と同じ形（kind / url / cause）に揃え、#26 が両者を統一的に扱える。
export class RenderHtmlError extends Error {
	readonly kind: RenderHtmlErrorKind;
	readonly url: string;

	constructor(args: {
		kind: RenderHtmlErrorKind;
		url: string;
		message: string;
		cause?: unknown;
	}) {
		super(args.message, { cause: args.cause });
		this.name = "RenderHtmlError";
		this.kind = args.kind;
		this.url = args.url;
	}
}

// puppeteer ページの最小サブセット。テストが fake を注入できるよう必要な操作だけに絞る。
export interface RenderedPage {
	goto(
		url: string,
		options?: { waitUntil?: string; timeout?: number },
	): Promise<unknown>;
	content(): Promise<string>;
}

// puppeteer ブラウザの最小サブセット。
export interface RenderBrowser {
	newPage(): Promise<RenderedPage>;
	close(): Promise<void>;
}

// env.BROWSER（Browser Rendering binding）からブラウザを起動する関数。既定は @cloudflare/puppeteer の launch。
// テストはこれを注入してネットワーク・実ブラウザを避ける。
// binding は wrangler types 生成の BrowserWorker 型だが、テスト注入を妨げないよう unknown で受ける。
export type BrowserLauncher = (binding: unknown) => Promise<RenderBrowser>;

export interface RenderHtmlOptions {
	// ナビゲーションのタイムアウト（ms）。暴走 SPA の安全弁。未指定時は既定値を使う。
	timeoutMs?: number;
	// テスト用にブラウザ起動を差し替える。未指定時は @cloudflare/puppeteer を遅延 import する。
	launch?: BrowserLauncher;
}

// 既定タイムアウト。SPA レンダリングが長時間ぶら下がるのを防ぐ。
// SSR 取得（fetch-html）より JS 実行ぶん余裕を持たせる。
const DEFAULT_TIMEOUT_MS = 30_000;

// @cloudflare/puppeteer の最小サブセット。launch だけ参照する。
// 実 binding 越しの起動は wrangler dev / デプロイでの手動検証に委ねるため、ここでは型だけ定義する。
interface PuppeteerModule {
	default: { launch(binding: unknown): Promise<RenderBrowser> };
}

// 既定の launch を遅延 import する。テストが launch を注入する場合は @cloudflare/puppeteer を
// 読み込まないので、ブラウザ binding 専用の依存をテスト実行へ持ち込まない。
// 指定子は文字列リテラルにする: 変数経由だと wrangler/esbuild が静的解析できず
// @cloudflare/puppeteer をバンドルに含めないため、runtime で "No such module" になる
// （unit test も dry-run も検出できず、実デプロイでのみ露見する）。型は最小サブセットへ寄せる。
const defaultLaunch: BrowserLauncher = async (binding) => {
	const { default: puppeteer } = (await import(
		"@cloudflare/puppeteer"
	)) as unknown as PuppeteerModule;
	// @cloudflare/puppeteer の launch は BrowserWorker（env.BROWSER）を受ける。
	return puppeteer.launch(binding);
};

// ナビゲーション完了の待機条件。SPA は描画後の追加リクエストが落ち着くまで待つ必要があるため
// networkidle0 を使う（DOMContentLoaded では空シェルを掴むことがある）。
const WAIT_UNTIL = "networkidle0";

// タイムアウト由来の失敗を種別判定するためのマーカー。puppeteer は timeout 超過を
// "Navigation timeout" を含むメッセージで投げるため、それを timeout として分類する。
const TIMEOUT_MESSAGE_PATTERN = /timeout/i;

// 単一 SPA URL を Browser Rendering で取得し、レンダリング後 HTML(text) を返す。
// 起動失敗・タイムアウト・レンダリング失敗は RenderHtmlError に整形して throw する。
export async function renderHtml(
	binding: unknown,
	url: string,
	options: RenderHtmlOptions = {},
): Promise<RenderHtmlResult> {
	const launch = options.launch ?? defaultLaunch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let browser: RenderBrowser;
	try {
		browser = await launch(binding);
	} catch (cause) {
		// 起動失敗は同時実行枠超過・binding 不調など。後段で再試行/フォールバック判断できるよう種別を分ける。
		throw new RenderHtmlError({
			kind: "launch",
			url,
			message: `failed to launch browser: ${url}`,
			cause,
		});
	}

	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: timeoutMs });
		const html = await page.content();
		return { url, status: 200, html };
	} catch (cause) {
		// abort 相当（タイムアウト）かそれ以外かで種別を分け、呼び出し側が再試行判断できるようにする。
		const message = cause instanceof Error ? cause.message : String(cause);
		if (TIMEOUT_MESSAGE_PATTERN.test(message)) {
			throw new RenderHtmlError({
				kind: "timeout",
				url,
				message: `render timed out after ${timeoutMs}ms: ${url}`,
				cause,
			});
		}
		throw new RenderHtmlError({
			kind: "render",
			url,
			message: `render error while loading: ${url}`,
			cause,
		});
	} finally {
		// セッションを確実に閉じて同時実行枠・従量課金を保護する。close 自体の失敗は握り潰す。
		await browser.close().catch(() => {});
	}
}
