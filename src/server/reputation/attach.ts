// 評判を企業へ紐付けるための company 解決（#35 の補助/フォールバック経路が共有する）。
//
// なぜこのモジュールが存在するか:
// - 評判は求人単位でなく企業単位の属性（§7.2）。手入力上書き（manual）・URL/HTML 投入（url_html）の
//   どちらも「求人 → 企業」を解決してから company 単位で snapshot を保存する。その共通部分を 1 箇所に集約する。
// - resolveCompanyForJob（#32）は upsertCompany → linkJobToCompany の順で動くため、存在しない jobId を
//   そのまま渡すと「孤児 company を作ってから link で not_found」になる。先に求人の実在を確認し、
//   不正な jobId では company を一切作らない（副作用の最小化）。
// - 企業名が空・unknown 表記なら resolveCompanyForJob は null を返す。評判は company 無しでは保存できないため
//   呼び出し側へ company_unresolved として返し、ルートが 400 に変換する（unknown 中立 §5.2 の範囲内）。

import type { CorporateNumberClient } from "../companies/houjin-bangou";
import {
	type CompaniesStoreOptions,
	resolveCompanyForJob,
} from "../storage/companies-store";
import { TABLE_NAMES } from "../storage/db-schema";

// company 解決の結果。job_not_found は 404、company_unresolved は 400 にルートが対応させる。
export type ResolveCompanyForReputationResult =
	| { ok: true; companyId: string }
	| { ok: false; reason: "job_not_found" | "company_unresolved" };

// 求人を企業へ解決する（実在確認 → 名寄せ → upsert → 紐付け）。評判保存の前段で使う。
export async function resolveCompanyForReputation(
	db: D1Database,
	jobId: string,
	companyName: string,
	client: CorporateNumberClient,
	opts: CompaniesStoreOptions = {},
): Promise<ResolveCompanyForReputationResult> {
	// 先に求人の実在を確認する。resolveCompanyForJob は company を upsert してから link するため、
	// 不正な jobId をそのまま渡すと孤児 company を作ってしまう。これを防ぐ。
	const job = await db
		.prepare(`SELECT id FROM ${TABLE_NAMES.jobs} WHERE id = ?`)
		.bind(jobId)
		.first<{ id: string }>();
	if (job === null) {
		return { ok: false, reason: "job_not_found" };
	}

	const company = await resolveCompanyForJob(
		db,
		jobId,
		companyName,
		client,
		opts,
	);
	if (company === null) {
		// 企業名が unknown 表記等で名寄せ不能。評判は company 単位のため保存できない。
		return { ok: false, reason: "company_unresolved" };
	}
	return { ok: true, companyId: company.id };
}
