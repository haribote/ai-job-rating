// package-lock.json の行頭インデントを 2-space へ正規化して上書きする薄い I/O ラッパ。
//
// なぜ存在するか:
// - 変換ロジック（normalizeLockfileIndent）は src/lockfile-indent.ts に集約しユニットテスト済み。
//   本スクリプトは「ファイルを読む・正規化する・差分があれば書き戻す」だけの I/O に留める。
// - pre-commit hook から呼ばれ、npm install が lockfile を tab で全面書き換えする罠を打ち消す。
//
// 実行: node scripts/normalize-lockfile.mjs [files...]
//   引数を省略すると package-lock.json を対象にする。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { normalizeLockfileIndent } = await import(
	resolve(root, "src/lockfile-indent.ts")
);

const files = process.argv.slice(2);
if (files.length === 0) {
	files.push("package-lock.json");
}

for (const file of files) {
	const target = resolve(root, file);
	// working tree に無いファイル（staged 後に削除した等）は対象外。commit を止めない。
	if (!existsSync(target)) {
		continue;
	}
	const original = readFileSync(target, "utf8");
	const normalized = normalizeLockfileIndent(original);
	if (normalized !== original) {
		writeFileSync(target, normalized);
		console.log(`normalized lockfile indentation: ${file}`);
	}
}
