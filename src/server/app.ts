import { Hono } from "hono";
import {
	type CriteriaConfigInput,
	inputsToConfigRows,
	readConfigItems,
	saveConfigAndRescore,
} from "./config";
import { runAiHealthCheck } from "./extract/ai";
import { extractJobFromHtml, resolveExtractionModel } from "./extract/extract";
import type { GoldenCase, GoldenExtractor } from "./extract/golden";
import { parseGoldenCase } from "./extract/golden";
import {
	EXTRACTION_MODEL_CANDIDATES,
	evaluateModels,
} from "./extract/model-eval";
import {
	type IngestUrlResult,
	ingestFromHtml,
	ingestFromUrl,
	readJobDetail,
	reextractJob,
	validateJobUrl,
	validatePastedHtml,
} from "./jobs";
import type { DetailJobMessage } from "./queue/detail-queue";
import { toRankingItem } from "./ranking-list";
import { readRanking } from "./scoring/ranking";

// Worker の env バインディング型。後続フェーズ（D1 / R2 / KV）でここに追記する
export interface Bindings {
	// 静的資産フォールスルー用バインディング（wrangler.jsonc の assets.binding と一致）
	ASSETS: Fetcher;
	// Workers AI バインディング（wrangler.jsonc の ai.binding と一致, §7.1）。型は wrangler types 生成の Ai
	AI: Ai;
	// 複数詳細ページ非同期処理キュー（#24, wrangler.jsonc の queues.producers と一致）。型は wrangler types 生成の Queue
	JOB_QUEUE: Queue<DetailJobMessage>;
	// Browser Rendering バインディング（wrangler.jsonc の browser.binding と一致）。SPA 取得フォールバックで使う。
	// @cloudflare/puppeteer.launch へ渡す認証付きエンドポイント（Fetcher 形）。実起動は同 package が担う。
	BROWSER: Fetcher;
	// D1 バインディング（wrangler.jsonc の d1_databases.binding と一致, §6）。構造化データの永続化に使う
	DB: D1Database;
	// R2 バインディング（wrangler.jsonc の r2_buckets.binding と一致, §6）。生 HTML 等の保存に使う（#17）
	RAW_HTML: R2Bucket;
	// 抽出モデル ID の上書き（wrangler.jsonc の vars.EXTRACTION_MODEL / .dev.vars, §7.1 / #106）。
	// 未設定なら extract.ts の resolveExtractionModel がコード既定へフォールバックする（フォーク容易性 §8）。
	EXTRACTION_MODEL?: string;
	// live golden eval ランナー（#106）の dev 限定フラグ。"1" のときだけ /api/_eval-models を有効化する。
	// 本番では未設定＝404 で、多数の AI 呼び出しを誘発するルートをコスト/濫用から守る（.dev.vars で付与）。
	EXTRACTION_EVAL?: string;
}

// アプリ本体を index.ts から切り出し、Hono の app.request() で単体テスト可能にする（責務分離）。
// SSR HTML を撤去し、すべて /api/* の JSON エンドポイントへ再編した（#95 Task 2）。
// HTML を返す経路は静的資産フォールスルー（c.env.ASSETS）のみで、API は JSON 契約に固定する。
const app = new Hono<{ Bindings: Bindings }>();

// 取得失敗の種別 → HTTP ステータス。上流取得の失敗は 502（Bad Gateway）へ集約する。
const FETCH_ERROR_STATUS = 502;

// 死活監視の契約。固定形式を返し、ユニットテストで担保する。
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Workers AI binding の疎通確認（§7.1）。最小推論を投げて到達性を返す。
app.get("/api/ai-health", async (c) => {
	const result = await runAiHealthCheck(c.env.AI);
	return c.json(result, result.ok ? 200 : 503);
});

// 求人投入。body は { url } または { html }（貼り付けフォールバック）。
// detail/paste は取込→永続化して 201 { jobId, status }、一覧 URL はキュー投入して 202 { status, count }。
// 検証失敗は 400、上流取得失敗は 502。AI を呼ぶ前に空入力・不正 URL・サイズ超過を弾く（コスト保護）。
app.post("/api/jobs", async (c) => {
	let body: { url?: unknown; html?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}

	const hasUrl = typeof body.url === "string";
	const hasHtml = typeof body.html === "string";
	// url と html は排他。両方・どちらも無いは入力エラー。
	if (hasUrl === hasHtml) {
		return c.json(
			{ error: "provide exactly one of url or html", reason: "body" },
			400,
		);
	}

	if (hasUrl) {
		const validated = validateJobUrl(body.url as string);
		if (!validated.ok) {
			return c.json({ error: "invalid url", reason: validated.reason }, 400);
		}
		const result: IngestUrlResult = await ingestFromUrl(
			{
				ai: c.env.AI,
				db: c.env.DB,
				bucket: c.env.RAW_HTML,
				queue: c.env.JOB_QUEUE,
				model: c.env.EXTRACTION_MODEL,
			},
			validated.url,
		);
		if (result.kind === "fetch-error") {
			return c.json(
				{ error: "failed to fetch url", reason: result.reason },
				FETCH_ERROR_STATUS,
			);
		}
		if (result.kind === "list") {
			return c.json({ status: "queued", count: result.count }, 202);
		}
		return c.json({ jobId: result.jobId, status: result.status }, 201);
	}

	const validated = validatePastedHtml(body.html as string);
	if (!validated.ok) {
		// 空入力は 400、上限超過は 413 と意味的に分けて返す。
		const status = validated.reason === "too-large" ? 413 : 400;
		return c.json({ error: "invalid html", reason: validated.reason }, status);
	}
	const ingested = await ingestFromHtml(
		{
			ai: c.env.AI,
			db: c.env.DB,
			bucket: c.env.RAW_HTML,
			model: c.env.EXTRACTION_MODEL,
		},
		validated.html,
	);
	return c.json({ jobId: ingested.jobId, status: ingested.status }, 201);
});

// 求人詳細。jobs メタ・最新抽出・スコア内訳（フラット）を返す。未存在は 404。
// AI も再スコアリングも実行しない（保存済み scores/extractions を読むだけ・§5.3）。
app.get("/api/jobs/:id", async (c) => {
	const detail = await readJobDetail(c.env.DB, c.req.param("id"));
	if (detail === null) return c.json({ error: "job not found" }, 404);
	return c.json(detail, 200);
});

// 再抽出。保存済みの生 HTML(R2) から AI 抽出を意図的に再実行し、同一 job へ取込し直す。
// 設定変更の再スコア（PUT /api/config・AI 非再実行）とは別軸の明示操作。未存在/生 HTML 不在は 404。
app.post("/api/jobs/:id/reextract", async (c) => {
	const result = await reextractJob(
		{
			ai: c.env.AI,
			db: c.env.DB,
			bucket: c.env.RAW_HTML,
			model: c.env.EXTRACTION_MODEL,
		},
		c.req.param("id"),
	);
	if (result === null)
		return c.json({ error: "job or raw html not found" }, 404);
	return c.json({ status: result.status }, 202);
});

// ランキング一覧。永続 scores をスコア順に読み、軽量な一覧行＋除外行を返す（決定的・AI 非依存・§5.3）。
app.get("/api/ranking", async (c) => {
	const { ranked, excluded } = await readRanking(c.env.DB);
	return c.json({
		jobs: ranked.map(toRankingItem),
		excluded: excluded.map(toRankingItem),
	});
});

// 設定取得。全正規キーぶんの現行設定（重み・希望値・ハードフィルタ・kind）を返す。
app.get("/api/config", async (c) => {
	const items = await readConfigItems(c.env.DB);
	return c.json({ items });
});

// 設定更新。body は { items: CriteriaConfigInput[] }。保存後に全 job を即再スコア（AI 非再実行・§5.3）。
// 不正入力は保存・再スコアの前に 400 で弾く（コスト保護・決定性）。
app.put("/api/config", async (c) => {
	let body: { items?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}
	if (!Array.isArray(body.items)) {
		return c.json({ error: "items must be an array", reason: "body" }, 400);
	}

	const parsed = inputsToConfigRows(body.items as CriteriaConfigInput[]);
	if (!parsed.ok) {
		return c.json({ error: "invalid config", reason: parsed.reason }, 400);
	}

	const count = await saveConfigAndRescore(c.env.DB, parsed.rows);
	return c.json({ status: "rescored", count }, 200);
});

// 抽出モデルの live golden 横並び評価（#106・dev 限定）。本番安全のため EXTRACTION_EVAL==="1" のときだけ
// 動作し、未設定/それ以外は 404（プロダクションでは存在しないのと同義）。多数の AI 呼び出しを誘発するため
// gate を最優先で評価し、コスト/濫用から守る。
// body は { cases: unknown[] }（golden ケースの生 JSON 配列・実体は PII で gitignore のため driver が送る）。
// 各ケースは parseGoldenCase で型安全に検証し、本番パイプライン（content prep＋分割＋機構自動解決）に忠実な
// extractor を候補ごとに生成して evaluateModels を呼び、ModelSelection を JSON で返す。
app.post("/api/_eval-models", async (c) => {
	if (c.env.EXTRACTION_EVAL !== "1") {
		return c.json({ error: "not found" }, 404);
	}

	let body: { cases?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}
	if (!Array.isArray(body.cases)) {
		return c.json({ error: "cases must be an array", reason: "body" }, 400);
	}

	// 不正な golden は AI を呼ぶ前に弾く（コスト保護）。
	let cases: GoldenCase[];
	try {
		cases = body.cases.map((raw) => parseGoldenCase(raw));
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return c.json({ error: "invalid golden case", reason }, 400);
	}

	const baselineModel = resolveExtractionModel(c.env.EXTRACTION_MODEL);
	const candidateModels = EXTRACTION_MODEL_CANDIDATES.map((m) => m.id);
	// 本番取込（ingest）と同じ extractJobFromHtml 経路に通す。機構はモデル ID から自動解決される（#107）。
	const makeExtractor =
		(model: string): GoldenExtractor =>
		(html) =>
			extractJobFromHtml(c.env.AI, html, { model }).then((r) => r.job);

	const selection = await evaluateModels(
		cases,
		baselineModel,
		candidateModels,
		makeExtractor,
	);
	return c.json(selection, 200);
});

// API ルートに該当しない GET は静的資産（SPA）へフォールスルーする。
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
