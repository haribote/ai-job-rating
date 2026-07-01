// 求人投入・詳細取得・再抽出の API ロジック（#95 Task 2）。
//
// なぜこのモジュールが存在するか:
// - 旧 url-input / paste-input の SSR HTML を撤去し、ハンドラはバリデーション＋ JSON 応答へ縮約する。
//   取得・取込・スコアリングのコアは既存関数（fetchHtml / ingestJob / rescoreOne）に委ね、本層は
//   「入力検証」と「JSON 契約に合う構造の組み立て」のみを担う（責務分離 §9）。
// - 抽出とスコアリングの分離（§5.3）は壊さない。投入・再抽出は抽出 1 回＋保存、設定変更は別経路
//   （config.ts → rescoreAll）で AI 非再実行の再スコアのみ。

import type { NormalizedJob, NormalizedKey } from "../shared/job-schema";
import { NORMALIZED_KEYS } from "../shared/job-schema";
import type { AiRunner } from "./extract/ai";
import {
	AuthFetchError,
	type AuthFetchErrorKind,
	fetchAuthedHtml,
} from "./fetch/fetch-authed-html";
import { type Fetcher, FetchHtmlError, fetchHtml } from "./fetch/fetch-html";
import { classifyPage } from "./fetch/list-detail";
import { type DetailQueue, enqueueDetailJobs } from "./queue/detail-queue";
import {
	NORMALIZED_KEY_KINDS,
	type NormalizedKeyKind,
	parseDesired,
} from "./scoring/criteria-config";
import {
	DEFAULT_REPUTATION_WEIGHT_CONFIG,
	type ReputationConfidence,
	resolveReputationContribution,
} from "./scoring/reputation-score";
import {
	type CriteriaConfigRow,
	type ExtractionStatus,
	type HardFilter,
	type JobSourceType,
	type JobStatus,
	TABLE_NAMES,
	TOTAL_SCORE_CRITERION,
} from "./storage/db-schema";
import { ingestJob } from "./storage/ingest";
import {
	getRawHtml,
	type RawHtmlBucket,
	rawHtmlKey,
} from "./storage/raw-html-store";
import { listLatestReputationSnapshots } from "./storage/reputation-store";

// ---------------------------------------------------------------------------
// 入力バリデーション（決定的・純関数）
// ---------------------------------------------------------------------------

// 公開詳細 URL の決定的バリデーション。空入力と http(s) 以外のスキームを弾く（SSRF/誤投入の保護）。
export type ValidatedUrl =
	| { ok: true; url: string }
	| { ok: false; reason: "empty" | "invalid" };

export function validateJobUrl(input: string): ValidatedUrl {
	const trimmed = input.trim();
	if (trimmed === "") return { ok: false, reason: "empty" };
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "invalid" };
	}
	return { ok: true, url: trimmed };
}

// 貼り付け HTML の上限（バイト）。トリミング #9 / 抽出 #11 の負荷・コスト保護。
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export type ValidatedHtml =
	| { ok: true; html: string; bytes: number }
	| { ok: false; reason: "empty" | "too-large" };

// 貼り付け入力の決定的バリデーション。空入力とサイズ上限のみを判定し、内容は加工しない。
export function validatePastedHtml(input: string): ValidatedHtml {
	if (input.trim() === "") return { ok: false, reason: "empty" };
	// 文字数ではなく UTF-8 バイト長で上限判定する（マルチバイト求人ページを正しく扱う）。
	const bytes = new TextEncoder().encode(input).length;
	if (bytes > MAX_HTML_BYTES) return { ok: false, reason: "too-large" };
	return { ok: true, html: input, bytes };
}

// ---------------------------------------------------------------------------
// 投入（URL / 貼り付け）
// ---------------------------------------------------------------------------

export interface IngestDeps {
	ai: AiRunner;
	db: D1Database;
	bucket: RawHtmlBucket;
	queue: DetailQueue;
	// 抽出に使うモデル ID（アダプタの差し戻し点・#106）。handler が env.EXTRACTION_MODEL を渡す。
	model?: string;
	// テスト用に fetch を差し替える。未指定時は fetchHtml が globalThis.fetch を使う。
	fetcher?: Fetcher;
	timeoutMs?: number;
}

// 取得失敗の種別。上流取得の失敗（502 相当）として呼び出し側へ返す。
export type FetchErrorReason = "http" | "timeout" | "network";

// 認証下取得の失敗種別（#187）。auth は 401/403、invalid-credential は Cookie 構文不正、
// redirect は安全に追従できない redirect。fetchAuthedHtml の分類（AuthFetchErrorKind）を再利用する。
export type AuthErrorReason = AuthFetchErrorKind;

// URL 投入の結果。詳細は取込済み jobId、一覧はキュー投入件数、取得失敗は理由を返す。
// 認証下取得（cookie 指定）固有の失敗は auth-error として分けて返す（#187）。
export type IngestUrlResult =
	| { kind: "detail"; jobId: string; status: ExtractionStatus }
	| { kind: "list"; count: number }
	| { kind: "fetch-error"; reason: FetchErrorReason }
	| { kind: "auth-error"; reason: AuthErrorReason };

// URL 投入の追加オプション（#187）。cookie はリクエスト単位の秘匿値のため IngestDeps ではなく
// 引数で渡す。非空のときだけ認証下取得（fetchAuthedHtml）へ分岐する。
export interface IngestUrlOptions {
	cookie?: string;
}

// 取得 → 一覧なら detailUrls をキュー投入 / 詳細なら取込（永続化）。取得失敗は理由つきで返す。
// HTML は一切組み立てない（JSON 契約・#95）。想定外の例外（抽出層など）は握り潰さず再 throw する。
export async function ingestFromUrl(
	deps: IngestDeps,
	url: string,
	options: IngestUrlOptions = {},
): Promise<IngestUrlResult> {
	// cookie が非空なら認証下取得へ分岐する。Cookie は取得ヘッダにのみ使い保持しない（§8・#75）。
	const cookie = options.cookie;
	const useAuthed = typeof cookie === "string" && cookie !== "";
	let html: string;
	try {
		const result = useAuthed
			? await fetchAuthedHtml(url, cookie, {
					fetcher: deps.fetcher,
					timeoutMs: deps.timeoutMs,
				})
			: await fetchHtml(url, {
					fetcher: deps.fetcher,
					timeoutMs: deps.timeoutMs,
				});
		html = result.html;
	} catch (cause) {
		// AuthFetchError を先に判定する（fetchAuthedHtml は network/timeout を FetchHtmlError のまま透過）。
		if (cause instanceof AuthFetchError) {
			return { kind: "auth-error", reason: cause.kind };
		}
		if (cause instanceof FetchHtmlError) {
			return { kind: "fetch-error", reason: cause.kind };
		}
		throw cause;
	}

	// 一覧/詳細を判定（#21）。一覧は複数詳細 URL を非同期処理へ委ね（#24 producer）、
	// 詳細はその場で取込→永続化する。
	const classification = classifyPage(html, url);
	if (classification.kind === "list") {
		const count = await enqueueDetailJobs(deps.queue, classification, url);
		return { kind: "list", count };
	}
	const ingested = await ingestJob(
		{ ai: deps.ai, db: deps.db, bucket: deps.bucket, model: deps.model },
		{ html, sourceType: "detail", sourceUrl: url },
	);
	return {
		kind: "detail",
		jobId: ingested.jobId,
		status: ingested.extractionStatus,
	};
}

// 貼り付け HTML を取込→永続化し、jobId と抽出状態を返す（抽出 1 回・§5.3）。
export async function ingestFromHtml(
	deps: Pick<IngestDeps, "ai" | "db" | "bucket" | "model">,
	html: string,
): Promise<{ jobId: string; status: ExtractionStatus }> {
	const ingested = await ingestJob(
		{ ai: deps.ai, db: deps.db, bucket: deps.bucket, model: deps.model },
		{ html, sourceType: "paste" },
	);
	return { jobId: ingested.jobId, status: ingested.extractionStatus };
}

// ---------------------------------------------------------------------------
// 詳細取得（GET /api/jobs/:id）
// ---------------------------------------------------------------------------

// 詳細レスポンスの jobs メタ。
export interface JobDetailMeta {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly sourceType: JobSourceType;
	readonly status: JobStatus;
	readonly fetchedAt: number;
}

// 詳細レスポンスの抽出メタ＋正規化済み求人。
export interface JobDetailExtraction {
	readonly status: ExtractionStatus;
	readonly model: string;
	readonly mechanism: string;
	readonly extractedAt: number;
	readonly structured: NormalizedJob;
}

// 内訳 1 行（フラット）。希望値・ハードフィルタは criteria_config 由来、raw は抽出値、score 等は scores 由来。
export interface BreakdownRow {
	readonly key: NormalizedKey;
	readonly kind: NormalizedKeyKind["kind"];
	readonly weight: number;
	readonly score: number | null;
	readonly included: boolean;
	readonly raw: string;
	readonly hardFilter: HardFilter;
	readonly desired: unknown;
}

// 企業評判の取得元 1 件ぶんの出所（UI 明示用・#117）。overall_score / review_count は取得元ネイティブ
// スケールのまま（正規化・信頼度重み付けは company 軸合流時に行う）。未取得値は null（中立）。
export interface JobReputationSource {
	readonly source: string;
	readonly overallScore: number | null;
	readonly reviewCount: number | null;
}

// 企業評判の company 軸への寄与（#36 seam を配線・#117）。score は件数で信頼度重み付けした 0..1（中立は
// null＝company 軸の分母から除外）。weight は companySize / capital と並ぶ 1 項目分の重み。confidence は
// 低信頼フラグ（#37）。sources は出所明示。ANTHROPIC_API_KEY 未設定時は score=null・sources=[] で中立除外。
export interface JobReputation {
	readonly score: number | null;
	readonly weight: number;
	readonly confidence: ReputationConfidence;
	readonly sources: readonly JobReputationSource[];
}

export interface JobDetail {
	readonly job: JobDetailMeta;
	readonly extraction: JobDetailExtraction;
	readonly total: number | null;
	readonly breakdown: readonly BreakdownRow[];
	readonly reputation: JobReputation;
}

// 正規キーの値から表示用の生表記を取り出す。raw が無ければ空文字。
function rawOf(job: NormalizedJob, key: NormalizedKey): string {
	const value = job[key];
	return "raw" in value && typeof value.raw === "string" ? value.raw : "";
}

// 1 求人の詳細（jobs メタ・最新抽出・スコア内訳・企業評判寄与）を組む（決定的・AI 非依存）。
// 求人または抽出が存在しなければ null（呼び出し側が 404 にする）。
// apiKeyConfigured は ANTHROPIC_API_KEY の presence（呼び出し側が env から解決）。未設定なら評判を中立除外する。
export async function readJobDetail(
	db: D1Database,
	jobId: string,
	apiKeyConfigured: boolean,
): Promise<JobDetail | null> {
	const jobRow = await db
		.prepare(
			`SELECT id, source_url, source_type, status, fetched_at, company_id FROM ${TABLE_NAMES.jobs} WHERE id = ?`,
		)
		.bind(jobId)
		.first<{
			id: string;
			source_url: string;
			source_type: JobSourceType;
			status: JobStatus;
			fetched_at: number;
			company_id: string | null;
		}>();
	if (jobRow === null) return null;

	// 最新抽出（extracted_at 最大・同値は id 最大）を 1 件に畳む。
	const extractionRow = await db
		.prepare(
			`SELECT structured_json, model, mechanism, extraction_status, extracted_at
			 FROM ${TABLE_NAMES.extractions}
			 WHERE job_id = ?
			 ORDER BY extracted_at DESC, id DESC
			 LIMIT 1`,
		)
		.bind(jobId)
		.first<{
			structured_json: string;
			model: string;
			mechanism: string;
			extraction_status: ExtractionStatus;
			extracted_at: number;
		}>();
	if (extractionRow === null) return null;
	const structured = JSON.parse(extractionRow.structured_json) as NormalizedJob;

	// scores 行（criterion 昇順で決定的）。__total__ は total へ、それ以外は内訳の材料へ。
	const { results: scoreRows } = await db
		.prepare(
			`SELECT criterion, sub_score, included, weight
			 FROM ${TABLE_NAMES.scores}
			 WHERE job_id = ?
			 ORDER BY criterion`,
		)
		.bind(jobId)
		.all<{
			criterion: string;
			sub_score: number | null;
			included: 0 | 1;
			weight: number | null;
		}>();

	// criteria_config（希望値・ハードフィルタ）を引きやすい Map へ。
	const { results: configRows } = await db
		.prepare(
			`SELECT criterion, desired_value, weight, hard_filter, updated_at FROM ${TABLE_NAMES.criteriaConfig}`,
		)
		.all<CriteriaConfigRow>();
	const configByKey = new Map(configRows.map((r) => [r.criterion, r]));

	let total: number | null = null;
	const scoreByKey = new Map<
		string,
		{ score: number | null; included: boolean; weight: number }
	>();
	for (const row of scoreRows) {
		if (row.criterion === TOTAL_SCORE_CRITERION) {
			total = row.sub_score;
			continue;
		}
		scoreByKey.set(row.criterion, {
			score: row.sub_score,
			included: row.included === 1,
			weight: row.weight ?? 0,
		});
	}

	// 内訳は NORMALIZED_KEYS の順で決定的に並べる（永続化順に依存しない）。
	const breakdown: BreakdownRow[] = NORMALIZED_KEYS.map((key) => {
		const s = scoreByKey.get(key);
		const config = configByKey.get(key);
		return {
			key,
			kind: NORMALIZED_KEY_KINDS[key].kind,
			weight: s?.weight ?? config?.weight ?? 0,
			score: s?.score ?? null,
			included: s?.included ?? false,
			raw: rawOf(structured, key),
			hardFilter: config?.hard_filter ?? "none",
			desired: parseDesired(config?.desired_value ?? null),
		};
	});

	// 企業評判を company 軸へ合流する寄与（#36 seam を配線・#117）。企業未紐付けは snapshots なし＝中立。
	// ANTHROPIC_API_KEY 未設定なら resolveReputationContribution が score=null・confidence=none へ倒す（中立除外）。
	const snapshots =
		jobRow.company_id === null
			? []
			: await listLatestReputationSnapshots(db, jobRow.company_id);
	const contribution = resolveReputationContribution(
		apiKeyConfigured,
		snapshots,
	);
	// 出所明示はキー設定済みのときだけ surface する（未設定は評判機能自体が無効＝中立除外と整合）。
	const reputation: JobReputation = {
		score: contribution.score,
		weight: DEFAULT_REPUTATION_WEIGHT_CONFIG.weight,
		confidence: contribution.confidence,
		sources: apiKeyConfigured
			? snapshots.map((s) => ({
					source: s.source,
					overallScore: s.overall_score,
					reviewCount: s.review_count,
				}))
			: [],
	};

	return {
		job: {
			jobId: jobRow.id,
			sourceUrl: jobRow.source_url,
			sourceType: jobRow.source_type,
			status: jobRow.status,
			fetchedAt: jobRow.fetched_at,
		},
		extraction: {
			status: extractionRow.extraction_status,
			model: extractionRow.model,
			mechanism: extractionRow.mechanism,
			extractedAt: extractionRow.extracted_at,
			structured,
		},
		total,
		breakdown,
		reputation,
	};
}

// ---------------------------------------------------------------------------
// 再抽出（POST /api/jobs/:id/reextract）
// ---------------------------------------------------------------------------

// 「再抽出」はユーザーの明示操作として AI 抽出を意図的に再実行する（設定変更の再スコアとは別軸・§5.3）。
// 保存済みの生 HTML(R2) を読み戻し、同一 job へ取込し直す（新規 job を作らない）。
// 求人・生 HTML が無ければ null（呼び出し側が 404 にする）。
export async function reextractJob(
	deps: Pick<IngestDeps, "ai" | "db" | "bucket" | "model">,
	jobId: string,
): Promise<{ status: ExtractionStatus } | null> {
	const jobRow = await deps.db
		.prepare(
			`SELECT source_url, raw_html_r2_key FROM ${TABLE_NAMES.jobs} WHERE id = ?`,
		)
		.bind(jobId)
		.first<{ source_url: string; raw_html_r2_key: string | null }>();
	if (jobRow === null) return null;

	// 紐付けキーが無ければ決定的キーを試す（保存形式は rawHtmlKey に固定・#17）。
	const key = jobRow.raw_html_r2_key ?? rawHtmlKey(jobId);
	const html = await getRawHtml(deps.bucket, key);
	if (html === null) return null;

	// source_url を一次キーに同一 job へ取込し直す（sourceType は paste 含め "detail" 経路で
	// 既存 job に集約され、新 id を採番しない）。AI 抽出はここで再実行される（意図的）。
	const ingested = await ingestJob(
		{ ai: deps.ai, db: deps.db, bucket: deps.bucket, model: deps.model },
		{ html, sourceType: "detail", sourceUrl: jobRow.source_url },
	);
	return { status: ingested.extractionStatus };
}
