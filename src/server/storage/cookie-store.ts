// 認証下の一覧→詳細を通す単一テナント Cookie ストア（KV・#190）。
//
// なぜこのモジュールが存在するか:
// - 認証下の一覧 URL を Cookie 付きで投入すると、そこから enqueue される詳細ジョブ（非同期キュー消費経路）
//   には Cookie が渡らない。Cookie をキューメッセージに載せると Queues に秘匿値が一時保持され
//   （observability/DLQ/retry で露出しうる）ガードレール（§8 最小保持）と衝突する（#189 で sync-only に留めた）。
// - そこで origin 単位で 1 件の Cookie を KV に置く。同期投入時に「submit した URL の origin」をキーに書き、
//   consumer は「job.url の origin」をキーに読む。一覧と同一 origin の詳細だけが Cookie を引けるため、
//   cross-origin 詳細は別キー → null → 中立取得となり、Cookie の cross-origin 再送を構造的に防ぐ（#75/#187/#189）。
// - 責務は KV 往復のみ: origin キー化・put/get/delete・TTL 解決に限定する（raw-html-store の流儀に倣う）。
//   Cookie 生値はストア以外（ログ・レスポンス・例外）に残さない（§8 最小保持）。

// KVNamespace の最小契約。テストで差し替えられるよう使う操作だけに依存する（env.AUTH_COOKIES が構造的に適合する）。
export interface CookieKv {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
	// KVNamespace.list の最小形。ページングのため list_complete/cursor を持つ（実 KV が構造的に適合する）。
	list(options?: { prefix?: string; cursor?: string }): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}>;
}

// Cookie ストアのキー接頭辞。origin 単位で 1 件を保持する（単一テナント前提）。
const COOKIE_KEY_PREFIX = "auth-cookie:";

// セッション Cookie 寿命の目安（既定 6 時間）。実運用のセッション寿命に合わせて env で上書きできる（§8）。
export const DEFAULT_AUTH_COOKIE_TTL_SECONDS = 6 * 60 * 60;

// KV expirationTtl の下限（Cloudflare KV は 60 秒未満を拒否する）。これ未満はクランプする。
export const MIN_AUTH_COOKIE_TTL_SECONDS = 60;

// URL から origin（scheme + host + port）を決定的に導く。解決不能は null（純関数）。
// path/query/hash は捨て、origin 単位でキー化する（同一 origin の一覧↔詳細を同じ Cookie で束ねる）。
export function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

// origin から KV キーを決定的に生成する。
function cookieStoreKey(origin: string): string {
	return `${COOKIE_KEY_PREFIX}${origin}`;
}

// env.AUTH_COOKIE_TTL_SECONDS の上書きを解決する（正の整数のみ採用・不正/未設定は既定・下限クランプ）。
// resolveReputationMaxAgeSeconds（web-search.ts）に倣う。
export function resolveAuthCookieTtlSeconds(
	envValue: string | undefined,
): number {
	if (envValue === undefined) return DEFAULT_AUTH_COOKIE_TTL_SECONDS;
	const n = Number(envValue);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		return DEFAULT_AUTH_COOKIE_TTL_SECONDS;
	}
	return Math.max(n, MIN_AUTH_COOKIE_TTL_SECONDS);
}

// 同期投入時に Cookie を origin 単位で保存する。origin 解決不能な URL は no-op（例外を投げない）。
// TTL 失効後は loadCookie が null を返し中立取得へ倒れる。Cookie 生値はここ以外へ出さない（最小保持）。
export async function saveCookie(
	kv: CookieKv,
	url: string,
	cookie: string,
	ttlSeconds: number,
): Promise<void> {
	const origin = originOf(url);
	if (origin === null) return;
	await kv.put(cookieStoreKey(origin), cookie, { expirationTtl: ttlSeconds });
}

// origin 単位の Cookie を読み出す。未保存・TTL 失効・origin 解決不能はすべて null（中立）。
export async function loadCookie(
	kv: CookieKv,
	url: string,
): Promise<string | null> {
	const origin = originOf(url);
	if (origin === null) return null;
	return kv.get(cookieStoreKey(origin));
}

// consumer 用: loadCookie の null を undefined へ正規化する。
// fetchWithStrategy は cookie === undefined で中立取得へ倒れるため、未保存/失効を undefined に寄せる。
export async function resolveJobCookie(
	kv: CookieKv,
	url: string,
): Promise<string | undefined> {
	return (await loadCookie(kv, url)) ?? undefined;
}

// origin 単位の Cookie を明示削除する。実際に消えた件数（0 or 1）を返し、cleanup の応答 count を正直にする。
// origin 解決不能な URL・未保存 origin は 0（no-op）。存在確認のため delete 前に get する（cleanup は稀な操作でコスト許容）。
export async function deleteCookie(kv: CookieKv, url: string): Promise<number> {
	const origin = originOf(url);
	if (origin === null) return 0;
	const key = cookieStoreKey(origin);
	const existed = (await kv.get(key)) !== null;
	if (!existed) return 0;
	await kv.delete(key);
	return 1;
}

// 保存済み Cookie を全消しする（単一テナントの cleanup 導線・#190）。削除件数を返す。
// KV list は 1 ページ最大 1000 件のため list_complete まで cursor を辿る（単一テナントでも「全消し」契約を守る）。
export async function deleteAllCookies(kv: CookieKv): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: COOKIE_KEY_PREFIX, cursor });
		await Promise.all(page.keys.map((k) => kv.delete(k.name)));
		deleted += page.keys.length;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor !== undefined);
	return deleted;
}
