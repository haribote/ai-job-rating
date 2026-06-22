// 拡張子なしの相対 import（例: "./design-tokens"）を兄弟の .ts ファイルへ解決する Node loader hook。
//
// なぜ必要か:
// - src/ は moduleResolution: "Bundler" 前提で拡張子なし import を使う（コードベース規約）。
// - Node の type stripping は拡張子なしの .ts 解決をしないため、build:css でそのまま読めない。
// - 規約を曲げずビルドスクリプトから TS を直接読むため、拡張子なし相対指定だけを .ts に橋渡しする。

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith(".") && !/\.[mc]?[jt]s$/.test(specifier)) {
		const parentPath = context.parentURL
			? fileURLToPath(context.parentURL)
			: process.cwd();
		const candidate = resolvePath(dirname(parentPath), `${specifier}.ts`);
		if (existsSync(candidate)) {
			return nextResolve(pathToFileURL(candidate).href, context);
		}
	}
	return nextResolve(specifier, context);
}
