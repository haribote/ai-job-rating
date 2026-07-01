// #116 deploy 後 live スモークの純粋ロジック。
//
// なぜ分離するか:
// - live スモーク本体（scripts/live-smoke.mjs）は deploy 済み URL へ fetch する薄い I/O。
//   到達なしに検証できる「引数解釈・レスポンス解釈・合否判定・整形」だけをここへ集約し、
//   ユニットテストで担保する（eval-driver.ts と同じ I/O 分離思想）。
// - runtime-only バグ（未バンドル dynamic import → No such module・binding 未解決等）は
//   live でしか露見しないため、スモーク結果の解釈を決定的な純関数にしておく。

// 残置ジョブを人間が UI/一覧で識別するためのマーカー。paste 取込は source_url を内部採番するため
// マーカーは HTML 本文（会社名・職種名）へ埋め、cleanup はドライバ出力の jobId 指定で行う。
export const SMOKE_MARKER = "AI-JOB-RATING-LIVE-SMOKE";

// 1 リクエストの応答待ち上限（ms）。過去バグ「fetch timeout 欠落で fetch failed」対策として
// ドライバは必ず AbortController でこの値を付与する。--timeout-ms で上書き可。
// 既定は 120s: 最小抽出は同期 Workers AI 推論＋D1/R2 書込を挟むため、cold model load でも
// 健全な deploy を timeout で false FAIL にしないよう余裕を取る。
export const DEFAULT_SMOKE_TIMEOUT_MS = 120_000;

export type SmokeOutcome = "pass" | "fail" | "skip";

// レスポンス解釈の結果。id/label はドライバが付与する。
export interface SmokeInterpretation {
	readonly outcome: SmokeOutcome;
	readonly detail: string;
}

export interface SmokeCheckResult extends SmokeInterpretation {
	readonly id: string;
	readonly label: string;
}

// CLI 引数。baseUrl は必須（欠落は errors へ）。spaUrl/companyId は full チェックの前提。
export interface SmokeArgs {
	readonly baseUrl: string | null;
	readonly spaUrl: string | null;
	readonly companyId: string | null;
	readonly coreOnly: boolean;
	readonly timeoutMs: number;
	// #183 サイトアクセス制限（Basic 認証）用 credential。両方揃うときだけドライバが Authorization を付与する。
	readonly authUser: string | null;
	readonly authPass: string | null;
	readonly errors: readonly string[];
}

// Basic 認証ヘッダを組む（#183）。片方でも欠ければ null＝認証なし（本番の fail-open 構成と両対応）。
export function buildBasicAuthHeader(
	user: string | null,
	pass: string | null,
): string | null {
	if (!user || !pass) return null;
	return `Basic ${btoa(`${user}:${pass}`)}`;
}

// 最小合成求人 HTML。AI 抽出へ十分な信号を与えつつマーカーで残置ジョブを識別可能にする。
// golden 実体は PII/gitignore のため使わない（決定的な合成データに留める）。
export function buildSmokeHtml(): string {
	return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>${SMOKE_MARKER} バックエンドエンジニア</title></head>
<body>
<h1>${SMOKE_MARKER} 株式会社 — バックエンドエンジニア募集</h1>
<dl>
<dt>雇用形態</dt><dd>正社員</dd>
<dt>勤務地</dt><dd>東京都（フルリモート可）</dd>
<dt>給与</dt><dd>年収 600万円〜900万円</dd>
<dt>休日</dt><dd>完全週休二日制（土日祝）</dd>
<dt>必須スキル</dt><dd>TypeScript, Cloudflare Workers</dd>
</dl>
<p>これは live スモーク用の合成求人です（${SMOKE_MARKER}）。</p>
</body>
</html>`;
}

// unknown を安全にレコードとして読む補助。
function asRecord(body: unknown): Record<string, unknown> {
	return typeof body === "object" && body !== null
		? (body as Record<string, unknown>)
		: {};
}

// レスポンス本文を detail 用に短く文字列化する（長大 body で出力を汚さない）。
function snippet(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	if (text === undefined) return "";
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// GET /api/health: binding 不要の到達性。
export function interpretHealth(
	status: number,
	body: unknown,
): SmokeInterpretation {
	if (status === 200 && asRecord(body).status === "ok") {
		return { outcome: "pass", detail: "status=ok" };
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// GET /api/ai-health: AI binding 解決＋最小推論。ok:false は binding 未解決等を示す。
export function interpretAiHealth(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	if (rec.ok === true) {
		return {
			outcome: "pass",
			detail: `model=${rec.model} reply=${snippet(rec.reply)}`,
		};
	}
	if (rec.ok === false) {
		return { outcome: "fail", detail: `error=${snippet(rec.error)}` };
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// POST /api/jobs {html}: AI 抽出＋D1＋R2。201 で jobId を返せば成立。
export function interpretExtraction(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	if (status === 201 && typeof rec.jobId === "string") {
		return {
			outcome: "pass",
			detail: `jobId=${rec.jobId} status=${rec.status}`,
		};
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// GET /api/jobs/:id: 永続化＋スコアリング。job.jobId と breakdown 配列があれば成立。
export function interpretJobDetail(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	const job = asRecord(rec.job);
	if (
		status === 200 &&
		typeof job.jobId === "string" &&
		Array.isArray(rec.breakdown)
	) {
		return {
			outcome: "pass",
			detail: `total=${rec.total} breakdown=${rec.breakdown.length}件`,
		};
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// GET /api/reputation/config: ANTHROPIC_API_KEY binding の presence。到達すれば成立
// （未設定でも fail ではない。Claude 検索を実行するかの判断材料）。
export function interpretReputationConfig(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	if (status === 200 && typeof rec.apiKeyConfigured === "boolean") {
		return {
			outcome: "pass",
			detail: `apiKeyConfigured=${rec.apiKeyConfigured}`,
		};
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// GET /api/reputation/sources: reputation D1 到達性（課金なし）。
export function interpretReputationSources(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	if (status === 200 && Array.isArray(rec.sources)) {
		return { outcome: "pass", detail: `sources=${rec.sources.length}件` };
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// POST /api/companies/:id/reputation: Claude API web_search（課金）。
// skipped はキー未設定など＝スモークとしては skip。404 は company-id 誤り＝fail。
export function interpretReputation(
	status: number,
	body: unknown,
): SmokeInterpretation {
	const rec = asRecord(body);
	if (status === 200 && rec.status === "ok") {
		const count = Array.isArray(rec.snapshots) ? rec.snapshots.length : 0;
		return {
			outcome: "pass",
			detail: `companyId=${rec.companyId} snapshots=${count}件`,
		};
	}
	if (status === 200 && rec.status === "skipped") {
		return { outcome: "skip", detail: `skipped reason=${rec.reason}` };
	}
	if (status === 404) {
		return {
			outcome: "fail",
			detail: "company not found（--company-id を確認）",
		};
	}
	return { outcome: "fail", detail: `status=${status} body=${snippet(body)}` };
}

// POST /api/jobs {url}: BR フォールバック経由取得。2xx なら @cloudflare/puppeteer の
// dynamic import がバンドル済みで成立（No such module が出ていない）。非2xx は runtime バグか上流失敗。
export function interpretBrowserRender(
	status: number,
	body: unknown,
): SmokeInterpretation {
	if (status >= 200 && status < 300) {
		return {
			outcome: "pass",
			detail: `status=${status}（dynamic import バンドル成立）`,
		};
	}
	return {
		outcome: "fail",
		detail: `status=${status} body=${snippet(body)}（No such module 等の runtime バグか上流取得失敗）`,
	};
}

// 必須/任意を問わず fail が 1 つでもあれば非ゼロ。skip は落とさない。
export function decideExitCode(results: readonly SmokeCheckResult[]): number {
	return results.some((r) => r.outcome === "fail") ? 1 : 0;
}

// 既知のオプションのみ受理する。baseUrl 欠落・不正値・未知オプションは errors へ集約する。
export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
	let baseUrl: string | null = null;
	let spaUrl: string | null = null;
	let companyId: string | null = null;
	let coreOnly = false;
	let timeoutMs = DEFAULT_SMOKE_TIMEOUT_MS;
	let authUser: string | null = null;
	let authPass: string | null = null;
	const errors: string[] = [];

	// オプションの値を 1 つ消費する。値が無い/次がフラグ（--）なら消費せず errors へ
	// （`--base-url --core-only` のように次のフラグを値として飲み込むのを防ぐ）。
	let i = 0;
	const takeValue = (name: string): string | null => {
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			errors.push(`${name} に値がありません`);
			return null;
		}
		i += 1;
		return next;
	};

	for (; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--base-url":
				baseUrl = takeValue("--base-url");
				break;
			case "--spa-url":
				spaUrl = takeValue("--spa-url");
				break;
			case "--company-id":
				companyId = takeValue("--company-id");
				break;
			case "--timeout-ms": {
				const value = takeValue("--timeout-ms");
				if (value !== null) {
					const n = Number(value);
					if (!Number.isFinite(n) || n <= 0) {
						errors.push(`--timeout-ms が不正です: ${value}`);
					} else {
						timeoutMs = n;
					}
				}
				break;
			}
			case "--auth-user":
				authUser = takeValue("--auth-user");
				break;
			case "--auth-pass":
				authPass = takeValue("--auth-pass");
				break;
			case "--core-only":
				coreOnly = true;
				break;
			default:
				errors.push(`未知のオプション: ${arg}`);
		}
	}

	if (baseUrl === null) {
		errors.push("--base-url は必須です（例: --base-url https://<deployed>）");
	} else {
		baseUrl = baseUrl.replace(/\/+$/, "");
	}

	return {
		baseUrl,
		spaUrl,
		companyId,
		coreOnly,
		timeoutMs,
		authUser,
		authPass,
		errors,
	};
}

// PASS/FAIL/SKIP を理由付きで整形する。末尾に合否サマリを付す。
export function formatSmokeReport(
	results: readonly SmokeCheckResult[],
): string {
	const lines = results.map((r) => {
		const tag = r.outcome.toUpperCase().padEnd(4);
		return `[${tag}] ${r.label} — ${r.detail}`;
	});
	const pass = results.filter((r) => r.outcome === "pass").length;
	const fail = results.filter((r) => r.outcome === "fail").length;
	const skip = results.filter((r) => r.outcome === "skip").length;
	lines.push("");
	lines.push(
		`合計 ${results.length}: PASS ${pass} / FAIL ${fail} / SKIP ${skip}`,
	);
	return lines.join("\n");
}
