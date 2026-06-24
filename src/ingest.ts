// 取込 → 永続化の結線（#26）。各取込経路（/fetch・/paste・将来の queue consumer）が共有する。
//
// なぜこのモジュールが存在するか:
// - 抽出結果を jobs / extractions（#16 スキーマ）へ INSERT し、生 HTML を R2 へ保存（#17）、
//   取込後に scores を生成（#20）するまでを 1 経路に束ねる。これが無いと取込→ranking の
//   DoD 一気通貫が成立しない（#70 live 検証で判明）。
// - 抽出とスコアリングの分離（§5.3）は保つ: 抽出は 1 回だけ実行・保存し、スコアは保存済み
//   抽出から rescoreOne で決定的に算出する（重み・希望値の変更で AI を再実行しない）。
// - 表示は呼び出し側（handler）の責務。本モジュールは永続化に専念し HTML を組み立てない（§9）。

import type { AiRunner } from "./ai";
import {
	type ExtractionStatus,
	type JobSourceType,
	TABLE_NAMES,
} from "./db-schema";
import { extractJob } from "./extract";
import type { NormalizedJob } from "./job-schema";
import {
	linkRawHtmlToJob,
	putRawHtml,
	type RawHtmlBucket,
} from "./raw-html-store";
import { rescoreOne } from "./rescore";
import type { ScoreResult } from "./score";
import { trimHtml } from "./trim-html";

// 構造化機構の識別子（#65）。現状は Workers AI JSON Mode のみ。フォーク先で増やせる。
export const EXTRACTION_MECHANISM = "json-mode";

// 取込に必要な依存。id/時刻は注入可能にしてユニットテストを決定的にする。
export interface IngestDeps {
	db: D1Database;
	bucket: RawHtmlBucket;
	ai: AiRunner;
	// 既定は crypto.randomUUID。jobs / extractions の id 採番に使う。
	newId?: () => string;
	// 既定は現在 unix 秒。fetched_at / extracted_at に使う。
	now?: () => number;
}

// 取込入力。sourceUrl は detail/listing で必須、paste では合成する。
export interface IngestInput {
	html: string;
	sourceType: JobSourceType;
	sourceUrl?: string;
}

// 取込結果。handler は score / job を渡して結果ページを描画する。
export interface IngestResult {
	jobId: string;
	job: NormalizedJob;
	score: ScoreResult;
	extractionStatus: ExtractionStatus;
}

// extract.ts の status（ok / extraction_failed）を DB の extraction_status（ok / failed）へ寄せる。
// extraction_failed は抽出全体が壊れた状態で、unknown 中立とは別軸（#65→#20）。
function toDbStatus(status: "ok" | "extraction_failed"): ExtractionStatus {
	return status === "extraction_failed" ? "failed" : "ok";
}

// 取込元 URL から既存 job を引く。同一 URL の再取込で新 job を作らず履歴を 1 job に集約する。
async function findJobIdByUrl(
	db: D1Database,
	sourceUrl: string,
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT id FROM ${TABLE_NAMES.jobs} WHERE source_url = ?`)
		.bind(sourceUrl)
		.first<{ id: string }>();
	return row?.id ?? null;
}

// 抽出結果を永続化し、取込後スコアまで生成する（#26 中核）。
export async function ingestJob(
	deps: IngestDeps,
	input: IngestInput,
): Promise<IngestResult> {
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const ts = now();

	// 抽出は 1 回だけ実行する（§5.3）。本文が空でも extractJob が全 unknown を返す。
	const extraction = await extractJob(deps.ai, trimHtml(input.html));
	const dbStatus = toDbStatus(extraction.status);

	// jobs 行を確定する。paste は安定した識別子を持たないため job ごとに合成 URL を採番する。
	let jobId: string;
	let sourceUrl: string;
	if (input.sourceType === "paste") {
		jobId = newId();
		sourceUrl = `paste:${jobId}`;
		await insertJob(deps.db, jobId, sourceUrl, "paste", ts);
	} else {
		// detail/listing は取得元 URL を一次キーに同一 job へ集約する（再取込は履歴追加）。
		const url = input.sourceUrl ?? "";
		const existing = await findJobIdByUrl(deps.db, url);
		if (existing === null) {
			jobId = newId();
			await insertJob(deps.db, jobId, url, input.sourceType, ts);
		} else {
			jobId = existing;
			await deps.db
				.prepare(`UPDATE ${TABLE_NAMES.jobs} SET fetched_at = ? WHERE id = ?`)
				.bind(ts, jobId)
				.run();
		}
		sourceUrl = url;
	}

	// 抽出結果を保存（再スコアリングはこれを読む。AI は再実行しない・§5.3）。
	await deps.db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.extractions}
			 (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId(),
			jobId,
			JSON.stringify(extraction.job),
			extraction.model,
			EXTRACTION_MECHANISM,
			dbStatus,
			ts,
		)
		.run();

	// 生 HTML を R2 に保存し jobs.raw_html_r2_key へ紐付ける（#17）。
	const { key } = await putRawHtml(
		deps.bucket,
		jobId,
		input.html,
		input.sourceType === "paste" ? {} : { sourceUrl },
	);
	await linkRawHtmlToJob(deps.db, jobId, key);

	// 取込後スコアを生成する（保存済み抽出から決定的に・§5.3 / §8）。
	const scored = await rescoreOne(deps.db, jobId);

	// パイプライン状態を更新する（failed は failed、それ以外はスコア済み）。
	const finalStatus = dbStatus === "failed" ? "failed" : "scored";
	await deps.db
		.prepare(`UPDATE ${TABLE_NAMES.jobs} SET status = ? WHERE id = ?`)
		.bind(finalStatus, jobId)
		.run();

	return {
		jobId,
		job: extraction.job,
		// rescoreOne は直前に保存した抽出を必ず読めるため null にならない（防御的に空スコアへ畳む）。
		score: scored?.score ?? { total: null, breakdown: [] },
		extractionStatus: dbStatus,
	};
}

// jobs 行を初期状態（fetched）で INSERT する。status は取込完了時に更新する。
async function insertJob(
	db: D1Database,
	jobId: string,
	sourceUrl: string,
	sourceType: JobSourceType,
	fetchedAt: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.jobs}
			 (id, source_url, source_type, status, fetched_at)
			 VALUES (?, ?, ?, 'fetched', ?)`,
		)
		.bind(jobId, sourceUrl, sourceType, fetchedAt)
		.run();
}
