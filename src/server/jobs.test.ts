import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../shared/job-schema";
import type { AiRunner } from "./extract/ai";
import type { Fetcher } from "./fetch/fetch-html";
import {
	ingestFromHtml,
	ingestFromUrl,
	readJobDetail,
	reextractJob,
	validateJobUrl,
	validatePastedHtml,
} from "./jobs";
import type { DetailJobMessage, DetailQueue } from "./queue/detail-queue";
import type {
	BrowserLauncher,
	RenderBrowser,
	RenderedPage,
} from "./render-html";
import { DEFAULT_REPUTATION_WEIGHT_CONFIG } from "./scoring/reputation-score";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "./storage/db-schema";

// 詳細経路のテストはキューを使わない。投入を握り潰す no-op キュー。
const noopQueue: DetailQueue = { sendBatch: async () => {} };

// 年収を返す fake AI。実推論なしで取込→抽出→スコアまで通す。
const fakeAi: AiRunner = {
	run: async () => ({ response: { annualSalary: "700万〜900万" } }),
};

// ---------------------------------------------------------------------------
// 入力バリデーション（決定的・純関数）
// ---------------------------------------------------------------------------

describe("validateJobUrl", () => {
	it("空・空白は empty", () => {
		expect(validateJobUrl("")).toEqual({ ok: false, reason: "empty" });
		expect(validateJobUrl("  \n ")).toEqual({ ok: false, reason: "empty" });
	});
	it("非 http(s) は invalid（SSRF/誤投入の保護）", () => {
		expect(validateJobUrl("ftp://example.com/job").ok).toBe(false);
		expect(validateJobUrl("javascript:alert(1)").ok).toBe(false);
		expect(validateJobUrl("not a url").ok).toBe(false);
	});
	it("有効な http(s) URL を受理する", () => {
		expect(validateJobUrl("https://example.com/jobs/1")).toEqual({
			ok: true,
			url: "https://example.com/jobs/1",
		});
	});
});

describe("validatePastedHtml", () => {
	it("空は empty、上限超過は too-large", () => {
		expect(validatePastedHtml("").ok).toBe(false);
		const huge = "a".repeat(2 * 1024 * 1024 + 1);
		expect(validatePastedHtml(huge)).toEqual({
			ok: false,
			reason: "too-large",
		});
	});
	it("通常の HTML はバイト長つきで受理する", () => {
		const r = validatePastedHtml("<p>本文</p>");
		expect(r.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 投入・詳細・再抽出（D1/R2 を伴う・AI は注入）
// ---------------------------------------------------------------------------

// 全キー unknown の最小求人を作り、必要キーだけ実値で上書きする。
function jobWith(
	over: Partial<Record<string, NormalizedFieldValue>>,
): NormalizedJob {
	const base = Object.fromEntries(
		NORMALIZED_KEYS.map((k) => [k, { kind: "unknown" } as const]),
	) as NormalizedJob;
	return { ...base, ...over } as NormalizedJob;
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM scores").run();
	await env.DB.prepare("DELETE FROM extractions").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
	// reputation_snapshots は companies の子、jobs は companies を参照するため companies より先に消す。
	await env.DB.prepare("DELETE FROM reputation_snapshots").run();
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM companies").run();
});

describe("ingestFromUrl", () => {
	it("詳細 URL は取込し jobId と status を返す", async () => {
		const fetcher: Fetcher = async () =>
			new Response("<p>年収 700万〜900万</p>", { status: 200 });
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
		);
		expect(result.kind).toBe("detail");
		if (result.kind !== "detail") return;
		expect(typeof result.jobId).toBe("string");
		expect(result.status).toBe("ok");
	});

	it("一覧 URL は detailUrls をキュー投入し count を返す（同期取込しない）", async () => {
		const sent: DetailJobMessage[] = [];
		const queue: DetailQueue = {
			sendBatch: async (messages) => {
				for (const m of messages) sent.push(m.body);
			},
		};
		const fetcher: Fetcher = async () =>
			new Response(
				'<a href="/jobs/1">A</a><a href="/jobs/2">B</a><a href="/jobs/3">C</a>',
				{ status: 200 },
			);
		const result = await ingestFromUrl(
			{ ai: fakeAi, fetcher, db: env.DB, bucket: env.RAW_HTML, queue },
			"https://example.com/jobs",
		);
		expect(result).toEqual({ kind: "list", count: 3 });
		expect(sent.length).toBe(3);
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{
			n: number;
		}>();
		expect(n?.n).toBe(0);
	});

	it("HTTP エラーは fetch-error(http) を返す", async () => {
		const fetcher: Fetcher = async () =>
			new Response("not found", { status: 404 });
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/404",
		);
		expect(result).toEqual({ kind: "fetch-error", reason: "http" });
	});
});

// 認証下ページの取得を投入フローへ配線する（Cookie 入力導線・#187）。
// cookie 非空時のみ fetchAuthedHtml 経路へ分岐し、AuthFetchError を auth-error へ写す。
describe("ingestFromUrl（認証下取得・Cookie 配線・#187）", () => {
	it("cookie 指定時は fetchAuthedHtml 経路で Cookie ヘッダを送出し取込する", async () => {
		let sentCookie: string | undefined;
		const fetcher: Fetcher = async (_url, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			sentCookie = headers?.cookie;
			return new Response("<p>年収 700万〜900万</p>", { status: 200 });
		};
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
			{ cookie: "session=abc123" },
		);
		expect(result.kind).toBe("detail");
		expect(sentCookie).toBe("session=abc123");
	});

	it("401 は auth-error(auth) を返す", async () => {
		const fetcher: Fetcher = async () => new Response("no", { status: 401 });
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
			{ cookie: "session=abc123" },
		);
		expect(result).toEqual({ kind: "auth-error", reason: "auth" });
	});

	it("クロスオリジン redirect は auth-error(redirect) を返す（Cookie 再送しない）", async () => {
		const fetcher: Fetcher = async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://evil.example.net/login" },
			});
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
			{ cookie: "session=abc123" },
		);
		expect(result).toEqual({ kind: "auth-error", reason: "redirect" });
	});

	it("構文不正な Cookie は auth-error(invalid-credential) を返す（fetch 前に弾く）", async () => {
		let fetched = false;
		const fetcher: Fetcher = async () => {
			fetched = true;
			return new Response("ok", { status: 200 });
		};
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
			{ cookie: "bad\x00cookie" },
		);
		expect(result).toEqual({
			kind: "auth-error",
			reason: "invalid-credential",
		});
		expect(fetched).toBe(false);
	});

	it("cookie 空文字は fetchHtml 経路を維持する（後方互換）", async () => {
		// 空 Cookie は認証下取得へ切り替えない。401 は auth-error でなく通常の fetch-error になる。
		const fetcher: Fetcher = async () => new Response("no", { status: 401 });
		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
			},
			"https://example.com/jobs/1",
			{ cookie: "" },
		);
		expect(result).toEqual({ kind: "fetch-error", reason: "http" });
	});
});

// 未描画 SPA シェル（isLikelySpa が true と判定する最小形）。
const SPA_SHELL = `<!doctype html><html><head>
<script type="module" src="/assets/index.js"></script>
</head><body><div id="root"></div></body></html>`;

// 認証下 SPA を BR 経由で取込する（#189）。browser + renderLaunch 注入で実ブラウザなしに検証する。
describe("ingestFromUrl（認証下 SPA・BR への Cookie 適用・#189）", () => {
	it("cookie 付き詳細 SPA は BR 経由で取込し、url 限定で setCookie する", async () => {
		const fetcher: Fetcher = async () =>
			new Response(SPA_SHELL, { status: 200 });
		let setCookieArgs: unknown[] | undefined;
		const page: RenderedPage = {
			setCookie: async (...cookies) => {
				setCookieArgs = cookies;
			},
			goto: async () => {},
			content: async () => "<p>年収 700万〜900万</p>",
		};
		const browser: RenderBrowser = {
			newPage: async () => page,
			close: async () => {},
		};
		const renderLaunch: BrowserLauncher = async () => browser;

		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
				browser: {},
				renderLaunch,
			},
			"https://example.com/jobs/1",
			{ cookie: "session=abc123" },
		);

		expect(result.kind).toBe("detail");
		expect(setCookieArgs).toEqual([
			{ name: "session", value: "abc123", url: "https://example.com/jobs/1" },
		]);
	});

	it("BR 失敗（RenderHtmlError）は fetch-error にマップする", async () => {
		const fetcher: Fetcher = async () =>
			new Response(SPA_SHELL, { status: 200 });
		const page: RenderedPage = {
			setCookie: async () => {},
			goto: async () => {
				throw new Error("net::ERR_NAME_NOT_RESOLVED");
			},
			content: async () => "unused",
		};
		const browser: RenderBrowser = {
			newPage: async () => page,
			close: async () => {},
		};
		const renderLaunch: BrowserLauncher = async () => browser;

		const result = await ingestFromUrl(
			{
				ai: fakeAi,
				fetcher,
				db: env.DB,
				bucket: env.RAW_HTML,
				queue: noopQueue,
				browser: {},
				renderLaunch,
			},
			"https://example.com/jobs/1",
		);

		expect(result).toEqual({ kind: "fetch-error", reason: "network" });
	});
});

describe("ingestFromHtml", () => {
	it("貼り付け HTML を取込し jobId と status を返す", async () => {
		const result = await ingestFromHtml(
			{ ai: fakeAi, db: env.DB, bucket: env.RAW_HTML },
			"<p>年収 700万〜900万</p>",
		);
		expect(typeof result.jobId).toBe("string");
		expect(result.status).toBe("ok");
		// 抽出 1 件のみ（抽出は 1 回・§5.3）。
		const ext = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions WHERE job_id = ?",
		)
			.bind(result.jobId)
			.first<{ n: number }>();
		expect(ext?.n).toBe(1);
	});
});

describe("readJobDetail", () => {
	async function seed(jobId: string, job: NormalizedJob): Promise<void> {
		await env.DB.prepare(
			"INSERT INTO jobs (id, source_url, source_type, status, fetched_at) VALUES (?, ?, 'detail', 'scored', 100)",
		)
			.bind(jobId, `https://example.com/${jobId}`)
			.run();
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES (?, ?, ?, 'm', 'json-mode', 'ok', 1000)`,
		)
			.bind(`ext-${jobId}`, jobId, JSON.stringify(job))
			.run();
		// 総合スコア＋年収サブスコアを書く。
		await env.DB.prepare(
			`INSERT INTO scores (job_id, criterion, sub_score, included, weight) VALUES (?, ?, 0.8, 1, 5)`,
		)
			.bind(jobId, "annualSalary")
			.run();
		await env.DB.prepare(
			`INSERT INTO scores (job_id, criterion, sub_score, included, weight) VALUES (?, ?, 0.8, 1, NULL)`,
		)
			.bind(jobId, TOTAL_SCORE_CRITERION)
			.run();
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES ('annualSalary', ?, 5, 'required')`,
		)
			.bind(JSON.stringify({ desired: 700, floor: 300 }))
			.run();
	}

	// 企業を作成し、求人へ紐付け、取得元別の評判スナップショットを積む（評判合流テスト用）。
	async function seedReputation(
		jobId: string,
		companyId: string,
		snaps: ReadonlyArray<{
			source: string;
			overall: number | null;
			count: number | null;
		}>,
	): Promise<void> {
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.companies} (id, name, company_key, houjin_bangou, created_at, updated_at) VALUES (?, '会社', 'kaisha', NULL, 0, 0)`,
		)
			.bind(companyId)
			.run();
		await env.DB.prepare("UPDATE jobs SET company_id = ? WHERE id = ?")
			.bind(companyId, jobId)
			.run();
		let n = 0;
		for (const s of snaps) {
			await env.DB.prepare(
				`INSERT INTO ${TABLE_NAMES.reputationSnapshots} (id, company_id, source, overall_score, review_count, sub_scores_json, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
				.bind(
					`snap-${jobId}-${n}`,
					companyId,
					s.source,
					s.overall,
					s.count,
					n,
					n,
				)
				.run();
			n += 1;
		}
	}

	it("未存在の job は null", async () => {
		expect(await readJobDetail(env.DB, "nope", true)).toBeNull();
	});

	it("企業未紐付けは評判中立（score=null・confidence=none・sources 空）", async () => {
		await seed("jr0", jobWith({}));
		const detail = await readJobDetail(env.DB, "jr0", true);
		expect(detail?.reputation).toEqual({
			score: null,
			weight: DEFAULT_REPUTATION_WEIGHT_CONFIG.weight,
			confidence: "none",
			sources: [],
		});
	});

	it("APIキー設定済み・評判ありは company 軸寄与（score/confidence/出所）を返す", async () => {
		await seed("jr1", jobWith({}));
		await seedReputation("jr1", "co-1", [
			{ source: "openwork", overall: 3.5, count: 500 },
		]);
		const detail = await readJobDetail(env.DB, "jr1", true);
		expect(detail?.reputation.score).toBeCloseTo(
			(10 * 0.5 + 500 * 0.7) / (10 + 500),
			10,
		);
		expect(detail?.reputation.confidence).toBe("ok");
		expect(detail?.reputation.sources).toEqual([
			{ source: "openwork", overallScore: 3.5, reviewCount: 500 },
		]);
	});

	it("APIキー未設定は評判を中立除外（snapshots があっても score=null・sources 空）", async () => {
		await seed("jr2", jobWith({}));
		await seedReputation("jr2", "co-2", [
			{ source: "openwork", overall: 4.8, count: 1000 },
		]);
		const detail = await readJobDetail(env.DB, "jr2", false);
		expect(detail?.reputation.score).toBeNull();
		expect(detail?.reputation.confidence).toBe("none");
		expect(detail?.reputation.sources).toEqual([]);
	});

	it("jobs メタ・抽出・total・フラット内訳を返す", async () => {
		await seed(
			"j1",
			jobWith({
				annualSalary: {
					kind: "numericRange",
					min: 800,
					max: 800,
					raw: "800万",
				},
			}),
		);
		const detail = await readJobDetail(env.DB, "j1", true);
		expect(detail).not.toBeNull();
		if (detail === null) return;
		expect(detail.job).toMatchObject({
			jobId: "j1",
			sourceType: "detail",
			status: "scored",
		});
		expect(detail.extraction.status).toBe("ok");
		expect(detail.total).toBeCloseTo(0.8, 5);
		// 内訳は全正規キーぶん・決定的順序。
		expect(detail.breakdown.length).toBe(NORMALIZED_KEYS.length);
		const salary = detail.breakdown.find((b) => b.key === "annualSalary");
		expect(salary).toMatchObject({
			kind: "numericRange",
			weight: 5,
			score: 0.8,
			included: true,
			raw: "800万",
			hardFilter: "required",
		});
		expect(salary?.desired).toEqual({ desired: 700, floor: 300 });
		// 抽出値が無いキーは情報なし（中立・分母除外）。
		const bonus = detail.breakdown.find((b) => b.key === "bonus");
		expect(bonus).toMatchObject({ included: false, score: null, raw: "" });
	});
});

describe("reextractJob", () => {
	it("未存在の job は null", async () => {
		expect(
			await reextractJob(
				{ ai: fakeAi, db: env.DB, bucket: env.RAW_HTML },
				"nope",
			),
		).toBeNull();
	});

	it("保存済み生 HTML から AI 抽出を再実行し同一 job へ取込し直す", async () => {
		// まず投入して生 HTML を R2 に保存する。
		const { jobId } = await ingestFromHtml(
			{ ai: fakeAi, db: env.DB, bucket: env.RAW_HTML },
			"<p>年収 700万〜900万</p>",
		);
		const result = await reextractJob(
			{ ai: fakeAi, db: env.DB, bucket: env.RAW_HTML },
			jobId,
		);
		expect(result).toEqual({ status: "ok" });
		// 再抽出は新 job を作らず、同一 job に抽出を 1 件追加する（計 2 件）。
		const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{
			n: number;
		}>();
		expect(jobs?.n).toBe(1);
		const ext = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions WHERE job_id = ?",
		)
			.bind(jobId)
			.first<{ n: number }>();
		expect(ext?.n).toBe(2);
	});
});
