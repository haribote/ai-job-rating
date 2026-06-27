// 求人スキル集合 × ユーザー keyword の決定的ヒット採点（#105）。
//
// なぜこのモジュールが存在するか:
// - skillMatch（techStack＋必須＋歓迎の統合）は抽出済みの求人側スキル集合（categorical）を
//   ユーザー設定 keyword とコードで突合して 0..100 で算定する（設計書 §5.2）。突合はスコアリング側で
//   決定的に行い、keyword の変更で AI を再実行しない（§5.3 抽出とスコアリングの分離）。
// - 純粋関数（同一 jobSkills・同一 keywords → 同一値、§8）。DB・AI 呼び出しは持たない。
// - 必須/歓迎の区別はしない。ヒット率は「ユーザー keyword のうち求人に出現した割合」で測る。

import { canonicalizeLabel } from "../../shared/job-schema";

// スキル名・keyword を比較用に正規化して一意集合へ寄せる（大小/全半角/装飾記号の揺れを吸収）。
// ラベル正規化はラベルキー突合と同じ canonicalizeLabel を共有する（§5.2 単一方針）。
function toSkillSet(skills: readonly string[]): ReadonlySet<string> {
	const set = new Set<string>();
	for (const s of skills) {
		const key = canonicalizeLabel(s);
		if (key !== "") set.add(key);
	}
	return set;
}

// 求人スキル × ユーザー keyword の決定的ヒット率（0..100）。
// 分母はユーザー keyword（一意化後）の数。求人が列挙するスキル数では割らないので、技術を多く
// 列挙する求人が不利にならない（「自分が欲しい keyword をどれだけ満たすか」を測る・#105）。
// 有効な keyword が無い（未指定・正規化後に全て空に潰れる）は意見なし = null（中立）。0（ヒット 0）と
// 区別することで、装飾記号だけの keyword を「減点」でなく「分母から除外」に倒す（§5.2 unknown 中立）。
export function matchSkills(
	jobSkills: readonly string[],
	keywords: readonly string[],
): number | null {
	const want = toSkillSet(keywords);
	if (want.size === 0) return null;
	const have = toSkillSet(jobSkills);
	let matched = 0;
	for (const k of want) if (have.has(k)) matched++;
	return (matched / want.size) * 100;
}
