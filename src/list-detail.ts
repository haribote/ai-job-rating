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

// href の属性値を緩く拾う。引用符あり（" '）/なしの実データに耐える。
// 値の正当性（スキーム・オリジン）は normalizeUrl 側の URL パースで担保する。
const HREF_PATTERN =
	/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;

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
	// 末尾スラッシュは表記揺れなのでルート以外で揃える（重複排除のため）
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
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

	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of html.matchAll(HREF_PATTERN)) {
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

// 一覧/詳細をヒューリスティックで判定する。
// 同一オリジン詳細リンクが閾値以上なら一覧（その URL 群を返す）、未満なら詳細とみなす。
export function classifyPage(
	html: string,
	baseUrl: string,
): PageClassification {
	const detailUrls = extractDetailUrls(html, baseUrl);
	if (detailUrls.length >= LIST_THRESHOLD) {
		return { kind: "list", detailUrls };
	}
	return { kind: "detail" };
}
