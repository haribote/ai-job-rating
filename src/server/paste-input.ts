import { Hono } from "hono";
import type { Bindings } from "./app";
import type { AiRunner } from "./extract/ai";
import { renderExtractionFailedPage, renderResultPage } from "./result-display";
import { ingestJob } from "./storage/ingest";
import type { RawHtmlBucket } from "./storage/raw-html-store";

// 貼り付け HTML の上限（バイト）。後続のトリミング #9 / 抽出 #11 の負荷・コスト保護のための上限。
// Phase 0 の検証用途には十分な余裕（2MB）を取る。
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

// 検証結果。後続へは raw HTML をそのまま渡す（この層ではトリミング・正規化をしない）。
// bytes は上限判定で算出済みの UTF-8 バイト長を再利用のため同梱する。
export type ValidatedHtml =
	| { ok: true; html: string; bytes: number }
	| { ok: false; reason: "empty" | "too-large" };

// 貼り付け入力の決定的バリデーション。空入力とサイズ上限のみを判定し、内容は加工しない。
export function validatePastedHtml(input: string): ValidatedHtml {
	if (input.trim() === "") {
		return { ok: false, reason: "empty" };
	}
	// 文字数ではなく UTF-8 バイト長で上限判定する（マルチバイト求人ページを正しく扱う）
	const bytes = new TextEncoder().encode(input).length;
	if (bytes > MAX_HTML_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, html: input, bytes };
}

// 貼り付けフォールバックの入力受け口。責務は「入力を受け取り検証して後続へ渡せる形にする」までに限定し、
// トリミング #9 / 抽出 #11 / スコアリングは含めない。app.ts へは最小配線する。
export const pasteInput = new Hono<{ Bindings: Bindings }>();

// 取得 #8 が使えないケース向けの貼り付けフォーム。SSR で返しフォールスルー前に評価させる。
pasteInput.get("/paste", (c) =>
	c.html(
		`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/styles.css" />
    <title>HTML 貼り付け入力 — ai-job-rating</title>
  </head>
  <body>
    <main>
      <h1>HTML 貼り付け入力</h1>
      <p>取得できない求人ページの HTML を貼り付けて投入します（フォールバック兼検証手段）。</p>
      <form method="post" action="/result">
        <textarea name="html" rows="20" cols="80" required></textarea>
        <button type="submit">投入</button>
      </form>
    </main>
  </body>
</html>`,
	),
);

// 貼り付けられた HTML を受け取り検証する。正常系では受理した raw HTML のメタ情報を返し、
// 受け口が機能していることを示す（実際の後続連携 #9/#11 は別タスク）。
pasteInput.post("/paste", async (c) => {
	const form = await c.req.parseBody();
	const raw = form.html;
	const html = typeof raw === "string" ? raw : "";

	const result = validatePastedHtml(html);
	if (!result.ok) {
		// 空入力は 400、上限超過は 413 と意味的に分けて返す
		const status = result.reason === "too-large" ? 413 : 400;
		return c.json({ ok: false, reason: result.reason }, status);
	}

	// 後続（トリミング #9 / 抽出 #11）へは result.html をそのまま渡せる。
	// この層では加工せず、受理した事実とバイト長のみ返す。
	return c.json({ ok: true, bytes: result.bytes });
});

// 貼付経路の取込（#26）。検証済み HTML を取込→永続化（jobs/extractions/R2/scores）し、
// 保存済みスコアから結果ページ HTML を返す。AI / D1 / R2 を注入してユニットテスト可能にする。
// 抽出とスコアリングの分離は壊さない（抽出は 1 回・保存済みからスコア算出・§5.3）。
export interface IngestPasteDeps {
	ai: AiRunner;
	db: D1Database;
	bucket: RawHtmlBucket;
}

export async function ingestPaste(
	deps: IngestPasteDeps,
	html: string,
): Promise<string> {
	const ingested = await ingestJob(
		{ ai: deps.ai, db: deps.db, bucket: deps.bucket },
		{ html, sourceType: "paste" },
	);
	// 抽出失敗は「評価できる項目なし」と取り違えないよう専用導線へ畳む（§8・#26）。
	return ingested.extractionStatus === "failed"
		? renderExtractionFailedPage()
		: renderResultPage(ingested.score, ingested.job);
}

// 貼付 HTML を取込→永続化し、スコア結果ページを SSR で返す（フォールバック経路の DoD 結線）。
pasteInput.post("/result", async (c) => {
	const form = await c.req.parseBody();
	const raw = form.html;
	const html = typeof raw === "string" ? raw : "";

	const validated = validatePastedHtml(html);
	if (!validated.ok) {
		// /paste と同じ意味論で空入力 400 / 上限超過 413。AI を呼ぶ前に弾く（コスト保護）。
		const status = validated.reason === "too-large" ? 413 : 400;
		return c.json({ ok: false, reason: validated.reason }, status);
	}

	return c.html(
		await ingestPaste(
			{ ai: c.env.AI, db: c.env.DB, bucket: c.env.RAW_HTML },
			validated.html,
		),
	);
});
