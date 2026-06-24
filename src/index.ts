import type { Bindings } from "./app";
import app from "./app";
import {
	type DetailJobMessage,
	type ProcessDetailDeps,
	processDetailBatch,
} from "./detail-queue";
import { fetchHtml } from "./fetch-html";
import { ingestJob } from "./ingest";

// consumer(#24) が 1 詳細ジョブを処理するための deps を env から束ねる。
// 取得（#21 fetch-html）→ 取込→永続化（#26 ingestJob: jobs/extractions/R2/scores）を配線し、
// 重い IO はここに集約する。コアの配線層（detail-queue）はモック可能に保つため env 依存をこの builder に閉じ込める。
// 永続化まで通すことで、一覧→非同期取得→ranking 反映の DoD 一気通貫が queue 経路でも成立する。
function buildProcessDeps(env: Bindings): ProcessDetailDeps {
	return {
		process: async (job: DetailJobMessage) => {
			const { html } = await fetchHtml(job.url);
			// 取得した詳細 HTML を取込→永続化する（同期経路 /fetch と同じ ingestJob を共有）。
			// 失敗時は ingestJob 内で extraction_status=failed として保存され、例外は呼び出し元
			// （processDetailBatch）が retry/ack 分類する。
			await ingestJob(
				{ ai: env.AI, db: env.DB, bucket: env.RAW_HTML },
				{ html, sourceType: "detail", sourceUrl: job.url },
			);
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
