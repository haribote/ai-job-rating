import { describe, expect, it } from "vitest";
import type { AiRunner } from "./ai";
import {
	buildExtractionJsonSchema,
	buildExtractionMessages,
	EXTRACTION_MODEL,
	extractJob,
	MAX_EXTRACTION_ATTEMPTS,
	rawFieldsToNormalizedJob,
} from "./extract";
import { isUnknown, NORMALIZED_KEYS } from "./job-schema";
import { DEFAULT_SCORING_CONFIG, scoreJob } from "./score";

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

	it("括弧内の注記の数値を拾わない（注記付き単数値を正しく取る）", () => {
		// なぜ: 括弧内の補足（グループ全体・時点）の数値を本体の数値と混ぜると min/max が破損する。
		const job = rawFieldsToNormalizedJob({
			companySize: "442名（グループ全体　※2025年11月時点）",
		});
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(442);
			expect(job.companySize.max).toBe(442);
		}
	});

	it("※以降の注記の数値を拾わない", () => {
		// なぜ: 「※経験による」「※2024年実績」等の注記は本体のレンジに混入させない。
		const job = rawFieldsToNormalizedJob({
			annualSalary: "700万〜900万 ※経験により決定（2024年実績）",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("半角括弧の注記の数値も拾わない（NFKC 後も同等に扱う）", () => {
		const job = rawFieldsToNormalizedJob({
			companySize: "120名 (2025/03時点)",
		});
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(120);
			expect(job.companySize.max).toBe(120);
		}
	});

	it("多行値でも各行の ※ 注記の数値を拾わない", () => {
		// なぜ: 改行を含む値で ※ 注記が行末まで効かないと、注記内の数値が本体に混入する。
		const job = rawFieldsToNormalizedJob({
			annualSalary: "700万〜900万\n※経験により決定（2024年実績）",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("注記しか数値を含まない場合は unknown 中立に寄せる", () => {
		// なぜ: 本体に数値がなく括弧内にだけ数値があるとき、注記を本体値と誤認しない。
		const job = rawFieldsToNormalizedJob({
			companySize: "非公開（2025年時点）",
		});
		expect(isUnknown(job.companySize)).toBe(true);
	});

	it("カテゴリ項目（リモート可否）は categorical へ寄せる", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		expect(job.remoteWork.kind).toBe("categorical");
	});

	// gap1: 年収・月給は単位を万円へ正規化する（scoring の希望値が万円前提のため、§5.2）。
	it("円表記の年収を万円へ正規化する（900万円→900）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "9,000,000円" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(900);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("円表記の年収レンジを万円へ正規化する（900万〜1300万）", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "9,000,000円〜13,000,000円",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(900);
			expect(job.annualSalary.max).toBe(1300);
		}
	});

	it("万円表記の年収はそのまま万円で持つ（700万〜900万→700/900）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("円表記の月給を万円へ正規化する（30万円→30）", () => {
		const job = rawFieldsToNormalizedJob({ monthlySalary: "300,000円" });
		expect(job.monthlySalary.kind).toBe("numericRange");
		if (job.monthlySalary.kind === "numericRange") {
			expect(job.monthlySalary.min).toBe(30);
			expect(job.monthlySalary.max).toBe(30);
		}
	});

	it("非通貨の numericRange は単位換算しない（年間休日 122日→122）", () => {
		// なぜ: 単位換算は通貨項目だけの関心事。日数・人数・時間に副作用を出さない。
		const job = rawFieldsToNormalizedJob({ annualHolidays: "122日" });
		expect(job.annualHolidays.kind).toBe("numericRange");
		if (job.annualHolidays.kind === "numericRange") {
			expect(job.annualHolidays.min).toBe(122);
			expect(job.annualHolidays.max).toBe(122);
		}
	});

	it("非通貨の numericRange（企業規模・人数）は換算しない（9000名→9000）", () => {
		const job = rawFieldsToNormalizedJob({ companySize: "9,000名" });
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(9000);
			expect(job.companySize.max).toBe(9000);
		}
	});

	// gap2: 主要 categorical は生 JP を canonical トークンへ寄せる（scoring の preferred と整合、§5.2）。
	it("リモート可否を canonical（full/partial/onsite）へ寄せる", () => {
		const full = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const partial = rawFieldsToNormalizedJob({ remoteWork: "一部リモート可" });
		const onsite = rawFieldsToNormalizedJob({ remoteWork: "出社" });
		if (full.remoteWork.kind === "categorical") {
			expect(full.remoteWork.categories).toEqual(["full"]);
		}
		if (partial.remoteWork.kind === "categorical") {
			expect(partial.remoteWork.categories).toEqual(["partial"]);
		}
		if (onsite.remoteWork.kind === "categorical") {
			expect(onsite.remoteWork.categories).toEqual(["onsite"]);
		}
	});

	it("フレックス・裁量労働を canonical（flex/discretionary）へ寄せる", () => {
		const flex = rawFieldsToNormalizedJob({ flexWork: "フレックスタイム制" });
		const discretionary = rawFieldsToNormalizedJob({ flexWork: "裁量労働制" });
		if (flex.flexWork.kind === "categorical") {
			expect(flex.flexWork.categories).toEqual(["flex"]);
		}
		if (discretionary.flexWork.kind === "categorical") {
			expect(discretionary.flexWork.categories).toEqual(["discretionary"]);
		}
	});

	it("canonical 化しても生表記は raw に保持する（監査・UI 用）", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		expect(job.remoteWork.raw).toBe("フルリモート");
	});

	it("未知の categorical 値は生表記を 1 カテゴリとして残す", () => {
		// なぜ: マッピングに無い値を捨てると情報が失われる。canonical 化は best-effort。
		const job = rawFieldsToNormalizedJob({ remoteWork: "応相談" });
		if (job.remoteWork.kind === "categorical") {
			expect(job.remoteWork.categories).toEqual(["応相談"]);
		}
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

	it("成功時は status: ok を返す", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: { annualSalary: "700万" } }),
		};
		const result = await extractJob(fakeAi, "本文");
		expect(result.status).toBe("ok");
	});

	it("transient 504 は限定回数リトライし、成功すれば status: ok を返す", async () => {
		// なぜ: upstream の一時的 504 を無言で全 unknown へ畳まず、まずリトライで救う。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				if (attempts < 2) {
					throw { name: "InferenceUpstreamError", httpCode: 504 };
				}
				return { response: { annualSalary: "700万" } };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(2);
		expect(result.status).toBe("ok");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("transient 504 がリトライ上限まで続けば extraction_failed として畳む（呼び出し側が区別可能）", async () => {
		// なぜ: 「抽出失敗」と「unknown 中立」を呼び出し側が区別できる形にする（§5.2）。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				throw { name: "InferenceUpstreamError", httpCode: 504 };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		// 上限まで試行する
		expect(attempts).toBe(MAX_EXTRACTION_ATTEMPTS);
		expect(result.status).toBe("extraction_failed");
		// 全 unknown へ畳む（堅牢性は維持）
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("非 transient エラー（非 504）はリトライせず即 extraction_failed", async () => {
		// なぜ: 恒久的エラーをリトライしても無駄。区別して即座に失敗扱いにする。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				throw new Error("invalid request");
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(1);
		expect(result.status).toBe("extraction_failed");
	});

	it("想定外形（JSON Mode 未充足）はリトライせず status: ok の全 unknown（throw ではない）", async () => {
		// なぜ: throw されない想定外レスポンスは upstream 障害ではないためリトライ対象外。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				return { error: "JSON Mode couldn't be met" };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(1);
		expect(result.status).toBe("ok");
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

// 抽出↔スコアリングの正規化統合（#59）。抽出側の正規化が DEFAULT_SCORING_CONFIG の
// 単位前提（万円）・canonical 集合と噛み合い、妥当なサブスコアになることを担保する。
describe("正規化統合（抽出→スコアリング）", () => {
	it("円表記の年収が単位整合し annualSalary が常に 1.0 ではなくなる（gap1）", () => {
		// なぜ: 円のまま（9,000,000）だと desired:700 を桁違いに超え常に 1.0 になる回帰を防ぐ。
		const job = rawFieldsToNormalizedJob({ annualSalary: "5,000,000円" });
		const { breakdown } = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const row = breakdown.find((r) => r.key === "annualSalary");
		expect(row?.included).toBe(true);
		// desired:700 / floor:300 の補間域に入る（500万 → (500-300)/(700-300)=0.5）。
		expect(row?.score).toBeCloseTo(0.5);
	});

	it("canonical 化したリモート可否が preferred と突合できる（gap2）", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const { breakdown } = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const row = breakdown.find((r) => r.key === "remoteWork");
		expect(row?.included).toBe(true);
		// "full" は preferred:["full","partial"] に一致 → 1.0。
		expect(row?.score).toBe(1);
	});
});
