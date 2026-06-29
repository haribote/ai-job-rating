import { describe, expect, it, vi } from "vitest";
import {
	createSemaphore,
	createTokenBucket,
	mapWithConcurrency,
	retryWithBackoff,
} from "./rate-concurrency";

// 同時実行セマフォ（決定的）: in-flight 数が上限を超えないことを担保する。
// #24(Queues) が取得/抽出ワーカーへ投入する際の同時実行枠を提供するユニット。
describe("createSemaphore", () => {
	// 上限内なら acquire は即時に解放関数を返す
	it("上限内の acquire は待たずに解放関数を返す", async () => {
		const sem = createSemaphore(2);
		const release1 = await sem.acquire();
		const release2 = await sem.acquire();
		expect(typeof release1).toBe("function");
		expect(typeof release2).toBe("function");
	});

	// 上限超過の acquire は先行 release まで保留される
	it("上限を超える acquire は release されるまで保留される", async () => {
		const sem = createSemaphore(1);
		const release1 = await sem.acquire();

		let acquired = false;
		const pending = sem.acquire().then((release) => {
			acquired = true;
			return release;
		});

		// release 前は 2 件目が解決しない
		await Promise.resolve();
		expect(acquired).toBe(false);

		release1();
		await pending;
		expect(acquired).toBe(true);
	});

	// 同時に走る数が決して上限を超えないこと（最重要の不変条件）
	it("同時 in-flight 数が上限を超えない", async () => {
		const sem = createSemaphore(3);
		let inFlight = 0;
		let peak = 0;

		const task = async () => {
			const release = await sem.acquire();
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			// マイクロタスクを跨いで占有を維持する
			await Promise.resolve();
			await Promise.resolve();
			inFlight -= 1;
			release();
		};

		await Promise.all(Array.from({ length: 10 }, task));
		expect(peak).toBeLessThanOrEqual(3);
	});

	// 解放を二重に呼んでも枠が増殖しない（冪等）
	it("release の二重呼び出しは枠を増やさない", async () => {
		const sem = createSemaphore(1);
		const release = await sem.acquire();
		release();
		release();

		let secondAcquired = 0;
		await sem.acquire().then(() => {
			secondAcquired += 1;
		});
		// 余分な枠が生まれていれば 2 件取得できてしまう
		let thirdAcquired = false;
		const third = sem.acquire().then(() => {
			thirdAcquired = true;
		});
		await Promise.resolve();
		expect(secondAcquired).toBe(1);
		expect(thirdAcquired).toBe(false);
		void third;
	});

	// limit が 1 未満は不正（誤設定を即座に弾く）
	it("limit が 1 未満なら例外を投げる", () => {
		expect(() => createSemaphore(0)).toThrow();
	});
});

// トークンバケット（決定的・時刻注入）: 単位時間あたりの取得回数を制限する。
// 時刻は now() 注入で固定し、実時間に依存せずテストする。
describe("createTokenBucket", () => {
	// 初期は capacity 個のトークンを持ち、その回数まで即座に消費できる
	it("初期 capacity 個まで連続消費できる", () => {
		const now = 1000;
		const bucket = createTokenBucket({
			capacity: 2,
			refillTokens: 1,
			refillIntervalMs: 1000,
			now: () => now,
		});
		expect(bucket.tryRemove()).toBe(true);
		expect(bucket.tryRemove()).toBe(true);
		// 3 回目は枯渇して失敗する
		expect(bucket.tryRemove()).toBe(false);
	});

	// 時間が経過すると refillTokens/refillIntervalMs の割合で補充される
	it("経過時間に応じてトークンを補充する", () => {
		let now = 0;
		const bucket = createTokenBucket({
			capacity: 1,
			refillTokens: 1,
			refillIntervalMs: 1000,
			now: () => now,
		});
		expect(bucket.tryRemove()).toBe(true);
		expect(bucket.tryRemove()).toBe(false);
		// 1 間隔ぶん経過 → 1 トークン補充
		now = 1000;
		expect(bucket.tryRemove()).toBe(true);
	});

	// 補充は capacity を超えて貯まらない（バースト上限の担保）
	it("補充は capacity を超えない", () => {
		let now = 0;
		const bucket = createTokenBucket({
			capacity: 2,
			refillTokens: 1,
			refillIntervalMs: 1000,
			now: () => now,
		});
		// 長時間放置しても capacity ぶんしか消費できない
		now = 100_000;
		expect(bucket.tryRemove()).toBe(true);
		expect(bucket.tryRemove()).toBe(true);
		expect(bucket.tryRemove()).toBe(false);
	});

	// 次にトークンが利用可能になる時刻を返す（待機時間の決定的算出に使う）
	it("枯渇時は次に補充される時刻を返す", () => {
		const now = 500;
		const bucket = createTokenBucket({
			capacity: 1,
			refillTokens: 1,
			refillIntervalMs: 1000,
			now: () => now,
		});
		bucket.tryRemove();
		// 直近補充時刻 500 + 間隔 1000 = 1500
		expect(bucket.nextAvailableAt()).toBe(1500);
	});

	// トークンに余裕がある間は now をそのまま返す（待機不要）
	it("トークンがあれば nextAvailableAt は現在時刻", () => {
		const now = 500;
		const bucket = createTokenBucket({
			capacity: 2,
			refillTokens: 1,
			refillIntervalMs: 1000,
			now: () => now,
		});
		bucket.tryRemove();
		expect(bucket.nextAvailableAt()).toBe(500);
	});

	// 不正な設定（capacity<1 等）は即座に弾く
	it("capacity が 1 未満なら例外を投げる", () => {
		expect(() =>
			createTokenBucket({
				capacity: 0,
				refillTokens: 1,
				refillIntervalMs: 1000,
			}),
		).toThrow();
	});
});

// 取得/抽出の一括実行（決定的）: 同時実行とレートを制御しつつ全件を settled で返す。
// #24 がキュー投入の代わりに直接消費でき、#26 が成否ごとにエラー型を扱える形にする。
describe("mapWithConcurrency", () => {
	// 入力順を保って全件の結果を返す（成功は value、失敗は reason）
	it("入力順を保持して settled 結果を返す", async () => {
		const items = ["a", "b", "c"];
		const results = await mapWithConcurrency(
			items,
			async (item) => item.toUpperCase(),
			{ concurrency: 2 },
		);
		expect(results).toEqual([
			{ status: "fulfilled", index: 0, item: "a", value: "A" },
			{ status: "fulfilled", index: 1, item: "b", value: "B" },
			{ status: "fulfilled", index: 2, item: "c", value: "C" },
		]);
	});

	// 一部の task が throw しても全体は止まらず、失敗は rejected として収集される
	it("個別の失敗は rejected として収集し全体は止めない", async () => {
		const items = ["ok", "boom", "ok2"];
		const error = new Error("失敗");
		const results = await mapWithConcurrency(
			items,
			async (item) => {
				if (item === "boom") {
					throw error;
				}
				return item;
			},
			{ concurrency: 3 },
		);
		expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok" });
		expect(results[1]).toMatchObject({ status: "rejected", reason: error });
		expect(results[2]).toMatchObject({ status: "fulfilled", value: "ok2" });
	});

	// 同時に走る task 数が concurrency を超えない
	it("同時実行数が concurrency を超えない", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		await mapWithConcurrency(
			items,
			async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await Promise.resolve();
				await Promise.resolve();
				inFlight -= 1;
			},
			{ concurrency: 4 },
		);
		expect(peak).toBeLessThanOrEqual(4);
	});

	// レート制限付き: トークン枯渇時は注入 sleep で待ってから実行する（決定的）
	it("レート制限超過時は sleep を挟んで実行する", async () => {
		let now = 0;
		const sleeps: number[] = [];
		// sleep は実時間を使わず now を進める（決定的）
		const sleep = vi.fn(async (ms: number) => {
			sleeps.push(ms);
			now += ms;
		});
		const items = ["a", "b", "c"];
		const results = await mapWithConcurrency(items, async (item) => item, {
			concurrency: 1,
			rateLimit: {
				capacity: 1,
				refillTokens: 1,
				refillIntervalMs: 1000,
			},
			now: () => now,
			sleep,
		});
		// 3 件中、初回は即時、以降 2 件は 1000ms ずつ待機する
		expect(sleeps).toEqual([1000, 1000]);
		expect(results.map((r) => r.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"fulfilled",
		]);
	});

	// 空配列は何も実行せず空の結果を返す（境界）
	it("空配列は空の結果を返す", async () => {
		const task = vi.fn();
		const results = await mapWithConcurrency([], task, { concurrency: 2 });
		expect(results).toEqual([]);
		expect(task).not.toHaveBeenCalled();
	});

	// concurrency 未指定でも安全な既定値で動く（CF の同時接続上限 6 を超えない）
	it("concurrency 既定値で動作する", async () => {
		const results = await mapWithConcurrency(["x"], async (i) => i, {});
		expect(results).toEqual([
			{ status: "fulfilled", index: 0, item: "x", value: "x" },
		]);
	});

	// concurrency が CF の同時接続上限(6)を超える指定は弾く（誤設定の早期検出）
	it("concurrency が同時接続上限を超えると例外を投げる", async () => {
		await expect(
			mapWithConcurrency(["x"], async (i) => i, { concurrency: 7 }),
		).rejects.toThrow();
	});
});

// 一過性失敗のバックオフ再試行（決定的・sleep 注入）: transient/504 の取得失敗を時間を置いて再試行する。
// 待機は注入 sleep で実時間に依存せずテストし、再試行可否は isRetryable で判定する（恒久失敗は無駄に叩かない）。
describe("retryWithBackoff", () => {
	// 初回成功なら再試行せずそのまま値を返す（成功経路は遅延ゼロ）
	it("初回成功なら sleep せず結果を返す", async () => {
		const sleep = vi.fn(async () => {});
		const task = vi.fn(async () => "ok");
		const result = await retryWithBackoff(task, {
			retries: 3,
			baseDelayMs: 100,
			isRetryable: () => true,
			sleep,
		});
		expect(result).toBe("ok");
		expect(task).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	// 一過性失敗は指数バックオフで待ってから再試行し、回復したら成功を返す
	it("再試行対象の失敗は指数バックオフで待って回復する", async () => {
		const sleeps: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			sleeps.push(ms);
		});
		let calls = 0;
		const task = vi.fn(async () => {
			calls += 1;
			if (calls < 3) {
				throw new Error("transient");
			}
			return "recovered";
		});
		const result = await retryWithBackoff(task, {
			retries: 3,
			baseDelayMs: 100,
			factor: 2,
			isRetryable: () => true,
			sleep,
		});
		expect(result).toBe("recovered");
		expect(task).toHaveBeenCalledTimes(3);
		// 初回失敗後 100ms、2 回目失敗後 200ms（指数）の順で待つ
		expect(sleeps).toEqual([100, 200]);
	});

	// 再試行回数を使い切ったら最後の失敗を throw する（無限再試行しない）
	it("retries を超えたら最後の失敗を投げる", async () => {
		const sleep = vi.fn(async () => {});
		const error = new Error("always fails");
		const task = vi.fn(async () => {
			throw error;
		});
		await expect(
			retryWithBackoff(task, {
				retries: 2,
				baseDelayMs: 100,
				isRetryable: () => true,
				sleep,
			}),
		).rejects.toBe(error);
		// 初回 + 再試行 2 回 = 3 回
		expect(task).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	// 再試行対象外（恒久失敗）は待たず即座に投げる（4xx を無駄に叩かない）
	it("再試行対象外の失敗は即座に投げる", async () => {
		const sleep = vi.fn(async () => {});
		const error = new Error("permanent");
		const task = vi.fn(async () => {
			throw error;
		});
		await expect(
			retryWithBackoff(task, {
				retries: 3,
				baseDelayMs: 100,
				isRetryable: () => false,
				sleep,
			}),
		).rejects.toBe(error);
		expect(task).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	// maxDelayMs で指数増加を頭打ちにする（暴走待機の防止）
	it("maxDelayMs を超える待機は頭打ちにする", async () => {
		const sleeps: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			sleeps.push(ms);
		});
		const task = vi.fn(async () => {
			throw new Error("transient");
		});
		await expect(
			retryWithBackoff(task, {
				retries: 3,
				baseDelayMs: 100,
				factor: 10,
				maxDelayMs: 500,
				isRetryable: () => true,
				sleep,
			}),
		).rejects.toThrow();
		// 100 → 1000(→500 にクランプ) → 500 にクランプ
		expect(sleeps).toEqual([100, 500, 500]);
	});

	// retries が負なら誤設定として弾く
	it("retries が負なら例外を投げる", async () => {
		await expect(
			retryWithBackoff(async () => "x", {
				retries: -1,
				baseDelayMs: 100,
				isRetryable: () => true,
			}),
		).rejects.toThrow();
	});
});
