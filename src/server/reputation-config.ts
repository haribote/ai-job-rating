// 企業評判 取得元設定（reputation_sources）の取得・更新 API ロジック（#34）。
//
// なぜこのモジュールが存在するか:
// - 取得元設定の入力検証（fetch_method の閉集合・priority の数値性・name 非空）を決定的な純関数に閉じ、
//   ルート（app.ts）から切り離して単体テスト可能にする（config.ts の流儀に倣う・§9）。
// - ストレージ層（reputation-store.ts #33）は再実装せず CRUD をそのまま呼ぶ。本モジュールは「入力 → store
//   への呼び出し形」への決定的変換のみを担う。
// - 設定変更は決定的・AI 非再実行（抽出↔スコアリング分離 §5.3）。取得元は #30 の取得層が enabledOnly で参照する。

import {
	REPUTATION_FETCH_METHODS,
	type ReputationFetchMethod,
} from "./storage/db-schema";
import type { UpsertReputationSourceInput } from "./storage/reputation-store";

// 入力検証の失敗分類（config.ts の reason 方式に倣う）。ルートが 400 の reason に詰める。
export type ReputationSourceInputError =
	| "name"
	| "fetch_method"
	| "identifier"
	| "priority"
	| "enabled";

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: null;
}

// 取得元設定 1 件の入力を決定的に検証し、store の upsert 入力へ変換する。
// 不正は理由付きで拒否し、保存前に弾く（config.ts の inputsToConfigRows と同方針）。
export function parseReputationSourceInput(
	raw: unknown,
):
	| { ok: true; value: UpsertReputationSourceInput }
	| { ok: false; reason: ReputationSourceInputError } {
	const o = asRecord(raw);
	// 非オブジェクトは name 不在として扱う（最初に必須の name で弾く）。
	if (o === null) return { ok: false, reason: "name" };

	if (typeof o.name !== "string") return { ok: false, reason: "name" };
	const name = o.name.trim();
	if (name === "") return { ok: false, reason: "name" };

	if (
		typeof o.fetchMethod !== "string" ||
		!(REPUTATION_FETCH_METHODS as readonly string[]).includes(o.fetchMethod)
	) {
		return { ok: false, reason: "fetch_method" };
	}
	const fetchMethod = o.fetchMethod as ReputationFetchMethod;

	// identifier は任意。未指定/空文字/null は null（web_search 主体の取得元は識別子を持たない・§7.2）。
	let identifier: string | null = null;
	if (o.identifier !== undefined && o.identifier !== null) {
		if (typeof o.identifier !== "string")
			return { ok: false, reason: "identifier" };
		const trimmed = o.identifier.trim();
		identifier = trimmed === "" ? null : trimmed;
	}

	// priority は小さいほど優先（§7.2）。非負整数のみ。未指定は 0。
	let priority = 0;
	if (o.priority !== undefined) {
		if (
			typeof o.priority !== "number" ||
			!Number.isInteger(o.priority) ||
			o.priority < 0
		) {
			return { ok: false, reason: "priority" };
		}
		priority = o.priority;
	}

	// enabled は真偽値のみ。未指定は true（追加直後から取得対象になる既定）。
	let enabled = true;
	if (o.enabled !== undefined) {
		if (typeof o.enabled !== "boolean") return { ok: false, reason: "enabled" };
		enabled = o.enabled;
	}

	return {
		ok: true,
		value: { name, identifier, fetchMethod, priority, enabled },
	};
}
