// 公開（認証不要）の単一詳細 URL を取得する取得層。
// 責務は「取得」のみ: HTTP ステータス分岐・エラー整形・HTML(text) 返却に限定し、
// 本文トリミング（#9）や構造化抽出（#11）はこの層に持ち込まない。
// fetch は DI（引数注入）して実ネットワークなしでユニットテスト可能にする。

// 取得結果。成功時は本文 HTML と最終ステータスを返す
export interface FetchHtmlResult {
	url: string;
	status: number;
	html: string;
}

// 取得失敗の分類。呼び出し側（#9 以降）が分岐できるよう種別を型で表現する
export type FetchHtmlErrorKind = "http" | "network" | "timeout";

// 取得失敗を表す例外。種別と（HTTP の場合は）ステータスを保持する
export class FetchHtmlError extends Error {
	readonly kind: FetchHtmlErrorKind;
	readonly url: string;
	readonly status?: number;
	// 3xx 応答の Location ヘッダ値（redirect:"manual" 時のみ意味を持つ）。
	// 認証下取得（#23）が追従先 origin を検査して Cookie のクロスオリジン再送を防ぐために使う。
	readonly location?: string;

	constructor(args: {
		kind: FetchHtmlErrorKind;
		url: string;
		status?: number;
		location?: string;
		message: string;
		cause?: unknown;
	}) {
		super(args.message, { cause: args.cause });
		this.name = "FetchHtmlError";
		this.kind = args.kind;
		this.url = args.url;
		this.status = args.status;
		this.location = args.location;
	}
}

// fetch シグネチャの最小型。テストでモックを注入できるよう標準 fetch に合わせる
export type Fetcher = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface FetchHtmlOptions {
	// 取得タイムアウト（ms）。未指定時は既定値を使う
	timeoutMs?: number;
	// テスト用に fetch を差し替える。未指定時は globalThis.fetch を使う
	fetcher?: Fetcher;
	// 追加で載せるリクエストヘッダ（認証下取得の Cookie 等）。既定ヘッダにマージする
	headers?: Record<string, string>;
	// redirect 方式。既定は "follow"（公開取得の従来挙動）。認証下取得は "manual" を渡し、
	// 呼び出し側が origin を検査して Cookie のクロスオリジン再送を防ぐ（#23）。
	// DOM lib の RequestRedirect に依存せずリテラルで持つ（Workers 型環境で未定義のため）。
	redirect?: "follow" | "manual" | "error";
}

// 既定タイムアウト。SSR 取得が長時間ぶら下がるのを防ぐ
const DEFAULT_TIMEOUT_MS = 10_000;

// 取得時に名乗る User-Agent。セルフホスト OSS であることを示し取得元が識別できるようにする（§8 取得マナー）。
const USER_AGENT =
	"ai-job-rating/0.1 (+https://github.com/haribote/ai-job-rating)";

// 単一詳細 URL を取得し HTML(text) を返す。
// 非 2xx・ネットワーク失敗・タイムアウトは FetchHtmlError に整形して throw する。
export async function fetchHtml(
	url: string,
	options: FetchHtmlOptions = {},
): Promise<FetchHtmlResult> {
	const fetcher = options.fetcher ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const controller = new AbortController();
	// 接続だけでなく本文読み出しまでをタイムアウトで打ち切る（遅い body 対策）
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetcher(url, {
			signal: controller.signal,
			redirect: options.redirect ?? "follow",
			// 取得マナー（§8）: 識別可能な User-Agent を名乗る。robots/レート制御の本格対応は Phase 1。
			// 呼び出し側の追加ヘッダ（認証下取得の Cookie 等）を後勝ちでマージする。
			headers: {
				accept: "text/html",
				"user-agent": USER_AGENT,
				...options.headers,
			},
		});

		// 非 2xx は取得失敗として扱う（本文の中身判定は後続層の責務）。
		// redirect:"manual" 時は 3xx も非 2xx として届くため、追従先判断用に Location を載せる。
		if (!response.ok) {
			throw new FetchHtmlError({
				kind: "http",
				url,
				status: response.status,
				location: response.headers.get("location") ?? undefined,
				message: `unexpected HTTP status ${response.status}: ${url}`,
			});
		}

		const html = await response.text();
		return { url, status: response.status, html };
	} catch (cause) {
		// http エラーは整形済みなので素通しする
		if (cause instanceof FetchHtmlError) {
			throw cause;
		}
		// abort 由来かネットワーク由来かで種別を分け、呼び出し側が再試行判断できるようにする
		if (controller.signal.aborted) {
			throw new FetchHtmlError({
				kind: "timeout",
				url,
				message: `fetch timed out after ${timeoutMs}ms: ${url}`,
				cause,
			});
		}
		throw new FetchHtmlError({
			kind: "network",
			url,
			message: `network error while fetching: ${url}`,
			cause,
		});
	} finally {
		clearTimeout(timer);
	}
}
