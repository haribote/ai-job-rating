import { describe, expect, it } from "vitest";
import {
	buildSmokeHtml,
	decideExitCode,
	formatSmokeReport,
	interpretAiHealth,
	interpretBrowserRender,
	interpretExtraction,
	interpretHealth,
	interpretJobDetail,
	interpretReputation,
	interpretReputationConfig,
	interpretReputationSources,
	parseSmokeArgs,
	SMOKE_MARKER,
	type SmokeCheckResult,
} from "./live-smoke";

// 合成 HTML には人間識別用マーカーが埋まっている（UI/一覧で残置ジョブを見分ける）。
describe("buildSmokeHtml", () => {
	it("マーカーを含む HTML を返す", () => {
		const html = buildSmokeHtml();
		expect(html).toContain(SMOKE_MARKER);
		expect(html.toLowerCase()).toContain("<html");
	});
});

describe("interpretHealth", () => {
	it("200 かつ status=ok は pass", () => {
		expect(interpretHealth(200, { status: "ok" }).outcome).toBe("pass");
	});
	it("非200 は fail", () => {
		expect(interpretHealth(503, { status: "ok" }).outcome).toBe("fail");
	});
	it("形が違えば fail", () => {
		expect(interpretHealth(200, {}).outcome).toBe("fail");
	});
});

describe("interpretAiHealth", () => {
	it("ok=true は pass", () => {
		const r = interpretAiHealth(200, {
			ok: true,
			model: "m",
			reply: "pong",
		});
		expect(r.outcome).toBe("pass");
	});
	it("ok=false は fail（error を detail に含む）", () => {
		const r = interpretAiHealth(503, {
			ok: false,
			model: "m",
			error: "binding not found",
		});
		expect(r.outcome).toBe("fail");
		expect(r.detail).toContain("binding not found");
	});
	it("非オブジェクトは fail", () => {
		expect(interpretAiHealth(200, null).outcome).toBe("fail");
	});
});

describe("interpretExtraction", () => {
	it("201 かつ jobId があれば pass（jobId を detail に含む）", () => {
		const r = interpretExtraction(201, { jobId: "job-1", status: "scored" });
		expect(r.outcome).toBe("pass");
		expect(r.detail).toContain("job-1");
	});
	it("400 は fail", () => {
		expect(interpretExtraction(400, { error: "x" }).outcome).toBe("fail");
	});
	it("jobId 欠落は fail", () => {
		expect(interpretExtraction(201, { status: "scored" }).outcome).toBe("fail");
	});
});

describe("interpretJobDetail", () => {
	it("200 で job.jobId と breakdown があれば pass", () => {
		const r = interpretJobDetail(200, {
			job: { jobId: "job-1" },
			extraction: { status: "ok" },
			total: 0.5,
			breakdown: [{ key: "salary" }],
			reputation: {},
		});
		expect(r.outcome).toBe("pass");
	});
	it("404 は fail", () => {
		expect(interpretJobDetail(404, { error: "job not found" }).outcome).toBe(
			"fail",
		);
	});
	it("breakdown が配列でなければ fail", () => {
		expect(
			interpretJobDetail(200, { job: { jobId: "job-1" }, breakdown: null })
				.outcome,
		).toBe("fail");
	});
});

describe("interpretReputationConfig", () => {
	it("200 かつ apiKeyConfigured=true は pass", () => {
		const r = interpretReputationConfig(200, { apiKeyConfigured: true });
		expect(r.outcome).toBe("pass");
		expect(r.detail).toContain("true");
	});
	it("200 かつ apiKeyConfigured=false でも pass（binding 到達は成立）", () => {
		expect(
			interpretReputationConfig(200, { apiKeyConfigured: false }).outcome,
		).toBe("pass");
	});
	it("非boolean は fail", () => {
		expect(interpretReputationConfig(200, {}).outcome).toBe("fail");
	});
});

describe("interpretReputationSources", () => {
	it("200 かつ sources 配列は pass（reputation D1 到達）", () => {
		expect(interpretReputationSources(200, { sources: [] }).outcome).toBe(
			"pass",
		);
	});
	it("500 は fail", () => {
		expect(interpretReputationSources(500, {}).outcome).toBe("fail");
	});
});

describe("interpretReputation", () => {
	it("status=ok は pass（snapshots 件数を detail に含む）", () => {
		const r = interpretReputation(200, {
			status: "ok",
			companyId: "c-1",
			snapshots: [{ source: "s" }],
		});
		expect(r.outcome).toBe("pass");
	});
	it("status=skipped は skip（キー未設定など）", () => {
		const r = interpretReputation(200, {
			status: "skipped",
			reason: "api-key-not-configured",
		});
		expect(r.outcome).toBe("skip");
		expect(r.detail).toContain("api-key-not-configured");
	});
	it("404 は fail（company-id 誤り）", () => {
		expect(
			interpretReputation(404, { error: "company not found" }).outcome,
		).toBe("fail");
	});
});

describe("interpretBrowserRender", () => {
	it("2xx は pass（dynamic import バンドル成立）", () => {
		expect(
			interpretBrowserRender(201, { jobId: "job-2", status: "scored" }).outcome,
		).toBe("pass");
	});
	it("非2xx は fail（No such module か上流失敗）", () => {
		const r = interpretBrowserRender(500, { error: "No such module" });
		expect(r.outcome).toBe("fail");
		expect(r.detail).toContain("No such module");
	});
});

describe("decideExitCode", () => {
	const mk = (outcome: SmokeCheckResult["outcome"]): SmokeCheckResult => ({
		id: "x",
		label: "X",
		outcome,
		detail: "",
	});
	it("fail が1つでもあれば 1", () => {
		expect(decideExitCode([mk("pass"), mk("fail"), mk("skip")])).toBe(1);
	});
	it("pass と skip のみなら 0", () => {
		expect(decideExitCode([mk("pass"), mk("skip")])).toBe(0);
	});
	it("空配列は 0", () => {
		expect(decideExitCode([])).toBe(0);
	});
});

describe("parseSmokeArgs", () => {
	it("--base-url を必須として取り出し末尾スラッシュを落とす", () => {
		const a = parseSmokeArgs(["--base-url", "https://example.com/"]);
		expect(a.baseUrl).toBe("https://example.com");
		expect(a.errors).toHaveLength(0);
	});
	it("--base-url 欠落は errors に記録", () => {
		const a = parseSmokeArgs([]);
		expect(a.baseUrl).toBeNull();
		expect(a.errors.length).toBeGreaterThan(0);
	});
	it("--spa-url / --company-id / --core-only を取り出す", () => {
		const a = parseSmokeArgs([
			"--base-url",
			"https://e.com",
			"--spa-url",
			"https://spa.example/job/1",
			"--company-id",
			"c-9",
			"--core-only",
		]);
		expect(a.spaUrl).toBe("https://spa.example/job/1");
		expect(a.companyId).toBe("c-9");
		expect(a.coreOnly).toBe(true);
	});
	it("--timeout-ms を数値として取り出し、不正値は errors", () => {
		expect(
			parseSmokeArgs(["--base-url", "https://e.com", "--timeout-ms", "5000"])
				.timeoutMs,
		).toBe(5000);
		expect(
			parseSmokeArgs(["--base-url", "https://e.com", "--timeout-ms", "abc"])
				.errors.length,
		).toBeGreaterThan(0);
	});
	it("未知のオプションは errors に記録", () => {
		const a = parseSmokeArgs(["--base-url", "https://e.com", "--nope"]);
		expect(a.errors.length).toBeGreaterThan(0);
	});
});

describe("formatSmokeReport", () => {
	it("各行に PASS/FAIL/SKIP とラベルを出す", () => {
		const out = formatSmokeReport([
			{ id: "health", label: "health", outcome: "pass", detail: "ok" },
			{ id: "rep", label: "Claude 評判", outcome: "skip", detail: "no id" },
		]);
		expect(out).toContain("PASS");
		expect(out).toContain("SKIP");
		expect(out).toContain("Claude 評判");
	});
});
