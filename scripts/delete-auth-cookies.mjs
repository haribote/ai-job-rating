// #193 デプロイ済み環境の DELETE /api/auth/cookies を叩く薄い I/O ドライバ。
//
// なぜ存在するか:
// - curl/inline fetch は context-mode hook で遮断されるため、デプロイ済み Worker への直接
//   HTTP 呼び出しは scripts/ 配下の .mjs driver + node 実行に統一している
//   （既存 scripts/live-smoke.mjs、scripts/eval/eval-models.mjs と同じパターン）。
// - Basic 認証ヘッダ組み立て（#183 サイトアクセス制限対応）はテスト済みの
//   src/server/smoke/live-smoke.ts の buildBasicAuthHeader をそのまま再利用する。
//
// 実行:
//   node scripts/delete-auth-cookies.mjs --base-url https://<deployed> [--url <origin-or-any-url>]
//     [--auth-user <user> --auth-pass <pass>]
// --url 省略時は KV 上の Cookie を全消しする（サーバ側で origin 正規化するため driver 側では行わない）。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { buildBasicAuthHeader } = await import(
	resolve(root, "src/server/smoke/live-smoke.ts")
);

function parseArgs(argv) {
	const args = { baseUrl: null, url: null, authUser: null, authPass: null };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--base-url") {
			args.baseUrl = value;
			i += 1;
		} else if (flag === "--url") {
			args.url = value;
			i += 1;
		} else if (flag === "--auth-user") {
			args.authUser = value;
			i += 1;
		} else if (flag === "--auth-pass") {
			args.authPass = value;
			i += 1;
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.baseUrl) {
	console.error("引数エラー: --base-url は必須です");
	process.exit(2);
}
const baseUrl = args.baseUrl.replace(/\/+$/, "");

const authHeader = buildBasicAuthHeader(
	args.authUser ?? process.env.SMOKE_AUTH_USER ?? null,
	args.authPass ?? process.env.SMOKE_AUTH_PASS ?? null,
);

const path = args.url
	? `/api/auth/cookies?url=${encodeURIComponent(args.url)}`
	: "/api/auth/cookies";

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
try {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "DELETE",
		headers: authHeader ? { authorization: authHeader } : undefined,
		signal: controller.signal,
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	console.log(
		JSON.stringify(
			{
				httpStatus: res.status,
				...(typeof body === "object" ? body : { body }),
			},
			null,
			2,
		),
	);
	process.exit(res.status === 200 ? 0 : 1);
} catch (cause) {
	console.error(`接続失敗: ${String(cause)}`);
	process.exit(1);
} finally {
	clearTimeout(timer);
}
