// ランキング一覧（#18）の D1 読み出しオーケストレーション。
//
// なぜこのモジュールが存在するか:
// - 永続化された scores（#16 確定スキーマ・#20 が書き戻す）を読み、表示用の一覧ビューへ組む。
//   total/sub_score/included/weight は scores 由来をそのまま使う（UI は scores を読むだけ・
//   AI も再スコアリングも実行しない、§5.3 抽出とスコアリングの分離）。
// - 並び順は #20 の rankJobs に委ねる（スコア降順・除外を外す・total=null 末尾・同点 jobId 昇順、
//   決定的 §8）。本モジュールは順序ロジックを再実装しない。
// - ハードフィルタ除外理由（rejectedBy）は scores に永続化されないため、criteria_config と
//   保存済み抽出から決定的に再判定する。判定は rescoreJob と同じ前処理（extraction_status 反映 →
//   aiJudged 突合）を通してから passesHardFilters に渡す。さもないと failed 抽出（全項目 unknown
//   として採点・永続化済み）の ranked/excluded 振り分けが永続スコアと食い違う。AI は呼ばない。
// - 表示用の raw 値・kind は scores に持たないため、保存済み抽出（raw）と
//   NORMALIZED_KEY_KINDS（kind）から補う。DB I/O のみを担い描画は ranking-list が行う（責務分離 §9）。

import type { NormalizedJob, NormalizedKey } from "../../shared/job-schema";
import { type RankedJobView, rescoredToView } from "../ranking-list";
import {
	type CriteriaConfigRow,
	type ExtractionStatus,
	TABLE_NAMES,
	TOTAL_SCORE_CRITERION,
} from "../storage/db-schema";
import {
	buildHardFilterMap,
	buildScoringConfig,
	NORMALIZED_KEY_KINDS,
} from "./criteria-config";
import {
	applyExtractionStatus,
	applySkillMatch,
	passesHardFilters,
	type RescoredJob,
	rankJobs,
} from "./rescore-core";
import type { ScoreBreakdownRow, ScoreResult, ScoringConfig } from "./score";

// 1 求人の読み出し材料（jobs + 最新抽出）。status はハードフィルタ前処理に要る（failed→全 unknown）。
interface JobMaterial {
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly job: NormalizedJob;
	readonly status: ExtractionStatus;
}

// jobs と最新抽出を結合して読む。最新抽出は extracted_at 最大（同値は id 最大）で 1 件に畳む。
async function readJobsWithExtraction(
	db: D1Database,
): Promise<Map<string, JobMaterial>> {
	const { results } = await db
		.prepare(
			`SELECT j.id AS job_id, j.source_url AS source_url, e.structured_json AS structured_json, e.extraction_status AS extraction_status
			 FROM ${TABLE_NAMES.jobs} j
			 JOIN ${TABLE_NAMES.extractions} e ON e.id = (
			   SELECT i.id FROM ${TABLE_NAMES.extractions} i
			   WHERE i.job_id = j.id
			   ORDER BY i.extracted_at DESC, i.id DESC
			   LIMIT 1
			 )`,
		)
		.all<{
			job_id: string;
			source_url: string;
			structured_json: string;
			extraction_status: ExtractionStatus;
		}>();
	const map = new Map<string, JobMaterial>();
	for (const r of results) {
		map.set(r.job_id, {
			jobId: r.job_id,
			sourceUrl: r.source_url,
			job: JSON.parse(r.structured_json) as NormalizedJob,
			status: r.extraction_status,
		});
	}
	return map;
}

// 永続 scores 行（#16）。表示は total/sub_score/included/weight をここから取る。
interface ScoreRowLite {
	readonly job_id: string;
	readonly criterion: string;
	readonly sub_score: number | null;
	readonly included: 0 | 1;
	readonly weight: number | null;
}

// 全求人の scores 行を読み、job_id ごとに ScoreResult へ畳む。criterion 昇順で内訳順を安定化する
// （永続化順に依存しない・§8）。__total__ 行を total に、それ以外を breakdown に振り分ける。
async function readScoreResults(
	db: D1Database,
): Promise<Map<string, ScoreResult>> {
	const { results } = await db
		.prepare(
			`SELECT job_id, criterion, sub_score, included, weight
			 FROM ${TABLE_NAMES.scores}
			 ORDER BY job_id, criterion`,
		)
		.all<ScoreRowLite>();

	const byJob = new Map<
		string,
		{ total: number | null; breakdown: ScoreBreakdownRow[] }
	>();
	for (const row of results) {
		let entry = byJob.get(row.job_id);
		if (entry === undefined) {
			entry = { total: null, breakdown: [] };
			byJob.set(row.job_id, entry);
		}
		if (row.criterion === TOTAL_SCORE_CRITERION) {
			entry.total = row.sub_score;
			continue;
		}
		const keyKind = NORMALIZED_KEY_KINDS[row.criterion as NormalizedKey];
		if (keyKind === undefined) continue; // 未知 criterion は表示しない（中立・防御）
		entry.breakdown.push({
			key: row.criterion as NormalizedKey,
			kind: keyKind.kind,
			weight: row.weight ?? 0,
			score: row.sub_score,
			included: row.included === 1,
		});
	}

	const map = new Map<string, ScoreResult>();
	for (const [jobId, entry] of byJob) {
		map.set(jobId, { total: entry.total, breakdown: entry.breakdown });
	}
	return map;
}

// criteria_config 全行を読む（ハードフィルタ再判定に使う）。行型は #16 の単一ソースを共有する。
async function readCriteriaConfigRows(
	db: D1Database,
): Promise<CriteriaConfigRow[]> {
	const { results } = await db
		.prepare(
			`SELECT criterion, desired_value, weight, hard_filter, updated_at FROM ${TABLE_NAMES.criteriaConfig}`,
		)
		.all<CriteriaConfigRow>();
	return results;
}

// 読み出し結果。ranked は順位対象（rankJobs 済み）、excluded はハードフィルタ除外（理由つき）。
export interface RankingView {
	readonly ranked: readonly RankedJobView[];
	readonly excluded: readonly RankedJobView[];
}

// scores からスコア順一覧を組む（決定的・AI 非依存）。
// 手順: jobs+抽出・永続 scores・criteria_config を読む → 求人ごとに RescoredJob を組む
// （score は scores 由来、hardFilter は rescoreJob と同じ前処理で再判定）→ rankJobs で順序確定 →
// 通過分を ranked・除外分を excluded として表示ビューへ変換する。
export async function readRanking(db: D1Database): Promise<RankingView> {
	const materials = await readJobsWithExtraction(db);
	const scoreResults = await readScoreResults(db);
	const configRows = await readCriteriaConfigRows(db);
	const config = buildScoringConfig(configRows);
	const hardFilters = buildHardFilterMap(configRows);

	const entries: { material: JobMaterial; rescored: RescoredJob }[] = [];
	for (const [jobId, material] of materials) {
		const score = scoreResults.get(jobId);
		if (score === undefined) continue; // 未スコアリング求人は一覧に出さない
		const hardFilter = recomputeHardFilter(material, config, hardFilters);
		entries.push({ material, rescored: { jobId, score, hardFilter } });
	}

	const byJob = new Map(entries.map((e) => [e.rescored.jobId, e]));
	const ranked = rankJobs(entries.map((e) => e.rescored))
		.map((r) => byJob.get(r.jobId))
		.filter((e): e is (typeof entries)[number] => e !== undefined)
		.map(toView);
	// 除外は rankJobs に含まれない。jobId 昇順で決定的に並べる。
	const excluded = entries
		.filter((e) => !e.rescored.hardFilter.passed)
		.sort((a, b) =>
			a.rescored.jobId < b.rescored.jobId
				? -1
				: a.rescored.jobId > b.rescored.jobId
					? 1
					: 0,
		)
		.map(toView);

	return { ranked, excluded };
}

// ハードフィルタを rescoreJob と同一手順で再判定する（決定的・AI 非依存）。
// extraction_status 反映（failed→全 unknown）→ aiJudged 突合（matcher 未指定なら無変化）→ 判定。
// 突合の希望集合は criteria_config に未保持のため空（rescore.ts と同じ・#68 拡張点）。
function recomputeHardFilter(
	material: JobMaterial,
	config: ScoringConfig,
	hardFilters: ReturnType<typeof buildHardFilterMap>,
): RescoredJob["hardFilter"] {
	const statusApplied = applyExtractionStatus(material.job, material.status);
	const matched = applySkillMatch(statusApplied, config, {}, {});
	return passesHardFilters(matched, config, hardFilters);
}

// RescoredJob + 材料 → 表示ビュー。
function toView(entry: {
	material: JobMaterial;
	rescored: RescoredJob;
}): RankedJobView {
	return rescoredToView(
		entry.rescored,
		entry.material.sourceUrl,
		entry.material.job,
	);
}
