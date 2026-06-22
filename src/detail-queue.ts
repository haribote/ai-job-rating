// 一覧から抽出した複数詳細 URL を非同期で取得・抽出するための Queues 配線層（#24）。
// 責務は「producer/consumer の配線とエラー分類」のみ: 取得（#21 fetch-html）・抽出（#11 extraction-pipeline）は
// 注入された deps 経由で呼び、この層には持ち込まない（抽出↔スコアリング分離 §5.3 を侵さない）。
// メッセージ整形・バッチ分割・リトライ判定はすべて決定的（同一入力→同一出力）にしてユニットテストで担保する（§8）。
// 実 binding 依存の producer→consumer・リトライ/DLQ 動作はオフライン不能のため要手動検証（Draft PR 参照）。

import { FetchHtmlError } from "./fetch-html";
import type { PageClassification } from "./list-detail";

// キューに積む 1 ジョブ = 1 詳細 URL。structured clone 可能なプレーンオブジェクトに限る（Queues 制約）。
// listUrl は出自（どの一覧から来たか）を持たせ、consumer 側のロギング・将来の集計に使う。
export interface DetailJobMessage {
	url: string;
	listUrl: string;
}

// producer が依存する Queue binding の最小契約。実型（Queue<DetailJobMessage>）は構造的に適合する。
// テストではこのインターフェースをモックし、実 binding なしで投入内容を検証する。
// sendBatch のみ使う（複数詳細を 1 リクエストで投入する）。単発 send は呼び口がないため持たない。
export interface DetailQueue {
	sendBatch(messages: Iterable<{ body: DetailJobMessage }>): Promise<void>;
}

// sendBatch の 1 リクエスト上限（Cloudflare Queues: 1 バッチ最大 100 メッセージ）。
// detailUrls がこれを超える一覧でも投入できるようチャンク分割する。
const MAX_SEND_BATCH = 100;

// PageClassification を 1 URL = 1 メッセージへ展開する（決定的・出現順保持）。
// list は detailUrls をそのまま、detail は baseUrl 自身を 1 件として、同じ非同期経路に乗せる。
export function toDetailJobMessages(
	classification: PageClassification,
	baseUrl: string,
): DetailJobMessage[] {
	if (classification.kind === "detail") {
		return [{ url: baseUrl, listUrl: baseUrl }];
	}
	return classification.detailUrls.map((url) => ({ url, listUrl: baseUrl }));
}

// 配列を size ごとのチャンクへ分割する（sendBatch の 100 件上限対応）。
function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// producer: classification の全詳細 URL をキューへ投入し、投入件数を返す。
// 0 件のときは空 batch 送信を避けて即 0 を返す。100 件超は MAX_SEND_BATCH ごとに分割送信する。
export async function enqueueDetailJobs(
	queue: DetailQueue,
	classification: PageClassification,
	baseUrl: string,
): Promise<number> {
	const messages = toDetailJobMessages(classification, baseUrl);
	if (messages.length === 0) {
		return 0;
	}
	for (const part of chunk(messages, MAX_SEND_BATCH)) {
		await queue.sendBatch(part.map((body) => ({ body })));
	}
	return messages.length;
}

// 失敗が再試行する価値があるか（retryable）を決定的に分類する。
// timeout / network / 5xx は一過性なので retry、3xx・4xx は恒久的なので permanent。
// FetchHtmlError 以外（抽出層の想定外例外など）は情報がないため安全側に倒して retryable とする。
export function classifyRetryable(error: unknown): boolean {
	if (!(error instanceof FetchHtmlError)) {
		return true;
	}
	if (error.kind === "http") {
		// 5xx は上流の一時障害として再試行する。3xx（follow 不能なリダイレクト）・4xx は
		// 再試行しても回復しない恒久的失敗。status 不明（0）は安全側に倒して再試行する。
		const status = error.status ?? 0;
		return status === 0 || status >= 500;
	}
	// timeout / network は一過性
	return true;
}

// consumer が 1 メッセージを処理するために注入する依存。
// 取得＋抽出（＋将来の保存）を 1 関数に畳み、この配線層は中身を知らない（責務分離）。
export interface ProcessDetailDeps {
	process(job: DetailJobMessage): Promise<void>;
}

// ack/retry を持つ 1 メッセージの最小契約（実 Message<DetailJobMessage> が構造的に適合する）。
interface DetailMessage {
	readonly id: string;
	readonly body: DetailJobMessage;
	ack(): void;
	retry(): void;
}

// consumer が受け取る batch の最小契約（実 MessageBatch<DetailJobMessage> が構造的に適合する）。
interface DetailMessageBatch {
	readonly queue: string;
	readonly messages: readonly DetailMessage[];
}

// consumer: batch 内の各メッセージを個別に try/catch で隔離して処理する。
// - 成功: ack（再配信させない）
// - retryable な失敗: retry（runtime が max_retries まで再配信、超過で DLQ）
// - permanent な失敗: ack（無駄な再試行を避け、無限 retry/DLQ 蓄積を防ぐ）
// 個別 try/catch により 1 件の失敗が batch 全体の再配信を引き起こすのを避ける（Queues の定石）。
export async function processDetailBatch(
	batch: DetailMessageBatch,
	deps: ProcessDetailDeps,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			await deps.process(message.body);
			message.ack();
		} catch (error) {
			if (classifyRetryable(error)) {
				message.retry();
			} else {
				// 恒久的失敗は再試行しても無駄なので確定的に落とす。失敗の記録は後続 #26 が担う。
				message.ack();
			}
		}
	}
}
