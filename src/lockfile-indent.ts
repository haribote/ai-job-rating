// package-lock.json の行頭インデントを 2-space に正規化する純粋関数。
//
// なぜ存在するか:
// - npm install が package-lock.json を tab で全面書き換えすることがあり（#74 で再発した既知の罠）、
//   そのままコミットすると巨大な無意味差分になる。コミット時に行頭の tab を 2-space へ戻し最小差分に保つ。
// - 変換ロジックはここに集約してユニットテストで担保し、I/O は scripts/normalize-lockfile.mjs と
//   pre-commit hook が薄く呼ぶだけにする（決定的ロジックとファイル操作の責務分離）。
//
// 仕様: 各行の「行頭の空白並び」に含まれる tab だけを 2-space に置換する。
// 値の中身（行頭以外）は一切触らないため、変更は常にインデントのみ・冪等。

export function normalizeLockfileIndent(content: string): string {
	return content.replace(/^[\t ]+/gm, (indent) => indent.replace(/\t/g, "  "));
}
