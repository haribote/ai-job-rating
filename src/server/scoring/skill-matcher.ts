// 求人スキル集合 × 希望スキル集合の決定的突合（#68 → #20 SkillMatcher 契約の実装）。
//
// なぜこのモジュールが存在するか:
// - aiJudged（requiredSkillsMatch / preferredSkillsMatch）の値は「AI に主観点数を出させる」
//   のではなく、抽出済みの求人側スキル集合（categorical）を希望集合とコードで突合して
//   0..1 で算定する（#65 確定方針）。突合はスコアリング側で決定的に行い、希望条件の変更で
//   AI を再実行しない（§5.3 抽出とスコアリングの分離）。
// - 純粋関数（同一 desired・同一 jobSkills → 同一値、§8）。DB・AI 呼び出しは持たない。
// - 突合不能（求人スキルが取れない 等）は null = unknown 中立で分母から除外する（§5.2）。

import { canonicalizeLabel } from "../../shared/job-schema";
import type { SkillMatcher } from "./rescore-core";

// スキル名を比較用に正規化して一意集合へ寄せる（大小/全半角/装飾記号の揺れを吸収）。
// ラベル正規化はラベルキー突合と同じ canonicalizeLabel を共有する（§5.2 単一方針）。
function toSkillSet(skills: readonly string[]): ReadonlySet<string> {
	const set = new Set<string>();
	for (const s of skills) {
		const key = canonicalizeLabel(s);
		if (key !== "") set.add(key);
	}
	return set;
}

// desired ∩ jobSkills の割合（matched / |jobSkills|）。求人スキルが空なら null（突合不能）。
function coverageRatio(
	desired: readonly string[],
	jobSkills: readonly string[],
): number | null {
	const want = toSkillSet(desired);
	const have = toSkillSet(jobSkills);
	if (have.size === 0) return null;
	let matched = 0;
	for (const s of have) if (want.has(s)) matched++;
	return matched / have.size;
}

// 既定の決定的スキル突合（#20 RescoreExtensions.skillMatcher へ差す）。
// required と preferred の意味差:
// - requiredSkillsMatch（必須充足）: 求人の必須スキルを希望集合がどれだけ満たすか。
//   分母 = 求人スキル数。全充足で 1.0、希望が空なら必須を満たさないので 0.0。
// - preferredSkillsMatch（任意加点）: 求人の歓迎スキルのうち希望と一致する割合の加点。
//   希望が空（歓迎への意見なし）は加点も減点もしないので null = 中立。
export const defaultSkillMatcher: SkillMatcher = ({
	criterion,
	desired,
	jobSkills,
}) => {
	if (criterion === "preferredSkillsMatch" && desired.length === 0) return null;
	return coverageRatio(desired, jobSkills);
};
