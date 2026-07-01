// #116 deploy 後 live スモークの薄い I/O ラッパ。
//
// なぜ存在するか:
// - unit test / dry-run では検出できない runtime-only バグ（変数化した dynamic import の未バンドル
//   → "No such module"、compat date 既定超過、binding 未解決など。実例: PR #74）を deploy 直後に検出する。
// - Workers の binding・Claude API・Browser Rendering は live でしか叩けないため、deploy 済み URL へ
//   実リクエストして到達性を確かめる。純粋ロジック（引数/レスポンス解釈・合否）は
//   src/server/smoke/live-smoke.ts に集約しユニットテスト済み。本スクリプトは fetch して流すだけに留める。
//
// 前提（ユーザーが用意・Claude は .dev.vars / secret に触れない）:
// - `npm run deploy` 済みで公開 URL がある。
// - 評判検証する場合は `wrangler secret put ANTHROPIC_API_KEY`、Workers AI / Browser Rendering を有効化。
//
// 実行:
//   npm run smoke -- --base-url https://<deployed> [--spa-url <SPA求人URL>] [--company-id <id>] [--core-only]
//
// 段階化＋既定フル: health→ai-health→最小抽出→(reputation D1)→(Claude 評判)→(BR dynamic import) を試行。
// 前提（キー/URL/id）が欠ける項目は理由付き SKIP、fail が 1 つでもあれば非ゼロ終了。
// 応答上限は --timeout-ms（既定 120s）で調整する。本番 D1 に残したジョブは末尾で cleanup SQL を案内する。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const {
	buildSmokeHtml,
	decideExitCode,
	formatSmokeReport,
	interpretAiHealth,
	interpretBrowserRender,
	interpretExtraction,
	interpretHealth,
	interpretJobDetail,
	interpretReputation,
	interpretReputationConfig,
	interpretReputationSources,
	parseSmokeArgs,
} = await import(resolve(root, "src/server/smoke/live-smoke.ts"));

const args = parseSmokeArgs(process.argv.slice(2));
// 応答上限は --timeout-ms（検証済み・既定 120s）を単一の情報源にする。
const timeoutMs = args.timeoutMs;

if (args.errors.length > 0) {
	for (const e of args.errors) console.error(`引数エラー: ${e}`);
	process.exit(2);
}

// timeout 付き fetch。timeout 欠落での無限待ちを避ける（過去バグ対策）。
// 接続失敗・timeout は { status: 0, body } に畳み込み、解釈側が fail 判定できるようにする。
async function request(method, path, jsonBody) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${args.baseUrl}${path}`, {
			method,
			headers: jsonBody ? { "content-type": "application/json" } : undefined,
			body: jsonBody ? JSON.stringify(jsonBody) : undefined,
			signal: controller.signal,
		});
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: res.status, body };
	} catch (cause) {
		return { status: 0, body: `接続失敗: ${String(cause)}` };
	} finally {
		clearTimeout(timer);
	}
}

const results = [];
const push = (id, label, interpretation) =>
	results.push({ id, label, ...interpretation });
// full チェックの前提が欠けたときの明示 SKIP。
const skip = (id, label, detail) =>
	results.push({ id, label, outcome: "skip", detail });

// 1. health（binding 不要の到達性）
{
	const { status, body } = await request("GET", "/api/health");
	push("health", "GET /api/health", interpretHealth(status, body));
}

// 2. ai-health（AI binding 解決＋最小推論）
{
	const { status, body } = await request("GET", "/api/ai-health");
	push("ai-health", "GET /api/ai-health", interpretAiHealth(status, body));
}

// live 実行が本番 D1 に残したジョブ id を全て集める（最小抽出＋BR）。末尾で一括 cleanup を案内する。
const createdJobIds = [];

// 3. 最小抽出（AI＋D1＋R2）。成功した jobId は cleanup 用に記録・表示する。
let smokeJobId = null;
{
	const { status, body } = await request("POST", "/api/jobs", {
		html: buildSmokeHtml(),
	});
	const interpretation = interpretExtraction(status, body);
	push("extraction", "POST /api/jobs {html}", interpretation);
	if (interpretation.outcome === "pass") {
		smokeJobId = body.jobId;
		createdJobIds.push(body.jobId);
	}
}

// 4. ジョブ詳細（永続化＋スコアリング）
if (smokeJobId) {
	const { status, body } = await request("GET", `/api/jobs/${smokeJobId}`);
	push("job-detail", "GET /api/jobs/:id", interpretJobDetail(status, body));
} else {
	skip("job-detail", "GET /api/jobs/:id", "最小抽出が失敗し jobId 未取得");
}

// 5. ANTHROPIC_API_KEY binding の presence
let reputationConfigOk = false;
let apiKeyConfigured = false;
{
	const { status, body } = await request("GET", "/api/reputation/config");
	const interpretation = interpretReputationConfig(status, body);
	push("reputation-config", "GET /api/reputation/config", interpretation);
	if (interpretation.outcome === "pass") {
		reputationConfigOk = true;
		apiKeyConfigured = body.apiKeyConfigured === true;
	}
}

// 6. reputation D1 到達性（課金なし）
{
	const { status, body } = await request("GET", "/api/reputation/sources");
	push(
		"reputation-sources",
		"GET /api/reputation/sources",
		interpretReputationSources(status, body),
	);
}

// 7. Claude API web_search（課金・full かつ前提が揃うときのみ）
if (args.coreOnly) {
	skip("reputation", "POST /api/companies/:id/reputation", "--core-only 指定");
} else if (!reputationConfigOk) {
	// config チェック自体が FAIL のときはキー有無を判定できない。誤って「未設定」と断じない。
	skip(
		"reputation",
		"POST /api/companies/:id/reputation",
		"reputation-config が FAIL のため判定不可（Claude web_search 未検証）",
	);
} else if (!apiKeyConfigured) {
	skip(
		"reputation",
		"POST /api/companies/:id/reputation",
		"ANTHROPIC_API_KEY 未設定（Claude web_search 未検証）",
	);
} else if (!args.companyId) {
	skip(
		"reputation",
		"POST /api/companies/:id/reputation",
		"--company-id 未指定（company 発見 API が無く id はユーザー供給。Claude web_search 未検証）",
	);
} else {
	const { status, body } = await request(
		"POST",
		`/api/companies/${args.companyId}/reputation`,
	);
	push(
		"reputation",
		"POST /api/companies/:id/reputation",
		interpretReputation(status, body),
	);
}

// 8. BR dynamic import（full かつ --spa-url があるときのみ）。成功した jobId も cleanup 対象。
if (args.coreOnly) {
	skip("browser-render", "POST /api/jobs {url:SPA}", "--core-only 指定");
} else if (!args.spaUrl) {
	skip(
		"browser-render",
		"POST /api/jobs {url:SPA}",
		"--spa-url 未指定（dynamic import 未検証）",
	);
} else {
	const { status, body } = await request("POST", "/api/jobs", {
		url: args.spaUrl,
	});
	push(
		"browser-render",
		"POST /api/jobs {url:SPA}",
		interpretBrowserRender(status, body),
	);
	// BR チェックも 201 で本番 D1 にジョブ行を残すため cleanup 対象に含める。
	if (status >= 200 && status < 300 && body && typeof body.jobId === "string") {
		createdJobIds.push(body.jobId);
	}
}

console.log("");
console.log(formatSmokeReport(results));
if (createdJobIds.length > 0) {
	// 残置ジョブ（最小抽出＋BR）を一括削除する SQL を案内する（extractions/scores は ON DELETE CASCADE）。
	const idList = createdJobIds.map((id) => `'${id}'`).join(", ");
	console.log("");
	console.log(
		`残置した ${createdJobIds.length} 件のジョブの cleanup: wrangler d1 execute ai-job-rating --remote --command "DELETE FROM jobs WHERE id IN (${idList})"`,
	);
}

process.exit(decideExitCode(results));
