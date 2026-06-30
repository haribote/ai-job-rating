// 評判スコアの手入力上書き経路（fetch_method = "manual"・#35）。
//
// なぜこのモジュールが存在するか:
// - #30 の web_search 自動取得や #35 の URL/HTML 抽出が使えない/不十分なとき、任意のスコアを手で入れて
//   上書きできる補助経路を用意する（§7.2 の補助/フォールバック）。
// - 上書きのセマンティクスは append-only。「最新の manual snapshot を積む」ことで上書きを表現する
//   （getLatestReputationSnapshot が最新を返す）。既存履歴は破壊しない（監査・再現性 §8）。
// - 入力検証は決定的な純関数に閉じてユニットテスト可能にする（reputation-config.ts の流儀）。スコア層（#36）の
//   加重合算・カテゴリ合流には踏み込まない（抽出↔スコアリング分離 §5.3）。

import type { CorporateNumberClient } from "../companies/houjin-bangou";
import type { CompaniesStoreOptions } from "../storage/companies-store";
import type { ReputationSnapshotRow } from "../storage/db-schema";
import {
	type ReputationStoreOptions,
	saveReputationSnapshot,
} from "../storage/reputation-store";
import { resolveCompanyForReputation } from "./attach";
import { asRecord, isFiniteNonNegativeNumber } from "./parse-utils";

// 入力検証の失敗分類（reputation-config.ts の reason 方式に倣う）。ルートが 400 の reason に詰める。
export type ManualReputationInputError =
	| "companyName"
	| "source"
	| "overallScore"
	| "reviewCount"
	| "subScores"
	| "empty";

// 手入力上書きの検証済み値。company 解決用の companyName と、上書き対象の source（取得元名）を伴う。
// overallScore / reviewCount / subScores は「指定なし」を null で表す（unknown 中立・分母除外は #36 が判断）。
export interface ManualReputationValue {
	companyName: string;
	source: string;
	overallScore: number | null;
	reviewCount: number | null;
	subScores: Record<string, number> | null;
}

// 手入力上書きの入力を決定的に検証する純関数。保存前に不正を弾く（コスト保護・決定性）。
// スコアのスケールは取得元依存（#33）のため上限は課さず、有限・非負だけを担保する。
export function parseManualReputationInput(
	raw: unknown,
):
	| { ok: true; value: ManualReputationValue }
	| { ok: false; reason: ManualReputationInputError } {
	const o = asRecord(raw);
	if (o === null) return { ok: false, reason: "companyName" };

	if (typeof o.companyName !== "string")
		return { ok: false, reason: "companyName" };
	const companyName = o.companyName.trim();
	if (companyName === "") return { ok: false, reason: "companyName" };

	if (typeof o.source !== "string") return { ok: false, reason: "source" };
	const source = o.source.trim();
	if (source === "") return { ok: false, reason: "source" };

	// overallScore: 任意。指定時は有限・非負（スケールは取得元依存のため上限なし・#33）。
	let overallScore: number | null = null;
	if (o.overallScore !== undefined && o.overallScore !== null) {
		if (!isFiniteNonNegativeNumber(o.overallScore)) {
			return { ok: false, reason: "overallScore" };
		}
		overallScore = o.overallScore;
	}

	// reviewCount: 任意。指定時は非負整数（件数は信頼度減衰に使う・#36）。
	let reviewCount: number | null = null;
	if (o.reviewCount !== undefined && o.reviewCount !== null) {
		if (
			!isFiniteNonNegativeNumber(o.reviewCount) ||
			!Number.isInteger(o.reviewCount)
		) {
			return { ok: false, reason: "reviewCount" };
		}
		reviewCount = o.reviewCount;
	}

	// subScores: 任意。指定時は string → 有限非負数の record。空 record は無効（上書き対象なし）。
	let subScores: Record<string, number> | null = null;
	if (o.subScores !== undefined && o.subScores !== null) {
		const sub = asRecord(o.subScores);
		if (sub === null) return { ok: false, reason: "subScores" };
		const entries = Object.entries(sub);
		if (entries.length === 0) return { ok: false, reason: "subScores" };
		const out: Record<string, number> = {};
		for (const [key, value] of entries) {
			if (!isFiniteNonNegativeNumber(value)) {
				return { ok: false, reason: "subScores" };
			}
			out[key] = value;
		}
		subScores = out;
	}

	// 上書きする値が 1 つも無ければ拒否する（空の手入力は意味がない）。
	if (overallScore === null && reviewCount === null && subScores === null) {
		return { ok: false, reason: "empty" };
	}

	return {
		ok: true,
		value: { companyName, source, overallScore, reviewCount, subScores },
	};
}

// 手入力上書きの依存。client は法人番号アダプタ（API 無効時は NULL_CORPORATE_NUMBER_CLIENT で中立）。
// *Opts は採番・時刻の注入点で、ユニットテストを決定的にする。
export interface ManualReputationDeps {
	db: D1Database;
	client: CorporateNumberClient;
	snapshotOpts?: ReputationStoreOptions;
	companyOpts?: CompaniesStoreOptions;
}

// 手入力上書きの結果。ルートが HTTP ステータスへ対応させる判別共用体。
export type SaveManualReputationResult =
	| { kind: "saved"; snapshot: ReputationSnapshotRow }
	| { kind: "job-not-found" }
	| { kind: "company-unresolved" };

// 検証済みの手入力値を company 単位の snapshot として追記する（append-only で上書きを表現）。
export async function saveManualReputation(
	deps: ManualReputationDeps,
	jobId: string,
	value: ManualReputationValue,
): Promise<SaveManualReputationResult> {
	const resolved = await resolveCompanyForReputation(
		deps.db,
		jobId,
		value.companyName,
		deps.client,
		deps.companyOpts,
	);
	if (!resolved.ok) {
		return resolved.reason === "job_not_found"
			? { kind: "job-not-found" }
			: { kind: "company-unresolved" };
	}

	const snapshot = await saveReputationSnapshot(
		deps.db,
		{
			companyId: resolved.companyId,
			source: value.source,
			overallScore: value.overallScore,
			reviewCount: value.reviewCount,
			// null は store 側で NULL 列として保存される（"指定なし"＝unknown 中立）。
			subScores: value.subScores,
		},
		deps.snapshotOpts,
	);
	return { kind: "saved", snapshot };
}
