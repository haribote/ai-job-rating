import { describe, expect, it, vi } from "vitest";
import {
	classifyRetryable,
	type DetailJobMessage,
	type DetailQueue,
	enqueueDetailJobs,
	type ProcessDetailDeps,
	processDetailBatch,
	toDetailJobMessages,
} from "./detail-queue";
import { FetchHtmlError } from "./fetch-html";
import type { PageClassification } from "./list-detail";

const BASE = "https://example.com/jobs";

// MessageBatch / Message を最小モックする。実 binding なしで consumer の ack/retry を検証する。
function fakeMessage(body: DetailJobMessage): {
	message: {
		id: string;
		body: DetailJobMessage;
		ack: () => void;
		retry: () => void;
	};
	ack: ReturnType<typeof vi.fn>;
	retry: ReturnType<typeof vi.fn>;
} {
	const ack = vi.fn();
	const retry = vi.fn();
	return {
		message: { id: body.url, body, ack, retry },
		ack,
		retry,
	};
}

describe("toDetailJobMessages", () => {
	// list 判定の detailUrls を 1 URL = 1 メッセージへ展開する（決定的・出現順保持）
	it("list の detailUrls を出現順で 1 件ずつメッセージ化する", () => {
		const classification: PageClassification = {
			kind: "list",
			detailUrls: [`${BASE}/1`, `${BASE}/2`, `${BASE}/3`],
		};

		const messages = toDetailJobMessages(classification, BASE);

		expect(messages).toEqual([
			{ url: `${BASE}/1`, listUrl: BASE },
			{ url: `${BASE}/2`, listUrl: BASE },
			{ url: `${BASE}/3`, listUrl: BASE },
		]);
	});

	// detail 判定はそのページ自身 1 件をジョブ化する（単一詳細も同じ非同期経路に乗せる）
	it("detail 判定は baseUrl 自身を 1 件のメッセージにする", () => {
		const classification: PageClassification = { kind: "detail" };

		const messages = toDetailJobMessages(classification, BASE);

		expect(messages).toEqual([{ url: BASE, listUrl: BASE }]);
	});

	// 空 list（閾値ロジック上は通常起きないが防御的に）は 0 件
	it("detailUrls が空なら 0 件", () => {
		const classification: PageClassification = { kind: "list", detailUrls: [] };

		expect(toDetailJobMessages(classification, BASE)).toEqual([]);
	});
});

describe("enqueueDetailJobs", () => {
	// producer は sendBatch でまとめて投入する（1 メッセージ = 1 詳細 URL）
	it("各メッセージを sendBatch の body に詰めて投入する", async () => {
		const sendBatch = vi.fn(async () => {});
		const queue: DetailQueue = { sendBatch };
		const classification: PageClassification = {
			kind: "list",
			detailUrls: [`${BASE}/1`, `${BASE}/2`],
		};

		const count = await enqueueDetailJobs(queue, classification, BASE);

		expect(count).toBe(2);
		expect(sendBatch).toHaveBeenCalledTimes(1);
		expect(sendBatch).toHaveBeenCalledWith([
			{ body: { url: `${BASE}/1`, listUrl: BASE } },
			{ body: { url: `${BASE}/2`, listUrl: BASE } },
		]);
	});

	// 0 件のときは sendBatch を呼ばない（空 batch 送信を避ける）
	it("メッセージが 0 件なら sendBatch を呼ばず 0 を返す", async () => {
		const sendBatch = vi.fn(async () => {});
		const queue: DetailQueue = { sendBatch };
		const classification: PageClassification = { kind: "list", detailUrls: [] };

		const count = await enqueueDetailJobs(queue, classification, BASE);

		expect(count).toBe(0);
		expect(sendBatch).not.toHaveBeenCalled();
	});

	// Queues の sendBatch 上限（100 件/バッチ）超過時はチャンク分割して複数回送る
	it("100 件を超える場合は 100 件ごとにチャンク分割して送る", async () => {
		const sendBatch = vi.fn<DetailQueue["sendBatch"]>(async () => {});
		const queue: DetailQueue = { sendBatch };
		const detailUrls = Array.from({ length: 250 }, (_, i) => `${BASE}/${i}`);
		const classification: PageClassification = { kind: "list", detailUrls };

		const count = await enqueueDetailJobs(queue, classification, BASE);

		expect(count).toBe(250);
		expect(sendBatch).toHaveBeenCalledTimes(3);
		expect([...sendBatch.mock.calls[0][0]]).toHaveLength(100);
		expect([...sendBatch.mock.calls[1][0]]).toHaveLength(100);
		expect([...sendBatch.mock.calls[2][0]]).toHaveLength(50);
	});
});

describe("classifyRetryable", () => {
	// 一過性失敗（timeout / network / 5xx）は再試行する価値がある
	it("timeout の FetchHtmlError は retryable", () => {
		const error = new FetchHtmlError({
			kind: "timeout",
			url: BASE,
			message: "t",
		});
		expect(classifyRetryable(error)).toBe(true);
	});

	it("network の FetchHtmlError は retryable", () => {
		const error = new FetchHtmlError({
			kind: "network",
			url: BASE,
			message: "n",
		});
		expect(classifyRetryable(error)).toBe(true);
	});

	it("5xx の http FetchHtmlError は retryable（上流の一時障害）", () => {
		const error = new FetchHtmlError({
			kind: "http",
			url: BASE,
			status: 503,
			message: "h",
		});
		expect(classifyRetryable(error)).toBe(true);
	});

	// 恒久的失敗（4xx）は再試行しても無駄なので permanent
	it("4xx の http FetchHtmlError は permanent（retryしない）", () => {
		const error = new FetchHtmlError({
			kind: "http",
			url: BASE,
			status: 404,
			message: "h",
		});
		expect(classifyRetryable(error)).toBe(false);
	});

	// follow 不能な 3xx も恒久的失敗（fetchHtml は redirect:follow だが Location 欠落等で到達しうる）
	it("3xx の http FetchHtmlError は permanent（retryしない）", () => {
		const error = new FetchHtmlError({
			kind: "http",
			url: BASE,
			status: 302,
			message: "h",
		});
		expect(classifyRetryable(error)).toBe(false);
	});

	// status 不明（0）の http は情報がないため安全側に倒して retryable
	it("status 不明（0）の http は retryable", () => {
		const error = new FetchHtmlError({ kind: "http", url: BASE, message: "h" });
		expect(classifyRetryable(error)).toBe(true);
	});

	// FetchHtmlError 以外（抽出層など想定外）は安全側に倒して retryable とする
	it("FetchHtmlError 以外の例外は retryable とみなす", () => {
		expect(classifyRetryable(new Error("boom"))).toBe(true);
	});
});

describe("processDetailBatch", () => {
	const okDeps = (): ProcessDetailDeps => ({
		process: vi.fn(async () => {}),
	});

	// 成功メッセージは ack する（再配信させない）
	it("処理成功で ack を呼ぶ", async () => {
		const m = fakeMessage({ url: `${BASE}/1`, listUrl: BASE });
		const deps = okDeps();
		const batch = { queue: "q", messages: [m.message] };

		await processDetailBatch(batch, deps);

		expect(deps.process).toHaveBeenCalledWith({
			url: `${BASE}/1`,
			listUrl: BASE,
		});
		expect(m.ack).toHaveBeenCalledTimes(1);
		expect(m.retry).not.toHaveBeenCalled();
	});

	// 一過性失敗は retry（runtime が max_retries まで再配信、超過で DLQ）
	it("retryable な失敗は retry を呼ぶ", async () => {
		const m = fakeMessage({ url: `${BASE}/1`, listUrl: BASE });
		const deps: ProcessDetailDeps = {
			process: vi.fn(async () => {
				throw new FetchHtmlError({
					kind: "timeout",
					url: `${BASE}/1`,
					message: "t",
				});
			}),
		};
		const batch = { queue: "q", messages: [m.message] };

		await processDetailBatch(batch, deps);

		expect(m.retry).toHaveBeenCalledTimes(1);
		expect(m.ack).not.toHaveBeenCalled();
	});

	// 恒久的失敗（4xx）は再試行しても無駄。ack して即落とす（無限 retry を避ける）
	it("permanent な失敗は ack して再配信させない", async () => {
		const m = fakeMessage({ url: `${BASE}/1`, listUrl: BASE });
		const deps: ProcessDetailDeps = {
			process: vi.fn(async () => {
				throw new FetchHtmlError({
					kind: "http",
					url: `${BASE}/1`,
					status: 404,
					message: "h",
				});
			}),
		};
		const batch = { queue: "q", messages: [m.message] };

		await processDetailBatch(batch, deps);

		expect(m.ack).toHaveBeenCalledTimes(1);
		expect(m.retry).not.toHaveBeenCalled();
	});

	// 1 件の失敗が他メッセージの処理を巻き込まない（batch 全体 retry を避ける = Queues の定石）
	it("1 件失敗しても他メッセージは個別に処理される", async () => {
		const ok = fakeMessage({ url: `${BASE}/ok`, listUrl: BASE });
		const bad = fakeMessage({ url: `${BASE}/bad`, listUrl: BASE });
		const deps: ProcessDetailDeps = {
			process: vi.fn(async (job: DetailJobMessage) => {
				if (job.url === `${BASE}/bad`) {
					throw new FetchHtmlError({
						kind: "network",
						url: job.url,
						message: "n",
					});
				}
			}),
		};
		const batch = { queue: "q", messages: [ok.message, bad.message] };

		await processDetailBatch(batch, deps);

		expect(ok.ack).toHaveBeenCalledTimes(1);
		expect(bad.retry).toHaveBeenCalledTimes(1);
	});
});
