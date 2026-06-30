// 企業評判の web_search 取得層（Claude API の web_search server tool・要件 §7.2 / #30）。
//
// なぜこのモジュールが存在するか:
// - 企業名（任意で法人番号）から評判の総合スコア・件数・サブ項目を Claude API の web_search で取得し、
//   reputation snapshot として保存する取得経路（fetch_method = "web_search"）を担う。
// - 外部 API（Anthropic Messages API）はアダプタ（ReputationWebSearchClient）越しにし、本体ロジックは
//   fetch を注入してフル offline・決定的にテストできるようにする（companies/houjin-bangou.ts の流儀）。
//   ANTHROPIC_API_KEY の実値はコードに直書きせず env 経由で注入する（フォーク容易性 §8）。
// - 取得（生 web_search 結果 → overall/count/sub-scores への構造化）と保存までが本層の責務。加重合算・
//   信頼度重み（#36）や company 軸への合流（#117）には踏み込まない（抽出↔スコアリング分離 §5.3）。
// - 冪等/キャッシュ: getLatestReputationSnapshot + isReputationSnapshotFresh で fresh ならキャッシュ返却、
//   stale/未取得なら web_search → saveReputationSnapshot で追記する。
//
// 一次ソース（claude-api skill / platform.claude.com）:
//   - 既定モデル: claude-opus-4-8（記憶でなく skill 記載の正確な model id）。
//   - web_search server tool: type = "web_search_20260209"（Opus 4.8/4.7/4.6・dynamic filtering 内蔵。
//     追加 beta header 不要）。POST /v1/messages・header は x-api-key / anthropic-version: 2023-06-01。
//   - 構造化出力: output_config.format は citations と非互換で、web_search は citations を伴う。よって
//     抽出機構（#106）と同じ「JSON テキストで返させ、コード側で検証/修復」方針を採る（§7.1 の流儀）。

import type { ReputationSnapshotRow } from "../storage/db-schema";
import {
	getLatestReputationSnapshot,
	isReputationSnapshotFresh,
	saveReputationSnapshot,
} from "../storage/reputation-store";

// 既定モデル（claude-api skill 一次ソース）。フォーク先は env.REPUTATION_MODEL で上書きできる。
export const DEFAULT_REPUTATION_MODEL = "claude-opus-4-8";

// Anthropic Messages API のエンドポイント base（公式）。テストや代理経由のため上書き可能にする。
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// web_search server tool の type（Opus 4.8/4.7/4.6・dynamic filtering 内蔵）。値は claude-api skill
// 由来だが、live POST /v1/messages での tool type・応答ブロック形は #116 で実検証する（要手動検証。
// houjin-bangou.ts の live 系 API 形 caveat に倣う）。誤りなら 400 を catch して null 中立に倒れる。
const WEB_SEARCH_TOOL_TYPE = "web_search_20260209";

// Messages API のバージョンヘッダ（公式の固定値・要手動検証は #116）。
const ANTHROPIC_VERSION = "2023-06-01";

// 構造化 JSON は小さいため控えめな上限で足りる（非ストリーミングの HTTP timeout も避ける）。
const DEFAULT_MAX_TOKENS = 4096;

// 評判キャッシュの既定鮮度。評判は緩やかに変化するため 30 日を既定とする（env で上書き可能）。
export const DEFAULT_REPUTATION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// 取得元設定（#34）に有効な web_search 取得元が無い場合に使う既定の source 名。
// web_search は §7.2 の主軸のため、取得元未設定でも単体で成立させる（snapshot.source の soft 参照キー）。
export const DEFAULT_WEB_SEARCH_SOURCE = "web_search";

// web_search の生結果を構造化した取得層の出力。スケール・サブ項目スキーマの正規化はスコア層（#36）へ委ねる。
// 各フィールドは「取得したが該当なし」を null で表す（unknown 中立・§5.2・negative cache）。
export interface RawReputationResult {
	// 総合スコア（取得元のネイティブスケール。既定プロンプトは 0–5 を要求するがスケール正規化は #36）。
	readonly overallScore: number | null;
	// 口コミ件数（非負整数）。信頼度減衰（#36）に使う。
	readonly reviewCount: number | null;
	// サブ項目スコア（名前→数値）。解釈・正規化は #36。空・取得不能は null。
	readonly subScores: Record<string, number> | null;
}

// web_search 取得の入力。法人番号は同名他社との取り違え防止に使う（任意）。
export interface ReputationSearchInput {
	readonly companyName: string;
	readonly houjinBangou?: string | null;
}

// 外部 API の差し替え点。テストは Fake/注入 fetch で回し、本番は Claude クライアントを使う。
// 取得失敗（キー欠落・通信失敗・非 2xx・応答が parse 不能）は null を返し、保存をスキップさせる
// （NULL 保存＝negative cache を汚染して 30 日リトライしなくなるのを防ぐ。houjin-bangou.ts の中立倒しに準ずる）。
export interface ReputationWebSearchClient {
	search(input: ReputationSearchInput): Promise<RawReputationResult | null>;
}

// ---------------------------------------------------------------------------
// 純関数（決定的・ユニットテスト対象）
// ---------------------------------------------------------------------------

// env.REPUTATION_MODEL の上書きを解決する（未設定/空白はコード既定へフォールバック・EXTRACTION_MODEL に倣う）。
export function resolveReputationModel(envValue: string | undefined): string {
	const trimmed = envValue?.trim();
	return trimmed ? trimmed : DEFAULT_REPUTATION_MODEL;
}

// env.REPUTATION_MAX_AGE_SECONDS の上書きを解決する（非負整数のみ採用・不正/未設定は既定）。
export function resolveReputationMaxAgeSeconds(
	envValue: string | undefined,
): number {
	if (envValue === undefined) return DEFAULT_REPUTATION_MAX_AGE_SECONDS;
	const n = Number(envValue);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		return DEFAULT_REPUTATION_MAX_AGE_SECONDS;
	}
	return n;
}

// web_search を指示し JSON で評判を返させるユーザープロンプトを組み立てる（純関数）。
// 日本の求人口コミサイトを意識させ、スコアは取得元ネイティブの 0–5 スケールで求める（正規化は #36）。
export function buildReputationPrompt(input: ReputationSearchInput): string {
	const houjin =
		input.houjinBangou && input.houjinBangou.trim() !== ""
			? `（法人番号: ${input.houjinBangou.trim()}）`
			: "";
	return [
		`企業「${input.companyName}」${houjin} の従業員・元従業員による評判を web 検索で調べてください。`,
		"OpenWork・エンライトハウス・転職会議などの日本の口コミサイトを優先し、同名他社と取り違えないこと。",
		"調査後、次のキーだけを持つ JSON オブジェクトを 1 つだけ返してください（前後に説明文を付けない）:",
		"- overallScore: 総合評価（0〜5 のネイティブスケール、数値）。取得できなければ null。",
		"- reviewCount: 口コミ件数（非負整数）。取得できなければ null。",
		'- subScores: 観点別スコアのオブジェクト（例 {"成長":4.0,"給与":3.5}、各値 0〜5 の数値）。無ければ null。',
		"確かな評判情報が全く見つからない場合は overallScore/reviewCount/subScores を全て null にしてください。",
	].join("\n");
}

// Anthropic Messages API の応答 body から最終テキスト（text ブロック連結）を取り出す（純関数）。
// content の各ブロックのうち type==="text" のものだけを連結する。web_search の結果ブロック等は無視する。
export function extractTextFromAnthropicResponse(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const content = (body as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("");
}

// テキストから最初に parse 可能な JSON オブジェクトを切り出す（コードフェンス・前後/途中の説明文に頑健）。
// 各 "{" を起点に文字列リテラルを考慮して括弧の対応を取り、対応が閉じた時点で JSON.parse を試す。
// 最初に成功したオブジェクトを返す。貪欲な first"{"〜last"}" スライスだと、JSON より前の散文に "{" が
// 紛れた場合に散文ごと掴んで parse 失敗するため、起点を走査して取り違えを防ぐ（負荷も実質線形）。
function findFirstJsonObject(text: string): Record<string, unknown> | null {
	for (
		let start = text.indexOf("{");
		start !== -1;
		start = text.indexOf("{", start + 1)
	) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
			} else if (ch === "{") {
				depth++;
			} else if (ch === "}") {
				depth--;
				if (depth === 0) {
					// 対応が閉じた候補を parse。オブジェクトなら採用、ダメなら次の "{" 起点へ。
					try {
						const parsed: unknown = JSON.parse(text.slice(start, i + 1));
						if (
							typeof parsed === "object" &&
							parsed !== null &&
							!Array.isArray(parsed)
						) {
							return parsed as Record<string, unknown>;
						}
					} catch {
						// この起点は不発。外側ループで次の "{" を試す。
					}
					break;
				}
			}
		}
	}
	return null;
}

// 有限数値のみ採用するヘルパ。NaN/Infinity/非数値は採用しない。
function asFiniteNumber(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// web_search 応答テキストを構造化結果へ検証/修復する（純関数）。
// - JSON が全く取り出せない/parse できない → null（取得失敗扱いで保存しない＝次回リトライ可能にする）。
// - parse できたがスコアが無い → 全フィールド null の結果（「取得したが該当なし」negative cache・§5.2）。
// - overallScore はスケールが取得元依存（#33）のため範囲クランプはせず、有限数値か否かだけ見る。
// - reviewCount は非負整数へ寄せる（小数は切り捨て、負値は null）。
// - subScores は有限数値の値だけ残し、空になれば null。
export function parseReputationResult(
	text: string,
): RawReputationResult | null {
	const o = findFirstJsonObject(text);
	if (o === null) return null;

	const overallScore = asFiniteNumber(o.overallScore);

	let reviewCount: number | null = null;
	const rc = asFiniteNumber(o.reviewCount);
	if (rc !== null && rc >= 0) {
		reviewCount = Math.floor(rc);
	}

	let subScores: Record<string, number> | null = null;
	if (
		typeof o.subScores === "object" &&
		o.subScores !== null &&
		!Array.isArray(o.subScores)
	) {
		const cleaned: Record<string, number> = {};
		for (const [k, v] of Object.entries(o.subScores)) {
			const n = asFiniteNumber(v);
			if (n !== null) cleaned[k] = n;
		}
		if (Object.keys(cleaned).length > 0) subScores = cleaned;
	}

	return { overallScore, reviewCount, subScores };
}

// ---------------------------------------------------------------------------
// アダプタ（Claude API クライアント）
// ---------------------------------------------------------------------------

export interface ClaudeReputationClientConfig {
	// ANTHROPIC_API_KEY の実値（秘匿・env 注入）。空なら API を呼ばず中立（null）に倒す。
	apiKey: string;
	// 使用モデル（既定 DEFAULT_REPUTATION_MODEL）。
	model?: string;
	// エンドポイント base の上書き（既定 DEFAULT_ANTHROPIC_BASE_URL）。
	baseUrl?: string;
	// 出力上限（既定 DEFAULT_MAX_TOKENS）。
	maxTokens?: number;
	// 注入 fetch（テスト用）。既定はグローバル fetch。
	fetchImpl?: typeof fetch;
}

// Claude API（web_search server tool）で評判を取得するクライアント。失敗は null で中立に倒す（非ブロック）。
export function createClaudeReputationClient(
	config: ClaudeReputationClientConfig,
): ReputationWebSearchClient {
	const fetchImpl = config.fetchImpl ?? fetch;
	const model = config.model ?? DEFAULT_REPUTATION_MODEL;
	const baseUrl = config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
	const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

	return {
		async search(input) {
			if (config.apiKey.trim() === "" || input.companyName.trim() === "") {
				return null;
			}
			try {
				const res = await fetchImpl(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": config.apiKey,
						"anthropic-version": ANTHROPIC_VERSION,
					},
					body: JSON.stringify({
						model,
						max_tokens: maxTokens,
						tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search" }],
						messages: [{ role: "user", content: buildReputationPrompt(input) }],
					}),
				});
				if (!res.ok) return null;
				const body = await res.json();
				return parseReputationResult(extractTextFromAnthropicResponse(body));
			} catch {
				// web_search は best-effort。失敗しても求人処理を止めない（unknown 中立 §5.2）。
				return null;
			}
		},
	};
}

// API 無効時の既定クライアント（常に null＝中立・取得しない）。
export const NULL_REPUTATION_CLIENT: ReputationWebSearchClient = {
	async search() {
		return null;
	},
};

// ---------------------------------------------------------------------------
// 冪等オーケストレータ（キャッシュヒット/ミス・取得→保存）
// ---------------------------------------------------------------------------

export interface FetchReputationSnapshotDeps {
	db: D1Database;
	client: ReputationWebSearchClient;
	// 鮮度判定の maxAge（既定 DEFAULT_REPUTATION_MAX_AGE_SECONDS）。
	maxAgeSeconds?: number;
	// 現在 unix 秒の注入点（テスト決定化）。
	now?: () => number;
}

export interface FetchReputationSnapshotParams {
	companyId: string;
	companyName: string;
	houjinBangou?: string | null;
	// snapshot.source（取得元名・soft 参照）。既定は DEFAULT_WEB_SEARCH_SOURCE。
	source?: string;
}

export interface FetchReputationSnapshotResult {
	// 返却スナップショット（fresh キャッシュ or 今回保存）。取得失敗かつキャッシュ無しなら null。
	snapshot: ReputationSnapshotRow | null;
	// fresh キャッシュから返したか。
	cached: boolean;
	// 今回 web_search を実行し新規スナップショットを保存したか。
	fetched: boolean;
}

// 企業 1 件・取得元 1 件の評判スナップショットを取得する（冪等）。
// fresh なキャッシュがあれば web_search を呼ばずに返す。stale/未取得なら web_search→保存する。
// 取得失敗（client が null）は保存しない（negative cache 汚染回避）。既存キャッシュがあればそれを返す。
export async function fetchReputationSnapshot(
	deps: FetchReputationSnapshotDeps,
	params: FetchReputationSnapshotParams,
): Promise<FetchReputationSnapshotResult> {
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const maxAgeSeconds =
		deps.maxAgeSeconds ?? DEFAULT_REPUTATION_MAX_AGE_SECONDS;
	const source = params.source ?? DEFAULT_WEB_SEARCH_SOURCE;

	const cached = await getLatestReputationSnapshot(
		deps.db,
		params.companyId,
		source,
	);
	if (
		cached !== null &&
		isReputationSnapshotFresh(cached, maxAgeSeconds, now())
	) {
		return { snapshot: cached, cached: true, fetched: false };
	}

	const raw = await deps.client.search({
		companyName: params.companyName,
		houjinBangou: params.houjinBangou,
	});
	if (raw === null) {
		// 取得失敗。保存せず、既存キャッシュ（stale でも）があればそれを返す。
		return { snapshot: cached, cached: false, fetched: false };
	}

	const saved = await saveReputationSnapshot(
		deps.db,
		{
			companyId: params.companyId,
			source,
			overallScore: raw.overallScore,
			reviewCount: raw.reviewCount,
			// null は「サブ項目なし」として NULL 保存する（undefined と同義に倒す）。
			subScores: raw.subScores ?? undefined,
		},
		// 鮮度判定と保存で同じ時計を使う（注入時計の決定性契約を保存行の fetched_at にも効かせる）。
		{ now },
	);
	return { snapshot: saved, cached: false, fetched: true };
}
