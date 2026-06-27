// 抽出品質の golden ゲート（要件 §5.2 / §5.3、実装計画 Task 7）。
//
// なぜこのモジュールが存在するか:
// - 実求人の golden セット（入力 HTML + フィールド単位の期待値）に対し抽出結果を
//   フィールド単位で突き合わせ精度を算出する。モデル/プロンプト/コンテンツ抽出の変更を
//   「golden 精度 現行以上」で安全に回すための回帰土台（後続タスクが本モジュールを消費する）。
// - 抽出本体（live Workers AI）は外から GoldenExtractor として注入する。これにより
//   採点・集計ロジックは決定的・オフラインでユニットテスト可能に保ち、live 推論は
//   driver 側へ分離する（§5.3 抽出とスコアリングの分離と同じ思想）。
// - PII を含む golden 実体はコミットしない（test-fixtures/golden は gitignore / サニタイズ）。
//   本モジュールは実体を埋め込まず、parseGoldenCase で外部 JSON を型安全に読み込む。

import {
	canonicalizeLabel,
	NORMALIZED_KEYS,
	type NormalizedFieldValue,
	type NormalizedJob,
	type NormalizedKey,
} from "../../shared/job-schema";

// golden の期待値: 採点したいフィールドのみ正規値で与える（未指定キーは採点対象外）。
// なぜ Partial か: 全正規キーの正解を毎ケース用意するのは非現実的。unknown 中立の原則に合わせ、
// 期待値を与えたフィールドだけを分母（total）に含める。
export type GoldenExpectation = Partial<
	Record<NormalizedKey, NormalizedFieldValue>
>;

// golden 1 ケース: サニタイズ済み入力 HTML と、フィールド単位の期待値。
export interface GoldenCase {
	readonly name: string;
	readonly html: string;
	readonly expected: GoldenExpectation;
}

// 抽出器の注入点。live は `(html) => extractJob(ai, trimHtml(html)).then(r => r.job)` を渡す。
// テストは決定的な fake を渡す（live 推論に依存させない）。
export type GoldenExtractor = (html: string) => Promise<NormalizedJob>;

// フィールド単位の精度。total===0（採点対象外）のとき accuracy は null（0% と区別する）。
export interface FieldAccuracy {
	readonly correct: number;
	readonly total: number;
	readonly accuracy: number | null;
}

// ケース内の 1 フィールドの採点結果（デバッグ・差分表示用）。
export interface GoldenFieldResult {
	readonly key: NormalizedKey;
	readonly correct: boolean;
	readonly expected: NormalizedFieldValue;
	readonly actual: NormalizedFieldValue;
}

// ケース単位の採点結果。
export interface GoldenCaseResult {
	readonly name: string;
	readonly fields: readonly GoldenFieldResult[];
	readonly correct: number;
	readonly total: number;
}

// runGolden の戻り値（公開契約・後続タスクの回帰判定が消費する安定形）。
// - perField: 全正規キーを必ず含む（採点外キーも {0,0,null} で存在）。
// - overall: 全採点の合算。
// - perCase: ケース別の内訳（どのフィールドが落ちたかを追える）。
export interface GoldenReport {
	readonly perField: Record<NormalizedKey, FieldAccuracy>;
	readonly overall: FieldAccuracy;
	readonly perCase: readonly GoldenCaseResult[];
}

// categorical の集合一致（順序非依存・表記揺れ吸収）。
// canonicalizeLabel で正規化してから集合比較するため、"Full" と "full" を同一視する。
function sameCategorySet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const norm = (xs: readonly string[]): string[] =>
		[...xs].map(canonicalizeLabel).sort();
	const na = norm(a);
	const nb = norm(b);
	return na.every((v, i) => v === nb[i]);
}

// 抽出値が期待値に一致するか（決定的）。kind が違えば不一致。
// 各 kind の同値性: numericRange=min/max 一致、categorical=集合一致、aiJudged=score 一致、unknown=両者 unknown。
export function fieldMatches(
	actual: NormalizedFieldValue,
	expected: NormalizedFieldValue,
): boolean {
	if (actual.kind === "unknown" && expected.kind === "unknown") return true;
	if (actual.kind === "numericRange" && expected.kind === "numericRange") {
		return actual.min === expected.min && actual.max === expected.max;
	}
	if (actual.kind === "categorical" && expected.kind === "categorical") {
		return sameCategorySet(actual.categories, expected.categories);
	}
	if (actual.kind === "aiJudged" && expected.kind === "aiJudged") {
		return actual.score === expected.score;
	}
	return false;
}

// 1 ケースを採点する（決定的）。期待値を与えたキーのみ分母に含める。
export function gradeCase(
	name: string,
	actual: NormalizedJob,
	expected: GoldenExpectation,
): GoldenCaseResult {
	const fields: GoldenFieldResult[] = [];
	// NORMALIZED_KEYS を反復し決定的順序にする（Object.keys の順序揺れを避ける）。
	for (const key of NORMALIZED_KEYS) {
		const exp = expected[key];
		if (exp === undefined) continue;
		const act = actual[key];
		fields.push({
			key,
			expected: exp,
			actual: act,
			correct: fieldMatches(act, exp),
		});
	}
	const correct = fields.filter((f) => f.correct).length;
	return { name, fields, correct, total: fields.length };
}

// accuracy を算出する。採点対象外（total===0）は null（精度未定義。0% と区別する）。
function accuracyOf(correct: number, total: number): number | null {
	return total === 0 ? null : correct / total;
}

// 全正規キーを {0,0,null} で初期化した可変カウンタを作る。
function emptyCounts(): Record<
	NormalizedKey,
	{ correct: number; total: number }
> {
	const entries = NORMALIZED_KEYS.map((key) => [key, { correct: 0, total: 0 }]);
	return Object.fromEntries(entries) as Record<
		NormalizedKey,
		{ correct: number; total: number }
	>;
}

// golden セットを実行し、フィールド別精度と overall を集計する。
// 抽出器を注入することで採点・集計を決定的に保つ（live 推論は driver 側の責務）。
export async function runGolden(
	cases: readonly GoldenCase[],
	extract: GoldenExtractor,
): Promise<GoldenReport> {
	const counts = emptyCounts();
	const perCase: GoldenCaseResult[] = [];
	let overallCorrect = 0;
	let overallTotal = 0;

	for (const c of cases) {
		const actual = await extract(c.html);
		const result = gradeCase(c.name, actual, c.expected);
		perCase.push(result);
		for (const f of result.fields) {
			const cur = counts[f.key];
			cur.total += 1;
			overallTotal += 1;
			if (f.correct) {
				cur.correct += 1;
				overallCorrect += 1;
			}
		}
	}

	const perFieldEntries = NORMALIZED_KEYS.map((key) => {
		const { correct, total } = counts[key];
		return [key, { correct, total, accuracy: accuracyOf(correct, total) }];
	});
	const perField = Object.fromEntries(perFieldEntries) as Record<
		NormalizedKey,
		FieldAccuracy
	>;

	return {
		perField,
		overall: {
			correct: overallCorrect,
			total: overallTotal,
			accuracy: accuracyOf(overallCorrect, overallTotal),
		},
		perCase,
	};
}

// ---------------------------------------------------------------------------
// fixture ローダ（PII 実体は外部 JSON。本モジュールに実体を埋め込まない）
// ---------------------------------------------------------------------------

// 正規キーの実行時メンバーシップ判定用集合。
const NORMALIZED_KEY_SET: ReadonlySet<string> = new Set<string>(
	NORMALIZED_KEYS,
);

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`golden: ${ctx} はオブジェクトである必要があります`);
	}
	return value as Record<string, unknown>;
}

// JSON 由来の 1 フィールド値を NormalizedFieldValue へ検証して読み込む（決定的・想定外は throw）。
function parseFieldValue(value: unknown, ctx: string): NormalizedFieldValue {
	const obj = asRecord(value, ctx);
	const kind = obj.kind;
	const raw = typeof obj.raw === "string" ? { raw: obj.raw } : {};
	switch (kind) {
		case "unknown":
			return { kind: "unknown", ...raw };
		case "numericRange":
			if (typeof obj.min !== "number" || typeof obj.max !== "number") {
				throw new Error(
					`golden: ${ctx} の numericRange は min/max(number) が必要です`,
				);
			}
			return { kind: "numericRange", min: obj.min, max: obj.max, ...raw };
		case "categorical":
			if (
				!Array.isArray(obj.categories) ||
				!obj.categories.every((c) => typeof c === "string")
			) {
				throw new Error(
					`golden: ${ctx} の categorical は categories(string[]) が必要です`,
				);
			}
			return { kind: "categorical", categories: obj.categories, ...raw };
		case "aiJudged":
			if (typeof obj.score !== "number") {
				throw new Error(
					`golden: ${ctx} の aiJudged は score(number) が必要です`,
				);
			}
			return { kind: "aiJudged", score: obj.score, ...raw };
		default:
			throw new Error(`golden: ${ctx} の kind が不正です: ${String(kind)}`);
	}
}

function parseExpectation(value: unknown, caseName: string): GoldenExpectation {
	const obj = asRecord(value, `${caseName}.expected`);
	const expected: GoldenExpectation = {};
	for (const [key, fieldValue] of Object.entries(obj)) {
		if (!NORMALIZED_KEY_SET.has(key)) {
			throw new Error(`golden: ${caseName}.expected に未知の正規キー: ${key}`);
		}
		expected[key as NormalizedKey] = parseFieldValue(
			fieldValue,
			`${caseName}.expected.${key}`,
		);
	}
	return expected;
}

// 外部 JSON（パース済み unknown）を GoldenCase へ型安全に読み込む。
// PII を含む実体ファイルを driver/CI が読み込む際の単一検証点（不正な形は throw）。
export function parseGoldenCase(input: unknown): GoldenCase {
	const obj = asRecord(input, "case");
	if (typeof obj.name !== "string" || obj.name === "") {
		throw new Error("golden: case.name(非空 string) が必要です");
	}
	if (typeof obj.html !== "string") {
		throw new Error(`golden: ${obj.name}.html(string) が必要です`);
	}
	return {
		name: obj.name,
		html: obj.html,
		expected: parseExpectation(obj.expected, obj.name),
	};
}
