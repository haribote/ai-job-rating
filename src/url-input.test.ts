import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import app from "./app";
import type { Fetcher } from "./fetch-html";
import { fetchAndRender, validateJobUrl } from "./url-input";

// URL バリデーション（決定的）: 空・不正・非 http(s) を弾き、公開詳細 URL のみ後続へ渡す。
describe("validateJobUrl", () => {
	// 空入力は取得経路の前提を満たさないので拒否する
	it("空文字は無効", () => {
		expect(validateJobUrl("")).toEqual({ ok: false, reason: "empty" });
	});

	// 空白のみは実質空入力とみなす
	it("空白のみは無効", () => {
		expect(validateJobUrl("   \n\t ")).toEqual({ ok: false, reason: "empty" });
	});

	// http(s) 以外のスキームは取得層が扱わない（SSRF/誤投入の保護）
	it("非 http(s) スキームは無効", () => {
		expect(validateJobUrl("ftp://example.com/job").ok).toBe(false);
		expect(validateJobUrl("javascript:alert(1)").ok).toBe(false);
	});

	// パースできない文字列（相対パス等）は無効
	it("URL として解釈できない入力は無効", () => {
		expect(validateJobUrl("not a url").ok).toBe(false);
	});

	// 正常系: http / https の URL を受理してそのまま後続へ渡す
	it("有効な http(s) URL は受理する", () => {
		expect(validateJobUrl("https://example.com/jobs/1")).toEqual({
			ok: true,
			url: "https://example.com/jobs/1",
		});
		expect(validateJobUrl("http://example.com/jobs/1").ok).toBe(true);
	});
});

// 取得 → パイプライン or 取得失敗のエラーページ。fetcher / AI を注入して実ネットワーク・実推論なしで検証する。
describe("fetchAndRender", () => {
	const fakeAi: AiRunner = {
		run: async () => ({ response: { annualSalary: "700万〜900万" } }),
	};

	// 永続化先（D1/R2）を毎回まっさらにして取込結果の検証を決定的にする。
	beforeEach(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		await env.DB.prepare("DELETE FROM jobs").run();
		await env.DB.prepare("DELETE FROM criteria_config").run();
	});

	// 正常系: 取得した HTML を最小経路に通し 200 と結果ページを返す
	it("取得成功時はスコア結果ページを 200 で返す", async () => {
		const fetcher: Fetcher = async () =>
			new Response("<p>年収 700万〜900万</p>", { status: 200 });

		const result = await fetchAndRender(
			{ ai: fakeAi, fetcher, db: env.DB, bucket: env.RAW_HTML },
			"https://example.com/jobs/1",
		);

		expect(result.status).toBe(200);
		expect(result.html).toContain("スコア結果");
	});

	// #26: 取得成功は表示だけでなく jobs/extractions を永続化する（DoD 一気通貫）。
	it("取得成功時に jobs/extractions を永続化する", async () => {
		const url = "https://example.com/jobs/persist";
		const fetcher: Fetcher = async () =>
			new Response("<p>年収 700万〜900万</p>", { status: 200 });

		await fetchAndRender(
			{ ai: fakeAi, fetcher, db: env.DB, bucket: env.RAW_HTML },
			url,
		);

		const job = await env.DB.prepare(
			"SELECT id, source_type, status FROM jobs WHERE source_url = ?",
		)
			.bind(url)
			.first<{ id: string; source_type: string; status: string }>();
		expect(job?.source_type).toBe("detail");
		expect(job?.status).toBe("scored");
		const ext = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extractions WHERE job_id = ?",
		)
			.bind(job?.id)
			.first<{ n: number }>();
		expect(ext?.n).toBe(1);
	});

	// 取得失敗（非 2xx）は 502 と貼付フォールバック誘導のエラーページ（落とさない）
	it("HTTP エラー時は 502 と /paste 誘導のエラーページを返す", async () => {
		const fetcher: Fetcher = async () =>
			new Response("not found", { status: 404 });

		const result = await fetchAndRender(
			{ ai: fakeAi, fetcher, db: env.DB, bucket: env.RAW_HTML },
			"https://example.com/jobs/404",
		);

		expect(result.status).toBe(502);
		expect(result.html).toContain('href="/paste"');
		expect(result.html).toContain("404");
	});

	// ネットワーク失敗も 502 と誘導ページ（abort 由来でないため network 種別）
	it("ネットワーク失敗時は 502 と誘導ページを返す", async () => {
		const fetcher: Fetcher = async () => {
			throw new Error("boom");
		};

		const result = await fetchAndRender(
			{ ai: fakeAi, fetcher, db: env.DB, bucket: env.RAW_HTML },
			"https://example.com/jobs/1",
		);

		expect(result.status).toBe(502);
		expect(result.html).toContain('href="/paste"');
	});

	// タイムアウトも 502 と誘導ページ（abort 由来＝timeout 種別）
	it("タイムアウト時は 502 と誘導ページを返す", async () => {
		// signal の abort を待って reject する fetcher。timeoutMs 経過で controller が abort する。
		const fetcher: Fetcher = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});

		const result = await fetchAndRender(
			{ ai: fakeAi, fetcher, timeoutMs: 5, db: env.DB, bucket: env.RAW_HTML },
			"https://example.com/jobs/slow",
		);

		expect(result.status).toBe(502);
		expect(result.html).toContain('href="/paste"');
	});
});

// 入力受け口のルート。app.request() で HTTP 契約を検証する（取得を伴わない経路のみ）。
describe("url-input routes", () => {
	// URL 入力フォームを SSR で提供し、フォールスルー前に評価される
	it("GET /fetch はフォームを返す", async () => {
		const res = await app.request("/fetch", {}, env);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<form");
		expect(body).toContain('name="url"');
	});

	// 空入力は AI/取得を呼ぶ前に 400 で拒否する
	it("POST /fetch は空 URL を 400 で拒否する", async () => {
		const form = new URLSearchParams({ url: "" });
		const res = await app.request(
			"/fetch",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			env,
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			ok: false,
			reason: "empty",
		});
	});

	// 非 http(s) は 400 で拒否する
	it("POST /fetch は非 http(s) URL を 400 で拒否する", async () => {
		const form = new URLSearchParams({ url: "ftp://example.com/job" });
		const res = await app.request(
			"/fetch",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			env,
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ ok: false });
	});
});
