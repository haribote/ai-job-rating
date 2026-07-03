// 取得した HTML が「一覧ページ」か「詳細ページ」かを判定し、一覧なら詳細 URL 群を抽出する取得層。
// 責務は「判定と URL 抽出」のみ: 取得（#21 fetch-html）・抽出（#11）・スコアリングは持ち込まない。
// 判定・URL 抽出・正規化はすべて決定的（同一入力→同一出力）にしてユニットテストで担保する（§8）。
// AI は必要時のフォールバックとして注入できるが、決定的経路の外に置く（ヒューリスティック優先）。

// ページ判定結果。後続 #24（Queues）/#25（レート制御）はこの形を入力に取る。
// - list: 抽出済み詳細 URL の配列（正規化・重複排除・出現順保持の絶対 URL）。
// - detail: 単一詳細ページなのでそのまま 1 件として抽出層へ渡す。
export type PageClassification =
	| { kind: "list"; detailUrls: string[] }
	| { kind: "detail" };

// 一覧と判定する同一オリジン詳細リンクの最小数。
// 1 件では詳細ページ内の関連リンク等と区別できないため複数を要求する。
const LIST_THRESHOLD = 2;

// リンク抽出前に中身ごと落とす要素・コメント。
// script/style/template の内側に書かれた a href リテラルや、コメントアウト済みリンクを
// 実リンクと誤認しないため（regex スキャンの取りこぼし・水増しを防ぐ。trim-html と同方針）。
const STRIP_WITH_CONTENT =
	/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

// a 要素の href 属性値を拾う。引用符あり（" '）/なしの実データに耐える。
// 属性名直前に空白を要求し、data-href 等の接尾辞属性（\b では誤マッチ）を除外する。
// 値の正当性（スキーム・オリジン）は normalizeUrl 側の URL パースで担保する。
const HREF_PATTERN =
	/<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;

// href を base URL で絶対化し、フラグメント除去・末尾スラッシュ揃えで正規キーへ寄せる。
// 解釈不能・非 http(s) は null（後続から除外する）。クエリは求人 ID を担うため温存する。
export function normalizeUrl(href: string, baseUrl: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "") {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed, baseUrl);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	// フラグメントは同一リソースを指すので捨てる
	parsed.hash = "";
	// 末尾スラッシュは表記揺れなのでルート以外で揃える（重複排除のため）。
	// ただしクエリ付き URL は /jobs/?id=1 と /jobs?id=1 を別リソースとするサイトがあり、
	// クエリが求人 ID を担う前提と衝突するため畳まない（情報欠落を避ける）。
	if (
		parsed.search === "" &&
		parsed.pathname.length > 1 &&
		parsed.pathname.endsWith("/")
	) {
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	}
	return parsed.toString();
}

// 同一オリジンの詳細候補 URL を出現順・重複なしで抽出する。
// クロスオリジン・非 http(s)・ページ自身への自己リンクは詳細候補から除外する。
export function extractDetailUrls(html: string, baseUrl: string): string[] {
	const self = normalizeUrl(baseUrl, baseUrl);
	let baseOrigin: string;
	try {
		baseOrigin = new URL(baseUrl).origin;
	} catch {
		return [];
	}

	// script/style/コメントの内側に書かれた a href リテラルを実リンクと誤認しないよう先に除去する
	const scannable = html
		.replace(STRIP_WITH_CONTENT, " ")
		.replace(HTML_COMMENT, " ");

	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of scannable.matchAll(HREF_PATTERN)) {
		const raw = match[2] ?? match[3] ?? match[4] ?? "";
		const normalized = normalizeUrl(raw, baseUrl);
		if (normalized === null) {
			continue;
		}
		// 別オリジンは取得対象外（自社ドメイン外の求人は扱わない）
		if (new URL(normalized).origin !== baseOrigin) {
			continue;
		}
		// ページ自身への戻りリンクは詳細ではない
		if (normalized === self) {
			continue;
		}
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		urls.push(normalized);
	}
	return urls;
}

// 詳細リンクの「親パス」を返す（末尾セグメントを除いた部分）。認証必須マイページ等の常設
// ナビゲーションは相互に無関係な単一セグメントの別ページ（親パスがルート "/"）を並べるだけで、
// 一覧ページのように同じ親パスを共有する詳細リンク群（例: /recruits/1, /recruits/2）にはならない。
// 親がルートのリンクは一覧構造の兄弟とみなせないためグループ化対象外（null）にする。
function siblingGroupKey(url: string): string | null {
	const { pathname } = new URL(url);
	const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	const lastSlash = trimmed.lastIndexOf("/");
	if (lastSlash <= 0) {
		return null;
	}
	return trimmed.slice(0, lastSlash + 1);
}

// 一覧/詳細をヒューリスティックで判定する。
// 同一オリジン詳細リンクのうち、親パスを共有する（＝一覧の兄弟リンクらしい）ものが
// 閾値以上のグループがあれば一覧（そのグループの URL 群を返す）。無関係なナビゲーション
// リンクが複数あるだけでは一覧と判定しない（#193 live 検証で発覚した誤判定の是正）。
export function classifyPage(
	html: string,
	baseUrl: string,
): PageClassification {
	const detailUrls = extractDetailUrls(html, baseUrl);
	const groupSizes = new Map<string, number>();
	const groupKeyOf = new Map<string, string>();
	for (const url of detailUrls) {
		const key = siblingGroupKey(url);
		if (key === null) {
			continue;
		}
		groupKeyOf.set(url, key);
		groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
	}
	const listUrls = detailUrls.filter((url) => {
		const key = groupKeyOf.get(url);
		return key !== undefined && (groupSizes.get(key) ?? 0) >= LIST_THRESHOLD;
	});
	if (listUrls.length > 0) {
		return { kind: "list", detailUrls: listUrls };
	}
	return { kind: "detail" };
}
