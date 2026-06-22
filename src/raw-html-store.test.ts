import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getRawHtml,
	linkRawHtmlToJob,
	putRawHtml,
	RawHtmlStoreError,
	rawHtmlKey,
} from "./raw-html-store";

// 各テストは本番マイグレーションを適用した独立スキーマで走る（jobs.raw_html_r2_key 紐付け検証用）。
// miniflare は r2_buckets の RAW_HTML をテストファイルごとに独立した in-memory R2 として与える。
beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// jobs 行を最小列で投入する（raw_html_r2_key は既定 NULL）。
async function seedJob(id: string, sourceUrl: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(id, sourceUrl)
		.run();
}

describe("rawHtmlKey", () => {
	// キーは job id から決定的に導かれる（衝突しない・追跡可能）。
	it("job id から jobs/{id}/raw.html 形式の決定的キーを生成する", () => {
		expect(rawHtmlKey("job-1")).toBe("jobs/job-1/raw.html");
		// 同一入力なら同一キー（決定的）。
		expect(rawHtmlKey("job-1")).toBe(rawHtmlKey("job-1"));
	});

	// 別 job は別キーへ振り分けられる（衝突しない）。
	it("異なる job id は異なるキーになる", () => {
		expect(rawHtmlKey("a")).not.toBe(rawHtmlKey("b"));
	});

	// 空 id はキー設計を壊すため検証エラーにする（NULL 紐付けと区別する）。
	it("空の job id は RawHtmlStoreError(validation) を投げる", () => {
		expect(() => rawHtmlKey("")).toThrow(RawHtmlStoreError);
		expect(() => rawHtmlKey("   ")).toThrowError(
			expect.objectContaining({ kind: "validation" }),
		);
	});
});

describe("putRawHtml / getRawHtml", () => {
	// put は job id 由来のキーへ HTML を保存し、そのキーを返す（jobs 紐付けの入力になる）。
	it("HTML を保存し決定的キーと R2Object を返す", async () => {
		const html = "<html><body>job detail</body></html>";

		const result = await putRawHtml(env.RAW_HTML, "job-1", html);

		expect(result.key).toBe(rawHtmlKey("job-1"));
		expect(result.size).toBe(new TextEncoder().encode(html).length);
	});

	// 保存した HTML を同じキーで読み戻せる（往復）。
	it("保存した HTML を get で読み戻せる", async () => {
		const html = "<html>round trip</html>";
		const { key } = await putRawHtml(env.RAW_HTML, "job-2", html);

		const loaded = await getRawHtml(env.RAW_HTML, key);

		expect(loaded).toBe(html);
	});

	// 未保存キーは null（取得失敗を例外でなく不在として表す）。
	it("存在しないキーは null を返す", async () => {
		const loaded = await getRawHtml(env.RAW_HTML, "jobs/missing/raw.html");
		expect(loaded).toBeNull();
	});

	// content type を text/html として保存し、後段が誤判定しないようにする。
	it("httpMetadata.contentType を text/html で保存する", async () => {
		const { key } = await putRawHtml(env.RAW_HTML, "job-3", "<html></html>");
		const obj = await env.RAW_HTML.get(key);
		expect(obj?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
	});

	// 取得元 URL を customMetadata に残し、キーから求人を追跡できるようにする。
	it("source URL を customMetadata に保存する", async () => {
		const sourceUrl = "https://example.com/jobs/3";
		const { key } = await putRawHtml(env.RAW_HTML, "job-3", "<html></html>", {
			sourceUrl,
		});
		const obj = await env.RAW_HTML.get(key);
		expect(obj?.customMetadata?.sourceUrl).toBe(sourceUrl);
	});

	// 空 id での put はキー生成段階で検証エラーになる。
	it("空 job id での put は RawHtmlStoreError を投げる", async () => {
		await expect(putRawHtml(env.RAW_HTML, "", "<html></html>")).rejects.toThrow(
			RawHtmlStoreError,
		);
	});
});

describe("linkRawHtmlToJob", () => {
	// put 後にキーを jobs 行へ紐付ける（#16→#17: jobs.raw_html_r2_key 参照）。
	it("保存キーを jobs.raw_html_r2_key に書き込む", async () => {
		await seedJob("job-1", "https://example.com/jobs/1");
		const { key } = await putRawHtml(env.RAW_HTML, "job-1", "<html></html>");

		await linkRawHtmlToJob(env.DB, "job-1", key);

		const row = await env.DB.prepare(
			"SELECT raw_html_r2_key FROM jobs WHERE id = ?",
		)
			.bind("job-1")
			.first<{ raw_html_r2_key: string | null }>();
		expect(row?.raw_html_r2_key).toBe(key);
	});

	// 存在しない job への紐付けは RawHtmlStoreError(not_found) にする（黙って 0 行更新で済ませない）。
	it("存在しない job への紐付けは RawHtmlStoreError(not_found) を投げる", async () => {
		await expect(
			linkRawHtmlToJob(env.DB, "no-such-job", "jobs/x/raw.html"),
		).rejects.toThrowError(expect.objectContaining({ kind: "not_found" }));
	});
});
