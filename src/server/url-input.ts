import { Hono } from "hono";
import type { Bindings } from "./app";
import type { AiRunner } from "./extract/ai";
import { type Fetcher, FetchHtmlError, fetchHtml } from "./fetch/fetch-html";
import { classifyPage } from "./fetch/list-detail";
import { type DetailQueue, enqueueDetailJobs } from "./queue/detail-queue";
import {
	escapeHtml,
	renderExtractionFailedPage,
	renderResultPage,
} from "./result-display";
import { ingestJob } from "./storage/ingest";
import type { RawHtmlBucket } from "./storage/raw-html-store";

// 公開詳細 URL 入力の決定的バリデーション。空入力と http(s) 以外のスキームを弾く。
// roadmap Phase 0 は公開 SSR の単一詳細 URL のみ対象。誤投入・SSRF（file:/javascript: 等）を入口で排除する。
export type ValidatedUrl =
	| { ok: true; url: string }
	| { ok: false; reason: "empty" | "invalid" };

export function validateJobUrl(input: string): ValidatedUrl {
	const trimmed = input.trim();
	if (trimmed === "") {
		return { ok: false, reason: "empty" };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		// URL として解釈できない入力（相対パス等）は受け付けない
		return { ok: false, reason: "invalid" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "invalid" };
	}
	return { ok: true, url: trimmed };
}

// 取得失敗時に呼び出し側へ返す HTTP ステータス。上流取得の失敗なので 502（Bad Gateway）に集約する。
const FETCH_ERROR_STATUS = 502;

// 取得失敗の種別を人間可読な日本語に落とす（エラーページ表示用）。
// kind は全 case を明示し、種別追加時に網羅漏れをコンパイルエラーで検知する（never チェック）。
function describeFetchError(error: FetchHtmlError): string {
	switch (error.kind) {
		case "http":
			return `取得先が HTTP ${error.status ?? ""} を返しました。`;
		case "timeout":
			return "取得がタイムアウトしました。";
		case "network":
			return "取得中にネットワークエラーが発生しました。";
		default: {
			const exhaustive: never = error.kind;
			return exhaustive;
		}
	}
}

// 取得失敗ページ。原因を示し、貼付フォールバック（/paste）へ誘導する（§8 エラーハンドリング）。
// URL はユーザ由来文字列のため escapeHtml で必ずエスケープする。
export function renderFetchErrorPage(
	url: string,
	error: FetchHtmlError,
): string {
	return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>取得に失敗しました — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>取得に失敗しました</h1>
      <p>${escapeHtml(describeFetchError(error))}</p>
      <p>URL: <code>${escapeHtml(url)}</code></p>
      <p>ページの HTML を <a href="/paste">貼り付け入力</a> で投入すると抽出を試せます。</p>
    </main>
  </body>
</html>`;
}

// 一覧 URL の detailUrls をキュー投入したことを示すページ（#24 producer）。
// 結果は非同期処理後に /ranking へ反映されるため、件数と導線を案内する。
export function renderQueuedPage(count: number): string {
	return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>キュー投入しました — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>キュー投入しました</h1>
      <p>一覧から ${count} 件の詳細ページを取得キューに投入しました。順次取得・抽出・スコアリングされ、<a href="/ranking">ランキング</a> に反映されます。</p>
    </main>
  </body>
</html>`;
}

// 取得 → 一覧なら detailUrls をキュー投入 / 詳細なら取込（永続化）→ 結果表示。取得失敗時は誘導ページ。
// fetcher / AI / D1 / R2 / Queue を注入してユニットテスト可能にする。
export interface FetchAndRenderDeps {
	ai: AiRunner;
	// 取込結果の永続化先（#26）。
	db: D1Database;
	bucket: RawHtmlBucket;
	// 一覧 URL の detailUrls を非同期処理へ投入する producer（#24）。
	queue: DetailQueue;
	// テスト用に fetch を差し替える。未指定時は fetchHtml が globalThis.fetch を使う
	fetcher?: Fetcher;
	// 取得タイムアウト（ms）。未指定時は fetchHtml の既定値
	timeoutMs?: number;
}

export async function fetchAndRender(
	deps: FetchAndRenderDeps,
	url: string,
): Promise<{ status: 200 | typeof FETCH_ERROR_STATUS; html: string }> {
	try {
		const result = await fetchHtml(url, {
			fetcher: deps.fetcher,
			timeoutMs: deps.timeoutMs,
		});
		// 一覧/詳細を判定（#21）。一覧は複数詳細 URL を非同期処理へ委ね（#24 producer）、
		// 詳細はその場で取込→永続化して結果を返す（既存の単一詳細 UX を維持）。
		const classification = classifyPage(result.html, url);
		if (classification.kind === "list") {
			const count = await enqueueDetailJobs(deps.queue, classification, url);
			return { status: 200, html: renderQueuedPage(count) };
		}
		// 取得した HTML を取込→永続化（jobs/extractions/R2/scores）し、保存済みスコアから表示する。
		const ingested = await ingestJob(
			{ ai: deps.ai, db: deps.db, bucket: deps.bucket },
			{ html: result.html, sourceType: "detail", sourceUrl: url },
		);
		// 抽出失敗は「評価できる項目なし」と取り違えないよう専用導線へ畳む（§8・#26）。
		const html =
			ingested.extractionStatus === "failed"
				? renderExtractionFailedPage()
				: renderResultPage(ingested.score, ingested.job);
		return { status: 200, html };
	} catch (cause) {
		// 取得失敗は誘導ページへ畳む。想定外の例外（抽出層など）は握り潰さず再 throw する。
		if (cause instanceof FetchHtmlError) {
			return {
				status: FETCH_ERROR_STATUS,
				html: renderFetchErrorPage(url, cause),
			};
		}
		throw cause;
	}
}

// URL 投入の入力受け口。app.ts へは最小配線する（静的フォールスルーより前に評価）。
export const urlInput = new Hono<{ Bindings: Bindings }>();

// 公開詳細 URL の入力フォーム。SSR で返し、取得不可時の貼付フォールバックへも導線を置く。
urlInput.get("/fetch", (c) =>
	c.html(
		`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>URL 入力 — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>求人 URL 入力</h1>
      <p>公開求人ページの詳細 URL を投入すると、取得→抽出→スコア→内訳表示まで通します。</p>
      <form method="post" action="/fetch">
        <input type="url" name="url" size="80" placeholder="https://..." required />
        <button type="submit">投入</button>
      </form>
      <p>取得できないページは <a href="/paste">HTML 貼り付け入力</a> をご利用ください。</p>
    </main>
  </body>
</html>`,
	),
);

// URL を取得して最小経路に通す。AI を呼ぶ前に空入力・不正 URL を弾く（コスト保護・SSRF 排除）。
urlInput.post("/fetch", async (c) => {
	const form = await c.req.parseBody();
	const raw = form.url;
	const input = typeof raw === "string" ? raw : "";

	const validated = validateJobUrl(input);
	if (!validated.ok) {
		return c.json({ ok: false, reason: validated.reason }, 400);
	}

	const { status, html } = await fetchAndRender(
		{
			ai: c.env.AI,
			db: c.env.DB,
			bucket: c.env.RAW_HTML,
			queue: c.env.JOB_QUEUE,
		},
		validated.url,
	);
	return c.html(html, status);
});
