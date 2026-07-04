import { describe, expect, it } from "vitest";
import type { ReputationSnapshotRow } from "../storage/db-schema";
import {
	classifyReputationConfidence,
	combineTotalWithReputation,
	computeReputationScore,
	DEFAULT_REPUTATION_WEIGHT_CONFIG,
	foldReputationIntoCompanyAxis,
	normalizeReputationScore,
	parseReputationSubScores,
	resolveReputationContribution,
	sumIncludedWeights,
	weightedAverageExcludingUnknown,
} from "./reputation-score";

// テスト用の最小スナップショット生成。company 軸合流のスコア層は overall_score / review_count /
// sub_scores_json のみを参照するため、識別子・時刻はダミーで固定する（決定的）。
function snap(
	overall_score: number | null,
	review_count: number | null,
	sub_scores_json: string | null = null,
	source = "src",
): ReputationSnapshotRow {
	return {
		id: `id-${source}`,
		company_id: "c1",
		source,
		overall_score,
		review_count,
		sub_scores_json,
		fetched_at: 0,
		created_at: 0,
	};
}

describe("normalizeReputationScore（ネイティブスケール → 0..1・決定的）", () => {
	it("0–5 ネイティブを線形に 0..1 へ寄せる", () => {
		expect(normalizeReputationScore(0, 5)).toBe(0);
		expect(normalizeReputationScore(2.5, 5)).toBe(0.5);
		expect(normalizeReputationScore(5, 5)).toBe(1);
	});

	it("範囲外はクランプする（取得元が上限超過・負値を返しても 0..1 に収める）", () => {
		expect(normalizeReputationScore(6, 5)).toBe(1);
		expect(normalizeReputationScore(-1, 5)).toBe(0);
	});

	it("100 点スケール等 nativeMax を変えても決定的に正規化する", () => {
		expect(normalizeReputationScore(70, 100)).toBe(0.7);
	});
});

describe("computeReputationScore（件数による信頼度重み付け）", () => {
	it("件数の少ない高評価が、件数の多い中評価を支配しない（受け入れの直接検証）", () => {
		// 少件数・高評価（3 件・4.8/5）と 多件数・中評価（500 件・3.5/5）を比較する。
		const fewButHigh = computeReputationScore([snap(4.8, 3)]);
		const manyButMid = computeReputationScore([snap(3.5, 500)]);
		expect(fewButHigh).not.toBeNull();
		expect(manyButMid).not.toBeNull();
		// 信頼度重みにより、多件数・中評価が少件数・高評価を上回る。
		expect(manyButMid as number).toBeGreaterThan(fewButHigh as number);
	});

	it("極端な 1 件満点も中評価多件数を超えない（ベイズ収縮）", () => {
		const onePerfect = computeReputationScore([snap(5, 1)]);
		const manyMid = computeReputationScore([snap(3, 1000)]);
		expect(manyMid as number).toBeGreaterThan(onePerfect as number);
	});

	it("既定設定のベイズ平均式 (C·m + Σnᵢxᵢ)/(C + Σnᵢ) に一致する", () => {
		// x = 3.5/5 = 0.7, n = 500, C = 10, m = 0.5 → (5 + 350)/510。
		const got = computeReputationScore([snap(3.5, 500)]);
		expect(got).toBeCloseTo((10 * 0.5 + 500 * 0.7) / (10 + 500), 10);
	});

	it("件数が増えるほど素のスコアへ近づき、少ないほど中立 prior へ寄る", () => {
		const high = 4.5;
		const small = computeReputationScore([snap(high, 1)]) as number;
		const large = computeReputationScore([snap(high, 100000)]) as number;
		const raw = high / 5;
		// 大件数は素スコアにほぼ一致、小件数は中立(0.5)寄りで素スコアより低い。
		expect(large).toBeCloseTo(raw, 3);
		expect(small).toBeLessThan(large);
		expect(small).toBeGreaterThan(DEFAULT_REPUTATION_WEIGHT_CONFIG.priorMean);
	});

	it("複数取得元は件数で重み付けしてプールする（多件数源が支配）", () => {
		// 同一企業の 2 源: 5 件・5.0 と 1000 件・3.0。プール結果は多件数源寄り。
		const pooled = computeReputationScore([
			snap(5, 5, null, "a"),
			snap(3, 1000, null, "b"),
		]) as number;
		const onlyMany = computeReputationScore([snap(3, 1000)]) as number;
		expect(pooled).toBeCloseTo(onlyMany, 1);
	});
});

describe("computeReputationScore（unknown 中立・分母除外）", () => {
	it("取得行なし（空配列）は null（company 軸の分母から外す）", () => {
		expect(computeReputationScore([])).toBeNull();
	});

	it("overall_score が NULL の行は分母に入れない", () => {
		expect(computeReputationScore([snap(null, 100)])).toBeNull();
	});

	it("review_count が NULL の行は分母に入れない", () => {
		expect(computeReputationScore([snap(4, null)])).toBeNull();
	});

	it("NULL 行は無視され、有効行のみで算出する（未取得と取得済みの区別を尊重）", () => {
		const mixed = computeReputationScore([
			snap(null, null, null, "a"),
			snap(3.5, 500, null, "b"),
		]);
		const only = computeReputationScore([snap(3.5, 500)]);
		expect(mixed).toBe(only);
	});

	it("review_count=0 の行は証拠ゼロとして中立 prior に収束する（低信頼→中立）", () => {
		expect(computeReputationScore([snap(5, 0)])).toBe(
			DEFAULT_REPUTATION_WEIGHT_CONFIG.priorMean,
		);
	});

	it("priorStrength=0 かつ全行 review_count=0（分母 0）は NaN でなく null へ倒す", () => {
		// フォークが prior を無効化(priorStrength=0)し、証拠も 0 件のとき 0/0=NaN を company 軸へ
		// 漏らさず中立(null＝分母除外)にする。
		const config = { ...DEFAULT_REPUTATION_WEIGHT_CONFIG, priorStrength: 0 };
		expect(computeReputationScore([snap(4, 0)], config)).toBeNull();
	});
});

describe("weightedAverageExcludingUnknown（null は分母除外）", () => {
	it("null 項目を分母から外して加重平均する", () => {
		expect(
			weightedAverageExcludingUnknown([
				{ score: 0.8, weight: 2 },
				{ score: null, weight: 5 },
				{ score: 0.2, weight: 2 },
			]),
		).toBeCloseTo((2 * 0.8 + 2 * 0.2) / (2 + 2), 10);
	});

	it("採用項目ゼロ（全 null）は null", () => {
		expect(
			weightedAverageExcludingUnknown([{ score: null, weight: 1 }]),
		).toBeNull();
	});
});

describe("foldReputationIntoCompanyAxis（評判を company 軸へ合流・新軸を作らない）", () => {
	it("評判は company 軸の 1 項目として加重平均へ合流する", () => {
		const items = [{ score: 0.4, weight: 1 }];
		const snapshots = [snap(4, 100)];
		const rep = computeReputationScore(snapshots) as number;
		const got = foldReputationIntoCompanyAxis(items, snapshots);
		const w = DEFAULT_REPUTATION_WEIGHT_CONFIG.weight;
		expect(got).toBeCloseTo((1 * 0.4 + w * rep) / (1 + w), 10);
	});

	it("評判データ無しは評判項目を分母から外し、企業項目だけで集約する（中立）", () => {
		const items = [
			{ score: 0.4, weight: 1 },
			{ score: 0.6, weight: 1 },
		];
		const got = foldReputationIntoCompanyAxis(items, []);
		expect(got).toBeCloseTo((0.4 + 0.6) / 2, 10);
	});

	it("企業項目も評判も無ければ company 軸は null（分母 0）", () => {
		expect(foldReputationIntoCompanyAxis([], [])).toBeNull();
	});

	it("件数の少ない高評価は company 軸を支配しない（多件数・中評価の方が高い company 軸値）", () => {
		const items = [{ score: 0.5, weight: 1 }];
		const fewHigh = foldReputationIntoCompanyAxis(items, [
			snap(5, 2),
		]) as number;
		const manyMid = foldReputationIntoCompanyAxis(items, [
			snap(3.5, 800),
		]) as number;
		expect(manyMid).toBeGreaterThan(fewHigh);
	});
});

describe("combineTotalWithReputation（総合スコアへ評判を read-time 合流・#181）", () => {
	it("評判なし（score=null）は persistedTotal をそのまま返す（中立除外）", () => {
		expect(
			combineTotalWithReputation(0.8, 15, { score: null, weight: 3 }),
		).toBe(0.8);
	});

	it("評判ありは (Σwᵢsᵢ + wr·sr)/(Σwᵢ + wr) と厳密一致する", () => {
		// persistedTotal=0.8（重み合計15）に評判 0.4（重み3）を合流。
		expect(combineTotalWithReputation(0.8, 15, { score: 0.4, weight: 3 })).toBe(
			(15 * 0.8 + 3 * 0.4) / (15 + 3),
		);
	});

	it("persistedTotal=null（全項目 unknown）でも評判があれば評判値になる", () => {
		expect(combineTotalWithReputation(null, 0, { score: 0.6, weight: 3 })).toBe(
			0.6,
		);
	});

	it("persistedTotal=null かつ評判なしは null（全 unknown）", () => {
		expect(
			combineTotalWithReputation(null, 0, { score: null, weight: 3 }),
		).toBeNull();
	});
});

describe("sumIncludedWeights（scoreJob の分母を breakdown から復元）", () => {
	it("included かつ score!=null の重みだけ合計する", () => {
		expect(
			sumIncludedWeights([
				{ weight: 5, score: 1, included: true },
				{ weight: 3, score: 0.5, included: true },
				{ weight: 2, score: null, included: false }, // unknown 中立
				{ weight: 4, score: null, included: true }, // 防御: included でも score=null は除外
			]),
		).toBe(8);
	});
});

describe("決定性（同一入力・同一設定で同一スコア）", () => {
	it("computeReputationScore は副作用なく同値を返す", () => {
		const snaps = [snap(4.2, 30, null, "a"), snap(3.1, 120, null, "b")];
		expect(computeReputationScore(snaps)).toBe(computeReputationScore(snaps));
	});

	it("foldReputationIntoCompanyAxis は同値を返す", () => {
		const items = [{ score: 0.3, weight: 2 }];
		const snaps = [snap(4.2, 30)];
		expect(foldReputationIntoCompanyAxis(items, snaps)).toBe(
			foldReputationIntoCompanyAxis(items, snaps),
		);
	});
});

describe("parseReputationSubScores（sub_scores_json の安全な解釈）", () => {
	it("string→有限数の record を取り出す", () => {
		expect(parseReputationSubScores('{"成長":4,"給与":3.5}')).toEqual({
			成長: 4,
			給与: 3.5,
		});
	});

	it("NULL・空文字・不正 JSON・非オブジェクトは null（中立）", () => {
		expect(parseReputationSubScores(null)).toBeNull();
		expect(parseReputationSubScores("")).toBeNull();
		expect(parseReputationSubScores("not json")).toBeNull();
		expect(parseReputationSubScores("[1,2]")).toBeNull();
		expect(parseReputationSubScores('"x"')).toBeNull();
	});

	it("非有限・非数の値は除外し、残りが空なら null", () => {
		expect(parseReputationSubScores('{"a":1,"b":"x","c":null}')).toEqual({
			a: 1,
		});
		expect(parseReputationSubScores('{"b":"x"}')).toBeNull();
	});
});

describe("classifyReputationConfidence（低信頼フラグ判定・#37）", () => {
	it("取得行なし（空配列）は none（データなし＝中立・低信頼）", () => {
		expect(classifyReputationConfidence([])).toBe("none");
	});

	it("全 NULL（取得済みだが該当なし）も none", () => {
		expect(classifyReputationConfidence([snap(null, null)])).toBe("none");
	});

	it("件数合計が priorStrength 未満なら low（中立 prior が過半を占める）", () => {
		// Σn=3 < C=10 → 事前分布の重み C/(C+Σn) が過半 → 低信頼。
		expect(classifyReputationConfidence([snap(4.8, 3)])).toBe("low");
	});

	it("件数合計が priorStrength 以上なら ok（証拠が事前分布を上回る）", () => {
		expect(classifyReputationConfidence([snap(3.5, 500)])).toBe("ok");
	});

	it("review_count=0 は証拠ゼロで low（取得できたが件数なし＝低信頼）", () => {
		expect(classifyReputationConfidence([snap(5, 0)])).toBe("low");
	});

	it("分母 0（priorStrength=0 かつ全件 0）は none（評価不能＝中立）", () => {
		const config = { ...DEFAULT_REPUTATION_WEIGHT_CONFIG, priorStrength: 0 };
		expect(classifyReputationConfidence([snap(4, 0)], config)).toBe("none");
	});
});

describe("resolveReputationContribution（APIキー未設定時の中立除外・#37）", () => {
	it("APIキー未設定なら snapshots に関わらず中立除外（score=null・confidence=none）", () => {
		// 設定済みなら寄与する豊富なデータでも、キー未設定では評判は取得できない＝中立扱い。
		const contribution = resolveReputationContribution(false, [snap(3.5, 500)]);
		expect(contribution).toEqual({ score: null, confidence: "none" });
	});

	it("APIキー設定済み・データありは computeReputationScore と classify を返す", () => {
		const snapshots = [snap(3.5, 500)];
		const contribution = resolveReputationContribution(true, snapshots);
		expect(contribution.score).toBe(computeReputationScore(snapshots));
		expect(contribution.confidence).toBe("ok");
	});

	it("APIキー設定済み・データなしは中立（score=null・confidence=none）", () => {
		expect(resolveReputationContribution(true, [])).toEqual({
			score: null,
			confidence: "none",
		});
	});

	it("score=null のとき confidence は必ず none（compute との整合）", () => {
		const config = { ...DEFAULT_REPUTATION_WEIGHT_CONFIG, priorStrength: 0 };
		const contribution = resolveReputationContribution(
			true,
			[snap(4, 0)],
			config,
		);
		expect(contribution).toEqual({ score: null, confidence: "none" });
	});

	it("APIキー未設定でも他項目（companySize 等）のスコアリングは成立する（受け入れの直接検証）", () => {
		// 評判を中立除外しても、company 軸の他項目だけで加重平均が成立することを seam で固定する。
		// 実配線（scoreJob への合流）は #117 の責務。ここでは寄与 null が分母から外れることを担保する。
		const contribution = resolveReputationContribution(false, [
			snap(4.8, 1000),
		]);
		const companyAxis = weightedAverageExcludingUnknown([
			{ score: 0.4, weight: 1 }, // companySize
			{ score: 0.6, weight: 1 }, // capital
			{
				score: contribution.score,
				weight: DEFAULT_REPUTATION_WEIGHT_CONFIG.weight,
			},
		]);
		// 評判項目は分母から外れ、他 2 項目の加重平均に一致する。
		expect(companyAxis).toBeCloseTo((0.4 + 0.6) / 2, 10);
	});
});
