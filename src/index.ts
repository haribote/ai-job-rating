import type { Bindings } from "./app";
import app from "./app";
import {
	type DetailJobMessage,
	type ProcessDetailDeps,
	processDetailBatch,
} from "./detail-queue";
import { runExtractionPipeline } from "./extraction-pipeline";
import { fetchHtml } from "./fetch-html";

// consumer(#24) が 1 詳細ジョブを処理するための deps を env から束ねる。
// 取得（#21 fetch-html）→ 抽出パイプライン（#11 extraction-pipeline）を配線し、重い IO はここに集約する。
// コアの配線層（detail-queue）はモック可能に保つため、env 依存はこの builder に閉じ込める。
// Phase 0 は永続化なし: 抽出結果の保存は後続 #26 が担うため、ここでは取得・抽出の到達性のみ確認する。
function buildProcessDeps(env: Bindings): ProcessDetailDeps {
	return {
		process: async (job: DetailJobMessage) => {
			const { html } = await fetchHtml(job.url);
			// runExtractionPipeline は表示用 HTML を返すが、永続化は #26 のスコープ。
			// ここでは取得→抽出が通ること（例外を投げないこと）を担保する経路として呼ぶ。
			await runExtractionPipeline(env.AI, html);
		},
	};
}

// Worker のエントリポイント。fetch（SSR・静的資産）と queue（詳細ジョブ consumer）を兼ねる。
// アプリ本体は app.ts に分離してテスト可能にし、配線層は detail-queue.ts に分離してモック可能にしている。
export default {
	fetch: app.fetch,
	// push consumer。ack/retry の隔離方針は detail-queue.processDetailBatch に委譲する。
	async queue(
		batch: MessageBatch<DetailJobMessage>,
		env: Bindings,
	): Promise<void> {
		await processDetailBatch(batch, buildProcessDeps(env));
	},
} satisfies ExportedHandler<Bindings, DetailJobMessage>;
