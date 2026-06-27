import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { AiRunner } from "./extract/ai";
import { ingestPaste, MAX_HTML_BYTES, validatePastedHtml } from "./paste-input";

// 貼り付け入力の検証ロジック。決定的なので分岐を網羅してユニットテストで担保する
describe("validatePastedHtml", () => {
	// 空入力はフォールバック経路の前提を満たさないので拒否する
	it("空文字は無効", () => {
		expect(validatePastedHtml("")).toEqual({ ok: false, reason: "empty" });
	});

	// 空白のみは実質空入力とみなす
	it("空白のみは無効", () => {
		expect(validatePastedHtml("   \n\t ")).toEqual({
			ok: false,
			reason: "empty",
		});
	});

	// 上限超過は後続処理の負荷・コスト保護のため拒否する
	it("サイズ上限超過は無効", () => {
		const tooLarge = "a".repeat(MAX_HTML_BYTES + 1);
		expect(validatePastedHtml(tooLarge)).toEqual({
			ok: false,
			reason: "too-large",
		});
	});

	// 正常系: 受け取った HTML をそのまま後続へ渡せる形で返す（トリミングしない）
	it("有効な HTML はそのまま html として返し、バイト長を同梱する", () => {
		const html = "<html><body>求人</body></html>";
		expect(validatePastedHtml(html)).toEqual({
			ok: true,
			html,
			bytes: new TextEncoder().encode(html).length,
		});
	});

	// マルチバイトを含めバイト長で判定する（文字数ではない）
	it("バイト長で上限判定する", () => {
		// 日本語1文字 = UTF-8 で3バイト。上限ちょうどは有効
		const justUnder = "あ".repeat(Math.floor(MAX_HTML_BYTES / 3));
		expect(validatePastedHtml(justUnder).ok).toBe(true);
	});
});

// 入力受け口のルート。app.request() で HTTP 契約を検証する
describe("paste-input routes", () => {
	// 貼り付けフォームを SSR で提供し、フォールスルー前に評価される
	it("GET /paste はフォームを返す", async () => {
		const res = await app.request("/paste", {}, env);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<form");
		expect(body).toContain('name="html"');
	});

	// 正常系: 受け取った HTML のバイト長を返し、受け口が機能していることを確認する
	it("POST /paste は有効な HTML を受理する", async () => {
		const html = "<html><body>求人詳細</body></html>";
		const form = new URLSearchParams({ html });
		const res = await app.request(
			"/paste",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			env,
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			ok: true,
			bytes: new TextEncoder().encode(html).length,
		});
	});

	// 空入力は 400 で拒否する
	it("POST /paste は空入力を 400 で拒否する", async () => {
		const form = new URLSearchParams({ html: "" });
		const res = await app.request(
			"/paste",
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

	// 上限超過は 413 で拒否する
	it("POST /paste は上限超過を 413 で拒否する", async () => {
		const form = new URLSearchParams({ html: "a".repeat(MAX_HTML_BYTES + 1) });
		const res = await app.request(
			"/paste",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
			env,
		);
		expect(res.status).toBe(413);
		await expect(res.json()).resolves.toMatchObject({
			ok: false,
			reason: "too-large",
		});
	});
});

// 貼付 HTML の取込（#26）。AI を注入し、永続化＋結果ページ描画を実 D1/R2 で検証する。
describe("ingestPaste（貼付経路の取込→永続化）", () => {
	const fakeAi: AiRunner = {
		run: async () => ({ response: { annualSalary: "700万〜900万" } }),
	};

	beforeEach(async () => {
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		await env.DB.prepare("DELETE FROM jobs").run();
		await env.DB.prepare("DELETE FROM criteria_config").run();
	});

	it("貼付 HTML を永続化し結果ページを返す", async () => {
		const html = await ingestPaste(
			{ ai: fakeAi, db: env.DB, bucket: env.RAW_HTML },
			"<html><body>年収 700万〜900万</body></html>",
		);

		expect(html).toContain("スコア結果");
		const job = await env.DB.prepare(
			"SELECT source_type, status FROM jobs",
		).first<{ source_type: string; status: string }>();
		expect(job?.source_type).toBe("paste");
		expect(job?.status).toBe("scored");
	});

	// #26: 抽出失敗時はスコア結果でなく抽出失敗の導線を返す。
	it("抽出失敗時は抽出失敗ページを返す", async () => {
		const failingAi: AiRunner = {
			run: async () => {
				throw { status: 400 };
			},
		};
		const html = await ingestPaste(
			{ ai: failingAi, db: env.DB, bucket: env.RAW_HTML },
			"<html><body>本文</body></html>",
		);

		expect(html).toContain("抽出に失敗しました");
		expect(html).not.toContain("スコア結果");
	});
});
