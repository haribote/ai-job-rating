// #106 抽出モデル live golden eval ランナーの薄い I/O ラッパ。
//
// なぜ存在するか:
// - env.AI は workerd 内でしか叩けず、golden 実体は PII（gitignore）でディスク上にしか無い。
//   そこで「ディスクから golden を読む driver（Node）」と「AI を叩く dev 限定 route（Worker）」へ分離する。
//   driver は curl/inline fetch を避け node 実行で localhost を叩く（context-mode hook 対策）。
// - 純粋ロジック（ケース収集・ModelSelection 整形）は src/server/extract/eval-driver.ts に集約しユニットテスト済み。
//   本スクリプトは「golden を読む・POST する・整形して表示する・生 JSON を保存する」だけに留める。
//
// 前提（ユーザーが用意・Claude は .dev.vars に触れない）:
// - .dev.vars に EXTRACTION_EVAL=1 と Workers AI を呼べる account 認証を置く。
// - dev サーバを起動する（npm run dev、または wrangler dev）。
// - test-fixtures/golden/ に golden 実体（*.json）を配置する（PII あり・gitignore）。
//
// 実行: node scripts/eval/eval-models.mjs [--port 8787] [--out eval-result.json]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const { selectGoldenFiles, formatModelSelection, EVAL_REQUEST_TIMEOUT_MS } =
	await import(resolve(root, "src/server/extract/eval-driver.ts"));

// JSON を POST して { status, text } を返す。global fetch は使わない:
// undici 既定 headersTimeout=300s では、route が baseline+候補を全件実行してから応答する設計（実測 ~910s）に
// 対し応答前に必ず切れる。node:http は応答に既定タイムアウトが無く、暴走防止の上限だけ与えれば長時間 eval を待てる。
function postJson(url, payload, timeoutMs) {
	const u = new URL(url);
	const data = JSON.stringify(payload);
	return new Promise((resolvePromise, reject) => {
		const req = httpRequest(
			{
				hostname: u.hostname,
				port: u.port,
				path: u.pathname,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(data),
				},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () => resolvePromise({ status: res.statusCode, text }));
			},
		);
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`応答が ${timeoutMs}ms を超えました`));
		});
		req.write(data);
		req.end();
	});
}

// 引数を最小限にパースする（--port / --out）。
function parseArgs(argv) {
	const args = {
		port: process.env.EVAL_PORT ?? "8787",
		out: "eval-result.json",
	};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--port") {
			i += 1;
			args.port = argv[i];
		} else if (argv[i] === "--out") {
			i += 1;
			args.out = argv[i];
		}
	}
	return args;
}

const { port, out } = parseArgs(process.argv.slice(2));

// 応答待ち上限（ms）。既定は eval-driver.ts の EVAL_REQUEST_TIMEOUT_MS。reasoning モデルで延びる場合に
// コード変更なく延ばせるよう環境変数 EVAL_REQUEST_TIMEOUT_MS で上書きできる。
const requestTimeoutMs =
	Number(process.env.EVAL_REQUEST_TIMEOUT_MS) || EVAL_REQUEST_TIMEOUT_MS;

const goldenDir = resolve(root, "test-fixtures/golden");
if (!existsSync(goldenDir)) {
	console.error(`golden ディレクトリが見つかりません: ${goldenDir}`);
	process.exit(1);
}

// golden JSON（実体 *.json と雛形 *.example.json）を読み、生 JSON 配列へ。検証は route 側 parseGoldenCase が担う。
const files = selectGoldenFiles(readdirSync(goldenDir));
if (files.length === 0) {
	console.error(
		`golden JSON がありません（${goldenDir} に *.json を配置してください）`,
	);
	process.exit(1);
}
const cases = files.map((name) =>
	JSON.parse(readFileSync(resolve(goldenDir, name), "utf8")),
);

console.log(
	`golden ${cases.length} 件を送信: ${files.join(", ")}（応答待ち上限 ${Math.round(requestTimeoutMs / 60000)}分・進捗は dev サーバログ参照）`,
);

const url = `http://localhost:${port}/api/_eval-models`;
let res;
try {
	res = await postJson(url, { cases }, requestTimeoutMs);
} catch (cause) {
	console.error(
		`dev サーバへ接続できません（${url}）。npm run dev を起動していますか?`,
	);
	console.error(String(cause));
	process.exit(1);
}

const { status, text } = res;
if (status !== 200) {
	// 404 は EXTRACTION_EVAL 未設定（gate）の可能性が高い。
	console.error(`eval ルートが ${status} を返しました: ${text}`);
	if (status === 404) {
		console.error(
			".dev.vars に EXTRACTION_EVAL=1 を設定して dev を再起動してください。",
		);
	}
	process.exit(1);
}

const selection = JSON.parse(text);

// 生 JSON を記録用に保存（gitignore 推奨）。再現・後追い分析に使う。
const outPath = resolve(root, out);
writeFileSync(outPath, `${JSON.stringify(selection, null, 2)}\n`);

console.log("");
console.log(formatModelSelection(selection));
console.log("");
console.log(`raw ModelSelection を保存: ${outPath}`);
