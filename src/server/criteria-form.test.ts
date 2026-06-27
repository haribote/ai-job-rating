import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import {
	formToConfigRows,
	parseWeight,
	preferredToList,
} from "./criteria-form";
import { TABLE_NAMES, TOTAL_SCORE_CRITERION } from "./db-schema";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "./job-schema";

// ---------------------------------------------------------------------------
// 決定的ヘルパ（フォーム値 → criteria_config 行）の単体テスト
// ---------------------------------------------------------------------------

describe("parseWeight（重みの決定的バリデーション）", () => {
	it("非負の数値を受理する", () => {
		expect(parseWeight("0")).toEqual({ ok: true, value: 0 });
		expect(parseWeight("3.5")).toEqual({ ok: true, value: 3.5 });
	});

	it("負・非数・空は拒否する（weight>=0 ガードレール §5.2）", () => {
		expect(parseWeight("-1").ok).toBe(false);
		expect(parseWeight("abc").ok).toBe(false);
		expect(parseWeight("").ok).toBe(false);
	});
});

describe("preferredToList（categorical 希望集合のパース）", () => {
	it("カンマ区切りを trim して配列化する", () => {
		expect(preferredToList(" full , partial ")).toEqual(["full", "partial"]);
	});

	it("空文字は空配列（希望なし）", () => {
		expect(preferredToList("")).toEqual([]);
		expect(preferredToList("  ")).toEqual([]);
	});
});

describe("formToConfigRows（フォーム → criteria_config 行）", () => {
	// numericRange は higherBetter で floor、lowerBetter で ceil を desired_value へ詰める。
	it("numericRange(higherBetter) は desired/floor を JSON 化する", () => {
		const result = formToConfigRows({
			weight__annualSalary: "5",
			hardFilter__annualSalary: "none",
			desired__annualSalary: "700",
			floor__annualSalary: "300",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const row = result.rows.find((r) => r.criterion === "annualSalary");
		expect(row).toMatchObject({
			criterion: "annualSalary",
			weight: 5,
			hard_filter: "none",
		});
		expect(JSON.parse(row?.desired_value ?? "null")).toEqual({
			desired: 700,
			floor: 300,
		});
	});

	it("numericRange(lowerBetter) は desired/ceil を JSON 化する", () => {
		const result = formToConfigRows({
			weight__overtime: "2",
			hardFilter__overtime: "none",
			desired__overtime: "10",
			ceil__overtime: "45",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const row = result.rows.find((r) => r.criterion === "overtime");
		expect(JSON.parse(row?.desired_value ?? "null")).toEqual({
			desired: 10,
			ceil: 45,
		});
	});

	it("categorical は preferred 集合を JSON 化する", () => {
		const result = formToConfigRows({
			weight__remoteWork: "3",
			hardFilter__remoteWork: "required",
			preferred__remoteWork: "full, partial",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const row = result.rows.find((r) => r.criterion === "remoteWork");
		expect(row?.hard_filter).toBe("required");
		expect(JSON.parse(row?.desired_value ?? "null")).toEqual({
			preferred: ["full", "partial"],
		});
	});

	it("aiJudged は desired_value を持たない（突合は抽出側 #68）", () => {
		const result = formToConfigRows({
			weight__requiredSkillsMatch: "4",
			hardFilter__requiredSkillsMatch: "none",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const row = result.rows.find((r) => r.criterion === "requiredSkillsMatch");
		expect(row?.desired_value).toBeNull();
	});

	it("numericRange で希望値未入力なら desired_value は null（中立・評価不能）", () => {
		const result = formToConfigRows({
			weight__annualSalary: "5",
			hardFilter__annualSalary: "none",
			desired__annualSalary: "",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const row = result.rows.find((r) => r.criterion === "annualSalary");
		expect(row?.desired_value).toBeNull();
	});

	it("負の重みは拒否する（weight>=0）", () => {
		const result = formToConfigRows({
			weight__annualSalary: "-1",
			hardFilter__annualSalary: "none",
		});
		expect(result.ok).toBe(false);
	});

	it("不正な hard_filter は拒否する（集合外）", () => {
		const result = formToConfigRows({
			weight__annualSalary: "1",
			hardFilter__annualSalary: "banana",
		});
		expect(result.ok).toBe(false);
	});

	it("送信されなかった正規キーは行を生成しない（部分更新）", () => {
		const result = formToConfigRows({
			weight__annualSalary: "1",
			hardFilter__annualSalary: "none",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.rows).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// ルートの HTTP 契約（app.request() で検証、url-input.test に倣う）
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

async function seed(jobId: string, job: NormalizedJob): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO jobs (id, source_url, source_type, fetched_at) VALUES (?, ?, 'detail', 0)",
	)
		.bind(jobId, `https://example.com/${jobId}`)
		.run();
	await env.DB.prepare(
		`INSERT INTO ${TABLE_NAMES.extractions} (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at) VALUES (?, ?, ?, 'm', 'json-mode', 'ok', 1000)`,
	)
		.bind(`ext-${jobId}`, jobId, JSON.stringify(job))
		.run();
}

async function postConfig(body: Record<string, string>): Promise<Response> {
	const form = new URLSearchParams(body);
	return app.request(
		"/config",
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		},
		env,
	);
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM jobs").run();
	await env.DB.prepare("DELETE FROM criteria_config").run();
});

describe("criteria-form routes", () => {
	it("GET /config は全正規キーの設定フォームを返す", async () => {
		const res = await app.request("/config", {}, env);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<form");
		// 全正規キーの重み・ハードフィルタ入力を持つ
		for (const key of NORMALIZED_KEYS) {
			expect(body).toContain(`name="weight__${key}"`);
			expect(body).toContain(`name="hardFilter__${key}"`);
		}
	});

	it("GET /config は保存済み設定を初期値として埋める", async () => {
		await env.DB.prepare(
			`INSERT INTO ${TABLE_NAMES.criteriaConfig} (criterion, desired_value, weight, hard_filter) VALUES ('annualSalary', ?, 7, 'required')`,
		)
			.bind(JSON.stringify({ desired: 800, floor: 400 }))
			.run();
		const res = await app.request("/config", {}, env);
		const body = await res.text();
		expect(body).toContain('value="7"');
		expect(body).toContain('value="800"');
		expect(body).toContain('value="400"');
	});

	it("POST /config は設定を保存し criteria_config を更新する", async () => {
		const res = await postConfig({
			weight__annualSalary: "5",
			hardFilter__annualSalary: "none",
			desired__annualSalary: "700",
			floor__annualSalary: "300",
		});
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			`SELECT weight, desired_value FROM ${TABLE_NAMES.criteriaConfig} WHERE criterion = 'annualSalary'`,
		).first<{ weight: number; desired_value: string }>();
		expect(row?.weight).toBe(5);
		expect(JSON.parse(row?.desired_value ?? "null")).toEqual({
			desired: 700,
			floor: 300,
		});
	});

	it("POST /config は保存後に rescoreAll を呼んで即再ランキングする（AI 非実行）", async () => {
		// 求人を 2 件投入。保存前は scores が無い。
		await seed(
			"j1",
			jobWith({ annualSalary: { kind: "numericRange", min: 800, max: 800 } }),
		);
		await seed(
			"j2",
			jobWith({ annualSalary: { kind: "numericRange", min: 400, max: 400 } }),
		);
		const res = await postConfig({
			weight__annualSalary: "5",
			hardFilter__annualSalary: "none",
			desired__annualSalary: "700",
			floor__annualSalary: "300",
		});
		expect(res.status).toBe(200);
		// 両求人の総合スコア行が書き込まれている（再スコアリングが発火した証拠）。
		const total1 = await env.DB.prepare(
			`SELECT sub_score FROM ${TABLE_NAMES.scores} WHERE job_id = 'j1' AND criterion = ?`,
		)
			.bind(TOTAL_SCORE_CRITERION)
			.first<{ sub_score: number | null }>();
		const total2 = await env.DB.prepare(
			`SELECT sub_score FROM ${TABLE_NAMES.scores} WHERE job_id = 'j2' AND criterion = ?`,
		)
			.bind(TOTAL_SCORE_CRITERION)
			.first<{ sub_score: number | null }>();
		// desired=700/floor=300。年収800 は 1.0、年収400 は (400-300)/(700-300)=0.25。
		expect(total1?.sub_score).toBe(1);
		expect(total2?.sub_score).toBeCloseTo(0.25, 5);
	});

	it("POST /config は負の重みを 400 で拒否する（AI/再スコアの前に弾く）", async () => {
		const res = await postConfig({
			weight__annualSalary: "-1",
			hardFilter__annualSalary: "none",
		});
		expect(res.status).toBe(400);
		// 不正入力では criteria_config を変更しない。
		const count = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${TABLE_NAMES.criteriaConfig}`,
		).first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});
