import { Hono } from "hono";
import { createAuthMiddleware } from "./auth";
import { resolveCorporateNumberClient } from "./companies/corporate-number-client";
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
	type AuthErrorReason,
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
import { resolveReputationApiKeyConfig } from "./reputation/api-key";
import {
	parseManualReputationInput,
	saveManualReputation,
} from "./reputation/manual";
import {
	ingestUrlHtmlReputation,
	parseUrlHtmlReputationInput,
} from "./reputation/url-html";
import {
	createClaudeReputationClient,
	DEFAULT_WEB_SEARCH_SOURCE,
	fetchReputationSnapshot,
	resolveReputationMaxAgeSeconds,
	resolveReputationModel,
} from "./reputation/web-search";
import { parseReputationSourceInput } from "./reputation-config";
import { readRanking } from "./scoring/ranking";
import { getCompanyById } from "./storage/companies-store";
import {
	deleteAllCookies,
	deleteCookie,
	resolveAuthCookieTtlSeconds,
} from "./storage/cookie-store";
import {
	deleteReputationSource,
	listReputationSources,
	ReputationStoreError,
	upsertReputationSource,
} from "./storage/reputation-store";

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
	// KV バインディング（wrangler.jsonc の kv_namespaces.binding と一致, §6）。認証下の一覧→詳細を通す
	// 単一テナント Cookie ストア（origin 単位・TTL 失効・#190）。同期投入時に書き込み、キュー consumer が読む。
	AUTH_COOKIES: KVNamespace;
	// 認証下 Cookie ストアの TTL 上書き（秒・#190）。未設定/不正はコード既定へフォールバックする（§8）。
	AUTH_COOKIE_TTL_SECONDS?: string;
	// 抽出モデル ID の上書き（wrangler.jsonc の vars.EXTRACTION_MODEL / .dev.vars, §7.1 / #106）。
	// 未設定なら extract.ts の resolveExtractionModel がコード既定へフォールバックする（フォーク容易性 §8）。
	EXTRACTION_MODEL?: string;
	// live golden eval ランナー（#106）の dev 限定フラグ。"1" のときだけ /api/_eval-models を有効化する。
	// 本番では未設定＝404 で、多数の AI 呼び出しを誘発するルートをコスト/濫用から守る（.dev.vars で付与）。
	EXTRACTION_EVAL?: string;
	// 企業評判検索（#30 の Claude API web_search）の前提となる秘匿キー（§7.2・Phase 2）。
	// 実値は wrangler secret / .dev.vars で注入し、コードに直書きしない（フォーク容易性 §8）。
	// 本 issue（#31）はこのキーの presence を設定 UI へ明示するだけで、API 呼び出しは #30 の責務。
	ANTHROPIC_API_KEY?: string;
	// 評判 web_search（#30）の使用モデル上書き（wrangler.jsonc vars / .dev.vars）。
	// 未設定なら web-search.ts の resolveReputationModel がコード既定（claude-opus-4-8）へフォールバックする。
	REPUTATION_MODEL?: string;
	// 評判キャッシュの鮮度上限（秒・#30）。未設定/不正は既定（30日）へフォールバックする（フォーク容易性 §8）。
	REPUTATION_MAX_AGE_SECONDS?: string;
	// 国税庁 法人番号 Web-API のアプリケーションID（秘匿・#32）。.dev.vars / wrangler secret で注入する。
	// 未設定なら法人番号での一意化はスキップし企業名のみで名寄せする（中立・resolveCorporateNumberClient）。
	HOUJIN_BANGOU_APP_ID?: string;
	// 法人番号 Web-API のエンドポイント base（非秘匿・wrangler.jsonc vars）。未設定はコード既定へフォールバック。
	HOUJIN_BANGOU_API_BASE?: string;
	// サイトアクセス制限（Basic 認証・#183）の秘匿 credential。実値は wrangler secret / .dev.vars で注入する。
	// 両方揃うときのみ認証を有効化し、欠けたら fail-open（dev/e2e は素通り）＋警告する（createAuthMiddleware）。
	AUTH_USER?: string;
	AUTH_PASS?: string;
}

// アプリ本体を index.ts から切り出し、Hono の app.request() で単体テスト可能にする（責務分離）。
// SSR HTML を撤去し、すべて /api/* の JSON エンドポイントへ再編した（#95 Task 2）。
// HTML を返す経路は静的資産フォールスルー（c.env.ASSETS）のみで、API は JSON 契約に固定する。
const app = new Hono<{ Bindings: Bindings }>();

// サイトアクセス制限（#183）。全ルート登録より前に置き、SPA(HTML)・/api/* を一括で Basic 認証保護する。
// AUTH_USER/AUTH_PASS 未設定なら素通り（fail-open）なので dev/e2e は従来どおり通る。
app.use("*", createAuthMiddleware());

// 取得失敗の種別 → HTTP ステータス。上流取得の失敗は 502（Bad Gateway）へ集約する。
const FETCH_ERROR_STATUS = 502;

// 認証下取得（Cookie 投入）の失敗種別 → HTTP ステータス（#187）。Cookie 構文不正はユーザー入力起因の
// 400、認証失敗・リダイレクト拒否は上流取得の失敗として 502 へ集約する（既存 fetch-error に倣う）。
export function authErrorStatus(reason: AuthErrorReason): 400 | 502 {
	return reason === "invalid-credential" ? 400 : FETCH_ERROR_STATUS;
}

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
	let body: { url?: unknown; html?: unknown; cookie?: unknown };
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
		// cookie は URL 投入時のみ有効・任意（認証下ページ取得用・#187）。取得ヘッダにのみ使い、
		// レスポンス・ログ・永続化のいずれにも残さない（fetchAuthedHtml の最小保持設計・§8）。
		const cookie = typeof body.cookie === "string" ? body.cookie : undefined;
		const result: IngestUrlResult = await ingestFromUrl(
			{
				ai: c.env.AI,
				db: c.env.DB,
				bucket: c.env.RAW_HTML,
				queue: c.env.JOB_QUEUE,
				model: c.env.EXTRACTION_MODEL,
				// 認証下 SPA を BR で認証下レンダリングするため binding を渡す（#189）。
				browser: c.env.BROWSER,
				// 認証下の一覧なら Cookie を origin 単位でストアへ保存し、enqueue された詳細ジョブの
				// consumer 経路が同一 origin で読み出せるようにする（#190）。
				cookieStore: c.env.AUTH_COOKIES,
				cookieTtlSeconds: resolveAuthCookieTtlSeconds(
					c.env.AUTH_COOKIE_TTL_SECONDS,
				),
			},
			validated.url,
			{ cookie },
		);
		if (result.kind === "fetch-error") {
			return c.json(
				{ error: "failed to fetch url", reason: result.reason },
				FETCH_ERROR_STATUS,
			);
		}
		if (result.kind === "auth-error") {
			return c.json(
				{ error: "failed to fetch authed url", reason: result.reason },
				authErrorStatus(result.reason),
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
	// 企業評判の company 軸合流（#117）は ANTHROPIC_API_KEY の presence で中立除外を切り替える（§5.2）。
	const { apiKeyConfigured } = resolveReputationApiKeyConfig(
		c.env.ANTHROPIC_API_KEY,
	);
	const detail = await readJobDetail(
		c.env.DB,
		c.req.param("id"),
		apiKeyConfigured,
	);
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

// 評判: 取得元設定 CRUD (#34)
// 対象口コミサイトと優先順位を設定画面で永続化する（§7.2）。設定変更は決定的・AI 非再実行（§5.3）。
// 取得層（#30）は enabledOnly で有効な取得元のみを priority 昇順で参照する。

// 取得元一覧。priority 昇順（同値は name 昇順）で全件返す（設定画面が編集対象を読む）。
app.get("/api/reputation/sources", async (c) => {
	const sources = await listReputationSources(c.env.DB);
	return c.json({ sources });
});

// 取得元の upsert（name で一意）。決定的バリデーション後に store を呼ぶ。不正は保存前に 400 で弾く。
app.put("/api/reputation/sources", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}
	// 単一の取得元オブジェクトのみ受理する（配列・非オブジェクトは body エラー）。
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return c.json({ error: "body must be an object", reason: "body" }, 400);
	}

	const parsed = parseReputationSourceInput(body);
	if (!parsed.ok) {
		return c.json({ error: "invalid source", reason: parsed.reason }, 400);
	}

	const source = await upsertReputationSource(c.env.DB, parsed.value);
	return c.json({ source }, 200);
});

// 取得元の削除。対象が無ければ 404（store の not_found を変換し、0 行削除を黙認しない）。
app.delete("/api/reputation/sources/:id", async (c) => {
	try {
		await deleteReputationSource(c.env.DB, c.req.param("id"));
	} catch (cause) {
		if (cause instanceof ReputationStoreError && cause.kind === "not_found") {
			return c.json({ error: "source not found" }, 404);
		}
		throw cause;
	}
	return c.json({ status: "deleted" }, 200);
});

// 評判: APIキー設定状態 (#31)。評判検索（#30）の前提キーが注入済みかを presence の boolean だけで返す。
// キー値そのものは絶対に返さない（秘匿）。設定 UI はこれを見て「未設定なら設定方法を案内」する。
// 取得元設定 CRUD（#34）・評判スコア（#36/#37）とは別ルートに分離する。
app.get("/api/reputation/config", (c) => {
	return c.json(resolveReputationApiKeyConfig(c.env.ANTHROPIC_API_KEY), 200);
});

// 評判: 手入力上書き (#35・fetch_method = manual)。任意のスコアを手で入れて company 単位 snapshot を積む。
// append-only で「最新 manual を積む＝上書き」を表現する（getLatest が最新を返す・§8）。company は body の
// companyName から解決する（求人の企業名抽出はまだ未配線のため・#117 で配線時に省略可へ）。
// 不正入力は保存前に 400、求人不在は 404、企業名が名寄せ不能なら 400 で弾く（決定的・コスト保護）。
app.put("/api/jobs/:id/reputation/manual", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}

	const parsed = parseManualReputationInput(body);
	if (!parsed.ok) {
		return c.json(
			{ error: "invalid manual reputation", reason: parsed.reason },
			400,
		);
	}

	// company 解決の法人番号 enrich は env 駆動で統一する（#117）。HOUJIN_BANGOU_APP_ID 未設定なら
	// resolveCorporateNumberClient が NULL クライアント（名寄せ強化なし・中立）へ倒す。
	const result = await saveManualReputation(
		{ db: c.env.DB, client: resolveCorporateNumberClient(c.env) },
		c.req.param("id"),
		parsed.value,
	);
	if (result.kind === "job-not-found") {
		return c.json({ error: "job not found" }, 404);
	}
	if (result.kind === "company-unresolved") {
		return c.json(
			{ error: "company could not be resolved", reason: "companyName" },
			400,
		);
	}
	return c.json({ snapshot: result.snapshot }, 200);
});

// 評判: URL/HTML 投入 → AI 抽出 (#35・fetch_method = url_html)。Workers AI で構造化スコアを取り出し保存する。
// url は fetchWithStrategy で取得（#115 再利用）、html は直接投入（ネットワーク不要）。AI を呼ぶ前に入力検証・
// 求人/企業解決で弾く（コスト保護）。取得失敗 502、AI 抽出失敗 502、求人不在 404、企業名不能 400。
app.post("/api/jobs/:id/reputation/url", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json body", reason: "body" }, 400);
	}

	const parsed = parseUrlHtmlReputationInput(body);
	if (!parsed.ok) {
		// 上限超過のみ 413、それ以外の入力不正は 400（POST /api/jobs と同方針）。
		const status = parsed.reason === "too-large" ? 413 : 400;
		return c.json(
			{ error: "invalid url/html reputation", reason: parsed.reason },
			status,
		);
	}

	const result = await ingestUrlHtmlReputation(
		{
			db: c.env.DB,
			ai: c.env.AI,
			client: resolveCorporateNumberClient(c.env),
			browser: c.env.BROWSER,
			extractOptions: { model: c.env.EXTRACTION_MODEL },
		},
		c.req.param("id"),
		parsed.value,
	);
	switch (result.kind) {
		case "job-not-found":
			return c.json({ error: "job not found" }, 404);
		case "company-unresolved":
			return c.json(
				{ error: "company could not be resolved", reason: "companyName" },
				400,
			);
		case "fetch-error":
			return c.json(
				{ error: "failed to fetch url", reason: result.reason },
				FETCH_ERROR_STATUS,
			);
		case "extraction-failed":
			return c.json(
				{ error: "reputation extraction failed", reason: "extraction" },
				FETCH_ERROR_STATUS,
			);
		default:
			return c.json({ snapshot: result.snapshot }, 201);
	}
});

// 評判: web_search 取得トリガー (#30)。企業（companies.id）の評判を Claude API の web_search で取得し
// reputation snapshot として保存する（fetch_method="web_search" 経路）。冪等＝fresh キャッシュがあれば
// web_search を呼ばず返す（§5.3 抽出↔スコアリング分離・キャッシュ）。
// - APIキー未設定は中立: 評判を取得せず 200 { status:"skipped" }（unknown 中立・分母除外は #36/#37）。
// - 企業未存在は 404。
// - 有効な web_search 取得元（#34）があればその name ごとに、無ければ既定 source 名で 1 件取得する。
// 注: 求人→企業名の供給は現状未配線（#32 申し送り）。本ルートは companies.id を入力に取得するコア層で、
//     求人本体（POST /api/jobs/:id/reputation）への自動配線は capstone #117 へ handoff する。
app.post("/api/companies/:id/reputation", async (c) => {
	const apiKey = c.env.ANTHROPIC_API_KEY;
	if (
		apiKey === undefined ||
		!resolveReputationApiKeyConfig(apiKey).apiKeyConfigured
	) {
		return c.json({ status: "skipped", reason: "api-key-not-configured" }, 200);
	}

	const companyId = c.req.param("id");
	const company = await getCompanyById(c.env.DB, companyId);
	if (company === null) return c.json({ error: "company not found" }, 404);

	// 有効な取得元のうち web_search 経路のみを対象にする（priority 昇順は store が保証）。
	// 取得元未設定でも web_search は §7.2 の主軸のため既定 source 名で単体成立させる。
	const enabled = await listReputationSources(c.env.DB, { enabledOnly: true });
	const webSearchSources = enabled.filter(
		(s) => s.fetch_method === "web_search",
	);
	const sourceNames =
		webSearchSources.length > 0
			? webSearchSources.map((s) => s.name)
			: [DEFAULT_WEB_SEARCH_SOURCE];

	const client = createClaudeReputationClient({
		apiKey,
		model: resolveReputationModel(c.env.REPUTATION_MODEL),
	});
	const maxAgeSeconds = resolveReputationMaxAgeSeconds(
		c.env.REPUTATION_MAX_AGE_SECONDS,
	);

	const snapshots = [];
	for (const source of sourceNames) {
		const result = await fetchReputationSnapshot(
			{ db: c.env.DB, client, maxAgeSeconds },
			{
				companyId,
				companyName: company.name,
				houjinBangou: company.houjin_bangou,
				source,
			},
		);
		snapshots.push({
			source,
			cached: result.cached,
			fetched: result.fetched,
			snapshot: result.snapshot,
		});
	}

	return c.json({ status: "ok", companyId, snapshots }, 200);
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
	// dev サーバログへ per-(model,case) 進捗を出す（#141 live 実測: 全 9 モデルが逐次 1 応答のため、
	// ログ無しでは低速か hang かを判別できず 30 分上限に達した）。model 順・case 数・所要 ms を出し、
	// どのモデルで停滞したかを driver の無音中に dev ログ側で追えるようにする。
	const totalModels = 1 + candidateModels.length;
	const totalCases = cases.length;
	const modelOrder = new Map<string, number>();
	const caseCounts = new Map<string, number>();
	const makeExtractor =
		(model: string): GoldenExtractor =>
		(html) => {
			if (!modelOrder.has(model)) modelOrder.set(model, modelOrder.size + 1);
			const mi = modelOrder.get(model) ?? 0;
			const ci = (caseCounts.get(model) ?? 0) + 1;
			caseCounts.set(model, ci);
			const tag = `[eval] model ${mi}/${totalModels} ${model} case ${ci}/${totalCases}`;
			const t0 = Date.now();
			console.log(`${tag} start`);
			return extractJobFromHtml(c.env.AI, html, { model })
				.then((r) => {
					console.log(`${tag} done ${Date.now() - t0}ms`);
					return r.job;
				})
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`${tag} ERROR ${Date.now() - t0}ms: ${msg}`);
					throw err;
				});
		};

	const selection = await evaluateModels(
		cases,
		baselineModel,
		candidateModels,
		makeExtractor,
	);
	return c.json(selection, 200);
});

// 認証下 Cookie ストアの明示削除（cleanup 導線・#190）。TTL 失効を待たず投入 Cookie を破棄できる。
// - ?url= 指定時はその origin 1 件だけ削除、未指定は単一テナント前提で全消し。
// - Cookie 値は一切返さない（削除件数のみ・§8 最小保持）。
app.delete("/api/auth/cookies", async (c) => {
	const url = c.req.query("url");
	const count =
		url !== undefined
			? await deleteCookie(c.env.AUTH_COOKIES, url)
			: await deleteAllCookies(c.env.AUTH_COOKIES);
	return c.json({ status: "deleted", count }, 200);
});

// API ルートに該当しない GET は静的資産（SPA）へフォールスルーする。
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
