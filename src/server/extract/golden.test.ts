import { describe, expect, it } from "vitest";
import {
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
} from "../../shared/job-schema";
import {
	fieldMatches,
	type GoldenCase,
	type GoldenExpectation,
	gradeCase,
	parseGoldenCase,
	runGolden,
} from "./golden";

// 期待値（採点対象キー）以外を unknown で埋め、完全な NormalizedJob を組み立てる。
// なぜ: runGolden へ渡す fake 抽出器が「全キー必須」の NormalizedJob を返す必要があるため。
function jobFrom(fields: GoldenExpectation): NormalizedJob {
	const entries = NORMALIZED_KEYS.map((key) => [
		key,
		fields[key] ?? ({ kind: "unknown" } as NormalizedFieldValue),
	]);
	return Object.fromEntries(entries) as NormalizedJob;
}

// フィールド単位一致判定（決定的）: kind と値が揃ったときだけ correct。
describe("fieldMatches", () => {
	it("numericRange は min/max が一致すれば correct", () => {
		const actual: NormalizedFieldValue = {
			kind: "numericRange",
			min: 700,
			max: 900,
		};
		const expected: NormalizedFieldValue = {
			kind: "numericRange",
			min: 700,
			max: 900,
		};
		expect(fieldMatches(actual, expected)).toBe(true);
	});

	it("numericRange は min/max がズレれば不一致", () => {
		const actual: NormalizedFieldValue = {
			kind: "numericRange",
			min: 600,
			max: 900,
		};
		const expected: NormalizedFieldValue = {
			kind: "numericRange",
			min: 700,
			max: 900,
		};
		expect(fieldMatches(actual, expected)).toBe(false);
	});

	it("categorical は集合として一致すれば correct（順序非依存・表記揺れ吸収）", () => {
		const actual: NormalizedFieldValue = {
			kind: "categorical",
			categories: ["Full"],
		};
		const expected: NormalizedFieldValue = {
			kind: "categorical",
			categories: ["full"],
		};
		expect(fieldMatches(actual, expected)).toBe(true);
	});

	it("categorical はカテゴリが違えば不一致", () => {
		const actual: NormalizedFieldValue = {
			kind: "categorical",
			categories: ["partial"],
		};
		const expected: NormalizedFieldValue = {
			kind: "categorical",
			categories: ["full"],
		};
		expect(fieldMatches(actual, expected)).toBe(false);
	});

	it("unknown は両者 unknown なら correct（中立の一致）", () => {
		expect(fieldMatches({ kind: "unknown" }, { kind: "unknown" })).toBe(true);
	});

	it("kind が異なれば不一致（unknown 期待に値が来た等）", () => {
		const actual: NormalizedFieldValue = {
			kind: "numericRange",
			min: 700,
			max: 700,
		};
		expect(fieldMatches(actual, { kind: "unknown" })).toBe(false);
	});
});

// ケース採点（決定的）: 期待値を与えたキーだけを分母に含める（unknown 中立の原則）。
describe("gradeCase", () => {
	it("期待値を与えたフィールドのみ採点する（未指定キーは分母に含めない）", () => {
		const expected: GoldenExpectation = {
			annualSalary: { kind: "numericRange", min: 700, max: 900 },
			remoteWork: { kind: "categorical", categories: ["full"] },
		};
		const actual = jobFrom({
			annualSalary: { kind: "numericRange", min: 700, max: 900 },
			remoteWork: { kind: "categorical", categories: ["partial"] },
		});
		const result = gradeCase("case-1", actual, expected);
		expect(result.total).toBe(2);
		expect(result.correct).toBe(1);
		// 採点対象は 2 フィールドのみ（21 キー全てではない）
		expect(result.fields.map((f) => f.key).sort()).toEqual(
			["annualSalary", "remoteWork"].sort(),
		);
	});
});

// 集計（決定的）: フィールド別 {correct,total,accuracy} と overall を返す。
describe("runGolden", () => {
	const extractFrom =
		(byHtml: Record<string, NormalizedJob>) =>
		async (html: string): Promise<NormalizedJob> =>
			byHtml[html];

	it("複数ケースをフィールド単位で集計し overall を返す", async () => {
		const cases: readonly GoldenCase[] = [
			{
				name: "c1",
				html: "h1",
				expected: {
					annualSalary: { kind: "numericRange", min: 700, max: 900 },
					remoteWork: { kind: "categorical", categories: ["full"] },
				},
			},
			{
				name: "c2",
				html: "h2",
				expected: {
					annualSalary: { kind: "numericRange", min: 500, max: 600 },
					remoteWork: { kind: "categorical", categories: ["partial"] },
				},
			},
		];
		const extract = extractFrom({
			// c1: 年収一致・リモート不一致
			h1: jobFrom({
				annualSalary: { kind: "numericRange", min: 700, max: 900 },
				remoteWork: { kind: "categorical", categories: ["onsite"] },
			}),
			// c2: 年収不一致・リモート一致
			h2: jobFrom({
				annualSalary: { kind: "numericRange", min: 400, max: 600 },
				remoteWork: { kind: "categorical", categories: ["partial"] },
			}),
		});

		const report = await runGolden(cases, extract);

		// annualSalary: 2 件中 1 件正解
		expect(report.perField.annualSalary).toEqual({
			correct: 1,
			total: 2,
			accuracy: 0.5,
		});
		// remoteWork: 2 件中 1 件正解
		expect(report.perField.remoteWork).toEqual({
			correct: 1,
			total: 2,
			accuracy: 0.5,
		});
		// 採点されなかったキーは total 0・accuracy null（0% と区別する）
		expect(report.perField.overtime).toEqual({
			correct: 0,
			total: 0,
			accuracy: null,
		});
		// overall: 4 採点中 2 正解
		expect(report.overall).toEqual({ correct: 2, total: 4, accuracy: 0.5 });
		// perCase も保持する（デバッグ・差分表示用）
		expect(report.perCase.map((c) => c.name)).toEqual(["c1", "c2"]);
	});

	it("perField は全正規キーを必ず含む（後続が安全に参照できる安定形）", async () => {
		const report = await runGolden([], async () => jobFrom({}));
		for (const key of NORMALIZED_KEYS) {
			expect(report.perField[key]).toEqual({
				correct: 0,
				total: 0,
				accuracy: null,
			});
		}
		// 採点対象が 0 件なら overall.accuracy も null（精度未定義）
		expect(report.overall).toEqual({ correct: 0, total: 0, accuracy: null });
	});

	it("サニタイズ済みケース 1 件で golden が走りフィールド別精度を出力する", async () => {
		// 受け入れ条件: サニタイズ済 1 件以上で golden が走り、フィールド別精度を出す。
		// 入力 HTML・期待値ともに合成のサニタイズ済みデータ（PII を含まない）。
		const sanitized: GoldenCase = {
			name: "sanitized-sample",
			html: "<article>年収 700万〜900万 / フルリモート / 完全週休2日制</article>",
			expected: {
				annualSalary: { kind: "numericRange", min: 700, max: 900 },
				remoteWork: { kind: "categorical", categories: ["full"] },
				holidaySystem: {
					kind: "categorical",
					categories: ["fullTwoDayWeekoff"],
				},
			},
		};
		// 全項目を正しく抽出できた体の fake 抽出器
		const extract = async (): Promise<NormalizedJob> =>
			jobFrom(sanitized.expected);

		const report = await runGolden([sanitized], extract);

		expect(report.overall).toEqual({ correct: 3, total: 3, accuracy: 1 });
		expect(report.perField.annualSalary.accuracy).toBe(1);
	});
});

// fixture ローダ（決定的・PII 実体は外部 JSON）: 不正な形は型安全に弾く。
describe("parseGoldenCase", () => {
	it("正しい形の JSON を GoldenCase へ読み込む", () => {
		const input: unknown = {
			name: "loaded",
			html: "<p>body</p>",
			expected: {
				annualSalary: {
					kind: "numericRange",
					min: 600,
					max: 800,
					raw: "600万〜800万",
				},
				remoteWork: {
					kind: "categorical",
					categories: ["full"],
					raw: "フルリモート",
				},
				overtime: { kind: "unknown" },
			},
		};
		const parsed = parseGoldenCase(input);
		expect(parsed.name).toBe("loaded");
		expect(parsed.expected.annualSalary).toEqual({
			kind: "numericRange",
			min: 600,
			max: 800,
			raw: "600万〜800万",
		});
	});

	it("name 欠落・html 欠落・未知キー・不正 kind は throw する", () => {
		expect(() => parseGoldenCase({ html: "x", expected: {} })).toThrow();
		expect(() => parseGoldenCase({ name: "x", expected: {} })).toThrow();
		expect(() =>
			parseGoldenCase({
				name: "x",
				html: "y",
				expected: { notAKey: { kind: "unknown" } },
			}),
		).toThrow();
		expect(() =>
			parseGoldenCase({
				name: "x",
				html: "y",
				expected: { annualSalary: { kind: "bogus" } },
			}),
		).toThrow();
	});
});
