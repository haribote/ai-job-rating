import { describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import {
	buildExtractionJsonSchema,
	buildExtractionMessages,
	EXTRACTION_MODEL,
	extractJob,
	rawFieldsToNormalizedJob,
} from "./extract";
import { isUnknown, NORMALIZED_KEYS } from "./job-schema";

// プロンプト組立（決定的）: trim 済み本文を含む messages を組み立てる。
describe("buildExtractionMessages", () => {
	it("system と user の 2 メッセージを返し、user に本文を含める", () => {
		const messages = buildExtractionMessages("年収: 700万〜900万");
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("system");
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toContain("年収: 700万〜900万");
	});

	it("同一入力は常に同一 messages（決定的）", () => {
		const a = buildExtractionMessages("本文");
		const b = buildExtractionMessages("本文");
		expect(a).toEqual(b);
	});
});

// JSON Schema 定義（決定的）: 全正規キーを property に持つ object schema を返す。
describe("buildExtractionJsonSchema", () => {
	it("全正規キーを properties に持つ object schema を返す", () => {
		const schema = buildExtractionJsonSchema();
		expect(schema.type).toBe("object");
		for (const key of NORMALIZED_KEYS) {
			expect(schema.properties).toHaveProperty(key);
		}
	});

	it("正規スキーマ外のキーを含まない（ラベル正規化の責務をコードに保つ）", () => {
		const schema = buildExtractionJsonSchema();
		const props = Object.keys(schema.properties);
		expect(props.sort()).toEqual([...NORMALIZED_KEYS].sort());
	});
});

// 正規化マッピング（決定的）: AI の生出力（キーごとの生文字列）を NormalizedJob へ寄せる。
describe("rawFieldsToNormalizedJob", () => {
	it("全正規キーを必須で埋め、取れない項目は unknown 中立にする", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		// 指定しなかったキーは unknown
		expect(isUnknown(job.overtime)).toBe(true);
		// 値があるキーは unknown ではない
		expect(isUnknown(job.annualSalary)).toBe(false);
		// 全キーが必ず存在する
		for (const key of NORMALIZED_KEYS) {
			expect(job[key]).toBeDefined();
		}
	});

	it("未記載トークン（「-」「記載なし」）は unknown 中立に寄せる", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "-",
			overtime: "記載なし",
		});
		expect(isUnknown(job.annualSalary)).toBe(true);
		expect(isUnknown(job.overtime)).toBe(true);
	});

	it("数値レンジ項目は numericRange へ寄せ min/max を持つ", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("単一値の数値項目は min === max で表す", () => {
		const job = rawFieldsToNormalizedJob({ annualHolidays: "122日" });
		expect(job.annualHolidays.kind).toBe("numericRange");
		if (job.annualHolidays.kind === "numericRange") {
			expect(job.annualHolidays.min).toBe(122);
			expect(job.annualHolidays.max).toBe(122);
		}
	});

	it("カテゴリ項目（リモート可否）は categorical へ寄せる", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		expect(job.remoteWork.kind).toBe("categorical");
	});

	it("生表記を raw として保持する（監査・UI 用）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.raw).toBe("700万〜900万");
	});

	it("同一入力は常に同一結果（決定的）", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		expect(a).toEqual(b);
	});
});

// 抽出本体: AI を注入し JSON Mode で構造化抽出する。空入力は AI を呼ばない。
describe("extractJob", () => {
	it("空本文では AI を呼ばず全 unknown を返す（unknown 中立・コスト最小化）", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};

		const result = await extractJob(fakeAi, "");

		expect(called).toBe(false);
		expect(result.model).toBe(EXTRACTION_MODEL);
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("空白のみの本文も空とみなし AI を呼ばない", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};

		await extractJob(fakeAi, "   \n  ");
		expect(called).toBe(false);
	});

	it("本文があれば JSON Mode で run し、生出力を正規スキーマへ寄せる", async () => {
		const calls: Array<{ model: string; inputs: unknown }> = [];
		const fakeAi: AiRunner = {
			run: async (model: string, inputs: unknown) => {
				calls.push({ model, inputs });
				// JSON Mode のレスポンスは { response: <object> } 形（一次ソース §7.1）
				return { response: { annualSalary: "700万〜900万" } };
			},
		};

		const result = await extractJob(fakeAi, "年収 700万〜900万");

		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe(EXTRACTION_MODEL);
		// JSON Mode を指示している（response_format に json_schema）
		const inputs = calls[0].inputs as {
			response_format?: { type?: string; json_schema?: unknown };
		};
		expect(inputs.response_format?.type).toBe("json_schema");
		expect(inputs.response_format?.json_schema).toBeDefined();
		// 生出力が正規スキーマへ寄っている
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("AI が response 文字列（JSON）を返しても解釈できる", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({
				response: JSON.stringify({ annualSalary: "700万〜900万" }),
			}),
		};

		const result = await extractJob(fakeAi, "本文");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("AI が想定外形（JSON Mode 未充足等）を返しても落とさず全 unknown へ畳む", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ error: "JSON Mode couldn't be met" }),
		};

		const result = await extractJob(fakeAi, "本文");
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("run が throw しても落とさず全 unknown を返す（抽出は堅牢に）", async () => {
		const fakeAi: AiRunner = {
			run: async () => {
				throw new Error("upstream down");
			},
		};

		const result = await extractJob(fakeAi, "本文");
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("抽出結果は再利用できる形（model と extractedAt を持つ）", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: {} }),
		};
		const result = await extractJob(fakeAi, "本文");
		// §5.3 再実行しない契約: 保存に必要なメタを持つ
		expect(typeof result.model).toBe("string");
		expect(typeof result.extractedAt).toBe("string");
	});
});
