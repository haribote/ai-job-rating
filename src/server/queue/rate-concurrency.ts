// 複数 URL の取得・抽出に対するレート制限と同時実行数の上限制御を提供する取得層ユニット。
// 責務は「同時実行枠の制御」と「単位時間あたりの実行回数の制御」のみ。
// 取得そのもの（#21 fetch-html）・抽出（#11）・スコアリングには踏み込まない（責務分離）。
// 時刻は now() 注入で固定し、待機は sleep() 注入で差し替えて実時間に依存せず決定的にテストする。
//
// #24（Queues）はこのユニットを「キュー投入時の同時実行枠／レート」として消費できる:
//   - createSemaphore: ワーカーごとの並列度を絞る
//   - createTokenBucket: 投入レートを単位時間あたりに制限する
//   - mapWithConcurrency: 上記を束ね、入力 URL 群を settled 結果で返すバッチ実行器
// #26（エラーハンドリング）は mapWithConcurrency の SettledResult を成否ごとに扱える。

// Cloudflare Workers は 1 invocation あたり同時に応答ヘッダ待ちできる接続が最大 6（Free/Paid 共通）。
// これを超える fetch はランタイム側でキューされるため、同時実行枠の既定・上限をこの値に合わせる。
// ref: https://developers.cloudflare.com/workers/platform/limits/ (Simultaneous open connections)
export const MAX_SIMULTANEOUS_CONNECTIONS = 6;

// 既定の同時実行数。CF の同時接続上限を超えない範囲で控えめに並列化する。
const DEFAULT_CONCURRENCY = MAX_SIMULTANEOUS_CONNECTIONS;

// 解放関数。acquire した枠を 1 つ返す。二重呼び出しは無視される（冪等）。
export type ReleaseFn = () => void;

// 同時実行セマフォ。acquire で枠を取り、返る release を呼ぶまで枠を占有する。
export interface Semaphore {
	// 枠が空くまで待ってから解放関数を返す
	acquire: () => Promise<ReleaseFn>;
	// 現在空いている枠数（テスト・監視用）
	readonly available: number;
}

// 同時実行数の上限を limit に制限するセマフォを生成する。
// limit はワーカーの並列度。1 未満は誤設定として即座に弾く。
export function createSemaphore(limit: number): Semaphore {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(
			`semaphore limit must be a positive integer: ${limit}`,
		);
	}

	let available = limit;
	// 枠待ちの解決関数キュー（FIFO で公平に枠を渡す）
	const waiters: Array<() => void> = [];

	const release: () => ReleaseFn = () => {
		// 解放は一度きり。二重呼び出しで枠が増殖しないようフラグで防ぐ。
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = waiters.shift();
			if (next) {
				// 待機者がいれば枠を直接引き継ぐ（available は据え置き）
				next();
			} else {
				available += 1;
			}
		};
	};

	const acquire = (): Promise<ReleaseFn> => {
		if (available > 0) {
			available -= 1;
			return Promise.resolve(release());
		}
		// 枠が無ければ解決を保留し、release 時に起こす
		return new Promise<ReleaseFn>((resolve) => {
			waiters.push(() => resolve(release()));
		});
	};

	return {
		acquire,
		get available() {
			return available;
		},
	};
}

// トークンバケットの設定。
export interface TokenBucketOptions {
	// バケットの最大トークン数（＝バーストで許す連続実行回数）
	capacity: number;
	// refillIntervalMs ごとに補充されるトークン数
	refillTokens: number;
	// 補充間隔（ms）
	refillIntervalMs: number;
	// 現在時刻（ms）。未指定時は Date.now。テストでは固定値を注入して決定的にする。
	now?: () => number;
}

// トークンバケット。tryRemove でトークンを 1 つ消費し、時間経過で補充する。
export interface TokenBucket {
	// トークンがあれば 1 つ消費して true、枯渇なら消費せず false
	tryRemove: () => boolean;
	// 次にトークンが利用可能になる時刻（ms）。余裕があれば現在時刻を返す。
	nextAvailableAt: () => number;
}

// 単位時間あたりの実行回数を制限するトークンバケットを生成する。
// 時間依存ロジックは now() 注入で決定的にテストできる。
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
	const { capacity, refillTokens, refillIntervalMs } = options;
	const now = options.now ?? Date.now;

	if (!Number.isInteger(capacity) || capacity < 1) {
		throw new RangeError(`capacity must be a positive integer: ${capacity}`);
	}
	if (!Number.isInteger(refillTokens) || refillTokens < 1) {
		throw new RangeError(
			`refillTokens must be a positive integer: ${refillTokens}`,
		);
	}
	if (!Number.isInteger(refillIntervalMs) || refillIntervalMs < 1) {
		throw new RangeError(
			`refillIntervalMs must be a positive integer: ${refillIntervalMs}`,
		);
	}

	let tokens = capacity;
	// 最後に補充計算を行った基準時刻。経過間隔ぶんをまとめて補充する。
	let lastRefill = now();

	// 経過した間隔の数だけトークンを補充する（capacity を上限にクランプ）。
	// 端数の間隔は lastRefill に持ち越し、補充タイミングを離散かつ決定的に保つ。
	const refill = (): void => {
		const elapsed = now() - lastRefill;
		if (elapsed < refillIntervalMs) {
			return;
		}
		const intervals = Math.floor(elapsed / refillIntervalMs);
		tokens = Math.min(capacity, tokens + intervals * refillTokens);
		lastRefill += intervals * refillIntervalMs;
	};

	const tryRemove = (): boolean => {
		refill();
		if (tokens <= 0) {
			return false;
		}
		tokens -= 1;
		return true;
	};

	const nextAvailableAt = (): number => {
		refill();
		if (tokens > 0) {
			return now();
		}
		// 次の補充は最後の補充基準時刻 + 1 間隔ぶん後
		return lastRefill + refillIntervalMs;
	};

	return { tryRemove, nextAvailableAt };
}

// バッチ実行の個別結果。Promise.allSettled に倣いつつ、入力順の index と元 item を保持し、
// 後続（#24/#26）が成否・対象 URL・原因を紐付けて扱えるようにする。
export type SettledResult<T, R> =
	| { status: "fulfilled"; index: number; item: T; value: R }
	| { status: "rejected"; index: number; item: T; reason: unknown };

// 待機関数。指定 ms だけ待つ。テストでは注入して実時間に依存せず決定的にする。
export type SleepFn = (ms: number) => Promise<void>;

export interface MapWithConcurrencyOptions {
	// 同時実行数。未指定時は DEFAULT_CONCURRENCY。CF の同時接続上限を超える指定は弾く。
	concurrency?: number;
	// レート制限。指定時は単位時間あたりの実行開始回数をトークンバケットで制限する。
	rateLimit?: Omit<TokenBucketOptions, "now">;
	// 現在時刻（ms）。レート制御の判定に使う。未指定時は Date.now。
	now?: () => number;
	// 待機関数。レート枯渇時に次の補充時刻まで待つ。未指定時は setTimeout ベース。
	sleep?: SleepFn;
}

// 実時間で待機する既定 sleep。レート制御の待ちに使う。
const defaultSleep: SleepFn = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

// items を task で並列マップする。同時実行数とレートを制御し、全件を settled で返す。
// task が throw しても全体は止めず rejected として収集する（取得失敗を後続が個別に扱える）。
// 結果は必ず入力順（index 昇順）で返る。
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	task: (item: T, index: number) => Promise<R>,
	options: MapWithConcurrencyOptions = {},
): Promise<Array<SettledResult<T, R>>> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new RangeError(
			`concurrency must be a positive integer: ${concurrency}`,
		);
	}
	// CF の同時接続上限を超える並列度は実行時にキューされ無意味なので誤設定として弾く。
	if (concurrency > MAX_SIMULTANEOUS_CONNECTIONS) {
		throw new RangeError(
			`concurrency must not exceed ${MAX_SIMULTANEOUS_CONNECTIONS} (Cloudflare simultaneous connection limit): ${concurrency}`,
		);
	}

	const results = new Array<SettledResult<T, R>>(items.length);
	if (items.length === 0) {
		return results;
	}

	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const bucket = options.rateLimit
		? createTokenBucket({ ...options.rateLimit, now })
		: null;

	const sem = createSemaphore(Math.min(concurrency, items.length));

	// レート制御: トークンが取れるまで次の補充時刻まで待つ。
	// セマフォ取得の「前」にレート判定を行い、待機中に枠を専有しないようにする。
	const awaitRateToken = async (): Promise<void> => {
		if (!bucket) {
			return;
		}
		while (!bucket.tryRemove()) {
			const waitMs = Math.max(0, bucket.nextAvailableAt() - now());
			await sleep(waitMs);
		}
	};

	const runOne = async (item: T, index: number): Promise<void> => {
		try {
			const value = await task(item, index);
			results[index] = { status: "fulfilled", index, item, value };
		} catch (reason) {
			results[index] = { status: "rejected", index, item, reason };
		}
	};

	// 各 item につき「レートトークン取得 → セマフォ枠取得 → 実行 → 解放」を回す。
	// レート判定を直列化することで、トークン消費が同時実行レースで二重取りされないようにする。
	let cursor = 0;
	const launchNext = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			await awaitRateToken();
			const release = await sem.acquire();
			await runOne(items[index], index);
			release();
		}
	};

	// concurrency 本のワーカーが共有カーソルから次の item を取り続ける（順序は index で復元）。
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		launchNext,
	);
	await Promise.all(workers);

	return results;
}
