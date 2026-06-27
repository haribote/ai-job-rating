// SPA から /api/* JSON 契約（#95）を叩くための薄いクライアントラッパ。
//
// なぜ存在するか:
// - URL 構築（/api 前置・先頭スラッシュ吸収）とエラー整形（{error,reason} → 例外）を一箇所に集約し、
//   各 UI（Wave 3 #108–#114）が fetch の細部や契約のエラー形を再実装しないようにする。
// - 決定的ロジックなのでユニットテストで担保する（fetch は注入可能にしてネットワーク非依存に保つ）。
// - 設計ガードレール（抽出↔スコア分離・unknown 中立・ラベル正規化）は API 側の責務。
//   本ラッパは契約を消費するだけで再実装しない。

// 注入可能な fetch。テストでは記録付きフェイクを渡し、本番は global fetch を使う。
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API_PREFIX = "/api";

// パスを /api 配下の絶対 URL へ寄せる。先頭スラッシュの有無を吸収して呼び出し側の表記揺れを許容する。
export function buildApiUrl(path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${API_PREFIX}${normalized}`;
}

// 契約のエラー応答 {error, reason?} を表す例外。status と契約コードを保持して UI が分岐できるようにする。
export class ApiRequestError extends Error {
	readonly status: number;
	readonly code: string;
	readonly reason?: string;

	constructor(status: number, code: string, reason?: string) {
		super(reason ? `${code}: ${reason}` : code);
		this.name = "ApiRequestError";
		this.status = status;
		this.code = code;
		this.reason = reason;
	}
}

// 非 2xx 応答を ApiRequestError へ整形する。
// JSON でない／契約外のボディは汎用コード http_<status> にフォールバックして握り潰さない。
async function toApiError(res: Response): Promise<ApiRequestError> {
	let code = `http_${res.status}`;
	let reason: string | undefined;
	try {
		const data = (await res.json()) as { error?: unknown; reason?: unknown };
		if (typeof data.error === "string") {
			code = data.error;
		}
		if (typeof data.reason === "string") {
			reason = data.reason;
		}
	} catch {
		// JSON でないエラーボディは汎用コードのまま扱う
	}
	return new ApiRequestError(res.status, code, reason);
}

async function request<T>(
	fetchImpl: FetchLike,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const init: RequestInit = { method };
	// body のある書き込み系のみ JSON ヘッダを付ける。body 無し POST（再抽出等）はヘッダを付けない。
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}

	const res = await fetchImpl(buildApiUrl(path), init);
	if (!res.ok) {
		throw await toApiError(res);
	}
	return (await res.json()) as T;
}

export interface ApiClient {
	get<T>(path: string): Promise<T>;
	post<T>(path: string, body?: unknown): Promise<T>;
	put<T>(path: string, body?: unknown): Promise<T>;
}

// fetch を注入してクライアントを生成する。テストはフェイク、本番は global fetch を渡す。
export function createApiClient(
	fetchImpl: FetchLike = (url, init) => fetch(url, init),
): ApiClient {
	return {
		get: <T>(path: string) => request<T>(fetchImpl, "GET", path),
		post: <T>(path: string, body?: unknown) =>
			request<T>(fetchImpl, "POST", path, body),
		put: <T>(path: string, body?: unknown) =>
			request<T>(fetchImpl, "PUT", path, body),
	};
}

// 既定クライアント（global fetch）。UI からはこれを使う。
const defaultClient = createApiClient();
export const apiGet = defaultClient.get;
export const apiPost = defaultClient.post;
export const apiPut = defaultClient.put;
