// 求人起点の企業評判 web_search トリガー（#117 の求人→企業 seam を配線）。
//
// なぜこのモジュールが存在するか:
// - コア層のルート POST /api/companies/:id/reputation（#30）は companies.id を入力に取る。抽出
//   パイプラインは company を自動生成しない（ingest は company_name を extractions に書くだけ）ため、
//   UI の「評判取得」から企業評判を取るには「求人 → 企業 seed → web_search」を橋渡しする層が要る。
// - web_search 取得ループ（有効取得元の解決 → source ごとに冪等取得）は company 起点・求人起点の両ルートで
//   同一。runCompanyWebSearch に一元化し、app.ts での重複実装を避ける（DRY・§9 責務分離）。
// - company 解決（求人の実在確認 → upsert → 紐付け）は既存 resolveCompanyForReputation を再利用する
//   （manual / url_html 経路と同じ橋渡し・副作用最小化は attach.ts が担保）。

import type { CorporateNumberClient } from "../companies/houjin-bangou";
import {
	type CompaniesStoreOptions,
	getCompanyById,
} from "../storage/companies-store";
import type { ReputationSnapshotRow } from "../storage/db-schema";
import { TABLE_NAMES } from "../storage/db-schema";
import { listReputationSources } from "../storage/reputation-store";
import { resolveCompanyForReputation } from "./attach";
import {
	DEFAULT_WEB_SEARCH_SOURCE,
	fetchReputationSnapshot,
	type ReputationWebSearchClient,
} from "./web-search";

// web_search 取得ループの依存。client は build 済み（テストは Fake を注入・env アクセスを持ち込まない）。
export interface RunCompanyWebSearchDeps {
	db: D1Database;
	client: ReputationWebSearchClient;
	maxAgeSeconds?: number;
	now?: () => number;
}

// 取得元 1 件ぶんの結果（app.ts の JSON 契約と一致）。
export interface CompanyWebSearchSnapshot {
	source: string;
	cached: boolean;
	fetched: boolean;
	snapshot: ReputationSnapshotRow | null;
}

// 企業 1 件の評判を有効 web_search 取得元ごとに冪等取得する（company 起点・求人起点で共有）。
// 有効な web_search 取得元（#34）が無ければ §7.2 の主軸として既定 source 名で単体成立させる。
export async function runCompanyWebSearch(
	deps: RunCompanyWebSearchDeps,
	company: { id: string; name: string; houjin_bangou: string | null },
): Promise<CompanyWebSearchSnapshot[]> {
	const enabled = await listReputationSources(deps.db, { enabledOnly: true });
	const webSearchSources = enabled.filter(
		(s) => s.fetch_method === "web_search",
	);
	const sourceNames =
		webSearchSources.length > 0
			? webSearchSources.map((s) => s.name)
			: [DEFAULT_WEB_SEARCH_SOURCE];

	const snapshots: CompanyWebSearchSnapshot[] = [];
	for (const source of sourceNames) {
		const result = await fetchReputationSnapshot(
			{
				db: deps.db,
				client: deps.client,
				maxAgeSeconds: deps.maxAgeSeconds,
				now: deps.now,
			},
			{
				companyId: company.id,
				companyName: company.name,
				houjinBangou: company.houjin_bangou,
				source,
			},
		);
		snapshots.push({
			source,
			cached: result.cached,
			fetched: result.fetched,
			snapshot: result.snapshot,
		});
	}
	return snapshots;
}

// 求人起点トリガーの依存。corporateClient は company 名寄せ、client は web_search（別責務）。
export interface TriggerJobReputationDeps extends RunCompanyWebSearchDeps {
	corporateClient: CorporateNumberClient;
	companyOpts?: CompaniesStoreOptions;
}

// 求人起点トリガーの結果。ルートが HTTP ステータスへ対応させる判別共用体（manual/url 経路と同流儀）。
export type TriggerJobReputationResult =
	| { kind: "ok"; companyId: string; snapshots: CompanyWebSearchSnapshot[] }
	| { kind: "job-not-found" }
	| { kind: "company-unresolved" };

// 求人 → 企業 seed → web_search を通す。企業名は最新抽出（extractions.company_name）から供給する。
// 既に企業紐付け済みの求人はその company を尊重する（resolveCompanyForReputation が保証）。
// 企業名が unknown 表記等で名寄せ不能なら company-unresolved（評判は company 単位のため保存不能）。
export async function triggerJobReputationWebSearch(
	deps: TriggerJobReputationDeps,
	jobId: string,
): Promise<TriggerJobReputationResult> {
	// 最新抽出（extracted_at 最大・同値は id 最大）の企業名を橋渡しに使う。未抽出は空扱い＝名寄せ不能へ倒す。
	const ext = await deps.db
		.prepare(
			`SELECT company_name FROM ${TABLE_NAMES.extractions}
			 WHERE job_id = ? ORDER BY extracted_at DESC, id DESC LIMIT 1`,
		)
		.bind(jobId)
		.first<{ company_name: string | null }>();

	const resolved = await resolveCompanyForReputation(
		deps.db,
		jobId,
		ext?.company_name ?? "",
		deps.corporateClient,
		deps.companyOpts,
	);
	if (!resolved.ok) {
		return resolved.reason === "job_not_found"
			? { kind: "job-not-found" }
			: { kind: "company-unresolved" };
	}

	const company = await getCompanyById(deps.db, resolved.companyId);
	// 直前に upsert/紐付けした company が読めない状況は基本ないが、防御的に中立へ倒す。
	if (company === null) return { kind: "company-unresolved" };

	const snapshots = await runCompanyWebSearch(
		{
			db: deps.db,
			client: deps.client,
			maxAgeSeconds: deps.maxAgeSeconds,
			now: deps.now,
		},
		company,
	);
	return { kind: "ok", companyId: company.id, snapshots };
}
