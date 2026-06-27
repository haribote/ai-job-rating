import { describe, expect, it } from "vitest";
import {
	BENEFIT_SIGNAL_KEYS,
	type BenefitSignalKey,
	computeBenefitsCoverage,
	detectBenefitSignals,
} from "./benefits-coverage";

describe("detectBenefitSignals（canonical 閉集合の signal 検出）", () => {
	it("完全週休2日制は完全版と週休2日制の両方を計上する（高評価の決定的表現）", () => {
		const signals = detectBenefitSignals("完全週休2日制（土日祝）");
		expect(signals.has("completeTwoDayWeekoff")).toBe(true);
		expect(signals.has("twoDayWeekoff")).toBe(true);
	});

	it("週休2日制のみは完全版を計上しない", () => {
		const signals = detectBenefitSignals("週休2日制");
		expect(signals.has("twoDayWeekoff")).toBe(true);
		expect(signals.has("completeTwoDayWeekoff")).toBe(false);
	});

	it("休暇制度・その他福利厚生を区切り記号をまたいで検出する", () => {
		const signals = detectBenefitSignals(
			"有給休暇 / 慶弔休暇 ・ 退職金制度 / 住宅手当 / 資格取得支援",
		);
		expect(signals.has("paidLeave")).toBe(true);
		expect(signals.has("condolenceLeave")).toBe(true);
		expect(signals.has("retirementAllowance")).toBe(true);
		expect(signals.has("allowances")).toBe(true);
		expect(signals.has("trainingSupport")).toBe(true);
	});

	it("退職金は retirementAllowance signal として吸収する（独立キー廃止）", () => {
		expect(detectBenefitSignals("退職金あり").has("retirementAllowance")).toBe(
			true,
		);
	});

	it("副業不可は sideJob を誤検出しない（否定の取り違え防止）", () => {
		expect(detectBenefitSignals("副業不可").has("sideJob")).toBe(false);
		expect(detectBenefitSignals("副業可能").has("sideJob")).toBe(true);
	});

	it("閉集合外の記載は計上しない（過大評価の抑制）", () => {
		const signals = detectBenefitSignals("社内にカフェあり / 雰囲気が良い");
		expect(signals.size).toBe(0);
	});

	it("同一入力で同一結果（決定的）", () => {
		const a = [...detectBenefitSignals("有給休暇 / 退職金")].sort();
		const b = [...detectBenefitSignals("有給休暇 / 退職金")].sort();
		expect(a).toEqual(b);
	});
});

describe("computeBenefitsCoverage（充足率 0..100）", () => {
	it("充足率 = 該当数 / 総数 ×100（決定的・境界）", () => {
		expect(computeBenefitsCoverage(new Set())).toBe(0);
		const half = new Set<BenefitSignalKey>(
			BENEFIT_SIGNAL_KEYS.slice(0, BENEFIT_SIGNAL_KEYS.length / 2),
		);
		expect(computeBenefitsCoverage(half)).toBe(50);
		expect(computeBenefitsCoverage(new Set(BENEFIT_SIGNAL_KEYS))).toBe(100);
	});

	it("重視 signal は重み付けして加点に効かせる（保有時に充足率が上がる）", () => {
		const present = new Set<BenefitSignalKey>([BENEFIT_SIGNAL_KEYS[0]]);
		const base = computeBenefitsCoverage(present);
		const emphasized = computeBenefitsCoverage(present, [
			BENEFIT_SIGNAL_KEYS[0],
		]);
		expect(emphasized).toBeGreaterThan(base);
	});

	it("重視 signal を欠くと充足率は下がる（重視は分母を厚くする）", () => {
		// 重視 signal を1件保有し、別の重視 signal を欠く構成で比較する。
		const present = new Set<BenefitSignalKey>([BENEFIT_SIGNAL_KEYS[0]]);
		const base = computeBenefitsCoverage(present, [BENEFIT_SIGNAL_KEYS[0]]);
		const lacking = computeBenefitsCoverage(present, [
			BENEFIT_SIGNAL_KEYS[0],
			BENEFIT_SIGNAL_KEYS[1],
		]);
		expect(lacking).toBeLessThan(base);
	});

	it("閉集合外の emphasis キーは無害（充足率を変えない）", () => {
		const present = new Set<BenefitSignalKey>([BENEFIT_SIGNAL_KEYS[0]]);
		expect(
			computeBenefitsCoverage(present, ["__bogus__" as BenefitSignalKey]),
		).toBe(computeBenefitsCoverage(present));
	});
});
