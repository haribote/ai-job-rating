// デザイントークンから public/styles.css をビルド時に生成する。
//
// なぜこのスクリプトが存在するか:
// - 成果物の本体は「リポジトリにコミットされた CSS」。トークン定義（src/shared/design-tokens.ts）を
//   単一の真実とし、ここから決定的に CSS を再生成して public/ へ書き出す（実行時依存にしない）。
// - 生成された public/styles.css はリポジトリへコミットし、Worker は静的資産として配信するのみ。
// - 変換ロジック（renderStylesheet）はユニットテスト済み。本スクリプトは I/O の薄いラッパに留める。
// - --check 付きで実行すると、再生成結果と現状ファイルの差分を検査する（トークンと CSS の同期検証）。
//
// 実行は ts-resolve-hook 経由（拡張子なし相対 import を .ts へ橋渡し）。npm run build:css を使う。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { tokenGroups } = await import(
	resolve(root, "src/shared/design-tokens.ts")
);
const { renderStylesheet } = await import(
	resolve(root, "src/shared/design-tokens-css.ts")
);

const css = renderStylesheet(tokenGroups);
const outPath = resolve(root, "public/styles.css");

const check = process.argv.includes("--check");
if (check) {
	let current = "";
	try {
		current = await readFile(outPath, "utf8");
	} catch {
		// ファイル未生成は差分扱い（下で fail させる）
	}
	if (current !== css) {
		console.error(
			"public/styles.css がトークン定義と同期していません。`npm run build:css` を実行してコミットしてください。",
		);
		process.exit(1);
	}
	console.log("public/styles.css is in sync with tokens.");
} else {
	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, css, "utf8");
	console.log(`wrote ${outPath} (${css.length} bytes)`);
}
