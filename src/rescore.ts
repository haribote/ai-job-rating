// 設定変更時の再スコアリングの D1 オーケストレーション（#20）。
//
// なぜこのモジュールが存在するか:
// - criteria_config（重み・希望値・ハードフィルタ）と保存済み extractions（再実行しない）を
//   D1 から読み、純粋コア（rescore-core）で決定的に再計算し、scores に書き戻す（§5.3 / §8）。
// - AI は一切呼ばない。設定変更（#19 がトリガ）→ 即再ランキングを満たす（§5.3 ガードレール）。
// - DB I/O のみを担い、スコア算出ロジックは持たない（責務分離 §9）。算出は rescore-core。
//
// scores の書き戻し形（#16 確定スキーマ / #18 が読む）:
// - criterion=TOTAL_SCORE_CRITERION の行に総合スコア（total）。total=null は sub_score NULL。
// - 各正規キー行に sub_score / included / weight。unknown 中立は included=0 / sub_score NULL。
// - weight は criteria_config からのスナップショット（再現性のためコピー、#16 設計）。

import {
	buildDesiredSkills,
	buildHardFilterMap,
	buildScoringConfig,
} from "./criteria-config";
import {
	type CriteriaConfigRow,
	type ExtractionStatus,
	TABLE_NAMES,
	TOTAL_SCORE_CRITERION,
} from "./db-schema";
import type { NormalizedJob } from "./job-schema";
import {
	type RescoredJob,
	type RescoreExtensions,
	rescoreJob,
} from "./rescore-core";
import { defaultSkillMatcher } from "./skill-matcher";

// 最新抽出の読み出し結果（job_id ごと 1 件）。
interface LatestExtraction {
	readonly jobId: string;
	readonly job: NormalizedJob;
	readonly status: ExtractionStatus;
}

// criteria_config 全行を読む（決定的順序は buildScoringConfig 側で担保）。
async function readCriteriaConfig(
	db: D1Database,
): Promise<CriteriaConfigRow[]> {
	const { results } = await db
		.prepare(
			`SELECT criterion, desired_value, weight, hard_filter, updated_at FROM ${TABLE_NAMES.criteriaConfig}`,
		)
		.all<CriteriaConfigRow>();
	return results;
}

// 求人ごとの最新抽出（extracted_at 最大）を 1 件だけ読む。failed/partial も含めて
// 読む（extraction_status は採点側 rescore-core が解釈する）。AI は呼ばない。
async function readLatestExtractions(
	db: D1Database,
	jobId?: string,
): Promise<LatestExtraction[]> {
	// job_id ごとに id を 1 つに畳む相関サブクエリで、extracted_at 同値の衝突時も
	// 決定的に 1 行へ絞る（最大 extracted_at、同値なら最大 id を採用）。
	const andJob = jobId === undefined ? "" : "AND e.job_id = ?";
	const stmt = db.prepare(
		`SELECT e.job_id AS job_id, e.structured_json AS structured_json, e.extraction_status AS extraction_status
		 FROM ${TABLE_NAMES.extractions} e
		 WHERE e.id = (
		   SELECT i.id FROM ${TABLE_NAMES.extractions} i
		   WHERE i.job_id = e.job_id
		   ORDER BY i.extracted_at DESC, i.id DESC
		   LIMIT 1
		 )
		 ${andJob}`,
	);
	const bound = jobId === undefined ? stmt : stmt.bind(jobId);
	const { results } = await bound.all<{
		job_id: string;
		structured_json: string;
		extraction_status: ExtractionStatus;
	}>();
	return results.map((r) => ({
		jobId: r.job_id,
		job: JSON.parse(r.structured_json) as NormalizedJob,
		status: r.extraction_status,
	}));
}

// 1 求人の scores 行を delete + insert で置き換える（再スコアリングは冪等に上書き）。
// criterion 行（採点対象のみ）と総合スコア行（__total__）を書く。
// weight は breakdown 行が criteria_config からのスナップショットとして既に保持する（#16）。
async function writeScores(db: D1Database, scored: RescoredJob): Promise<void> {
	const statements: D1PreparedStatement[] = [];
	statements.push(
		db
			.prepare(`DELETE FROM ${TABLE_NAMES.scores} WHERE job_id = ?`)
			.bind(scored.jobId),
	);

	const insert = db.prepare(
		`INSERT INTO ${TABLE_NAMES.scores} (job_id, criterion, sub_score, included, weight) VALUES (?, ?, ?, ?, ?)`,
	);
	for (const row of scored.score.breakdown) {
		statements.push(
			insert.bind(
				scored.jobId,
				row.key,
				row.score, // included=false は score=null（sub_score NULL）
				row.included ? 1 : 0,
				row.weight,
			),
		);
	}
	// 総合スコア行（番兵 criterion）。total=null は sub_score NULL・included=0。
	const total = scored.score.total;
	statements.push(
		insert.bind(
			scored.jobId,
			TOTAL_SCORE_CRITERION,
			total,
			total === null ? 0 : 1,
			null,
		),
	);
	await db.batch(statements);
}

// 1 求人を再スコアリングして scores へ書き戻す（決定的・AI 非依存）。
// 抽出が存在しない job_id は何もしない（取得・抽出フェーズの責務）。
export async function rescoreOne(
	db: D1Database,
	jobId: string,
	extensions: RescoreExtensions = {},
): Promise<RescoredJob | null> {
	const configRows = await readCriteriaConfig(db);
	const [extraction] = await readLatestExtractions(db, jobId);
	if (extraction === undefined) return null;
	const scored = computeOne(configRows, extraction, extensions);
	await writeScores(db, scored);
	return scored;
}

// 全求人を再スコアリングして scores を更新する（設定変更時の即再ランキング、#19→#20）。
// criteria_config を 1 回だけ読み、全 job へ適用する（重み・希望値の変更で AI は再実行しない）。
export async function rescoreAll(
	db: D1Database,
	extensions: RescoreExtensions = {},
): Promise<readonly RescoredJob[]> {
	const configRows = await readCriteriaConfig(db);
	const extractions = await readLatestExtractions(db);
	const scoredList: RescoredJob[] = [];
	for (const extraction of extractions) {
		const scored = computeOne(configRows, extraction, extensions);
		await writeScores(db, scored);
		scoredList.push(scored);
	}
	return scoredList;
}

// criteria_config 行 + 1 抽出 → 純粋コアで再スコアリング（DB I/O なし）。
function computeOne(
	configRows: readonly CriteriaConfigRow[],
	extraction: LatestExtraction,
	extensions: RescoreExtensions,
): RescoredJob {
	const config = buildScoringConfig(configRows);
	const hardFilters = buildHardFilterMap(configRows);
	// 希望スキル集合（aiJudged 拡張点・#68）。criteria_config の aiJudged 行の
	// desired_value({skills}) を在り処にする。希望値の変更で AI は再実行しない（§5.3）。
	const desiredSkills = buildDesiredSkills(configRows);
	// 既定の決定的スキル突合を差す。呼び出し側が skillMatcher を指定すればそちらを優先する。
	// 明示的な undefined で既定が消えないよう ?? で受ける（spread だと undefined が上書きする）。
	const withMatcher: RescoreExtensions = {
		...extensions,
		skillMatcher: extensions.skillMatcher ?? defaultSkillMatcher,
	};
	return rescoreJob(
		extraction.jobId,
		extraction.job,
		extraction.status,
		config,
		hardFilters,
		desiredSkills,
		withMatcher,
	);
}
