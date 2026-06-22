// ts-resolve-hook を非推奨の --loader ではなく module.register で登録する（Node 推奨の方式）。
// build:css 系スクリプトを `node --import ./scripts/register-ts-hook.mjs ...` で起動するために使う。

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./ts-resolve-hook.mjs", pathToFileURL(`${import.meta.dirname}/`));
