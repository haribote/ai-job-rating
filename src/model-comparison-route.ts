import { Hono } from "hono";
import type { AiRunner } from "./ai";
import {
	CANDIDATE_MODELS,
	compareModels,
	type JobFixture,
} from "./model-comparison";

// モデル比較スパイク（#15）の live 実行用エントリ。人間が binding 経由で各候補モデルの
// 抽出結果を横並びで得るための薄い HTTP 境界。整形・集計は model-comparison.ts に集約する。
//
// なぜルートにするか: 実推論は account/binding 依存でオフライン不可。wrangler dev で
// binding を有効化し、curl で本文を投げて結果を JSON 取得 → docs テンプレに転記する。
// app.ts へは配線しない（スパイク用途のため）。手動検証時に一時的に route する想定。

// 比較リクエスト body の型。fixtures は { name, body } の配列。
interface CompareRequest {
	readonly fixtures?: unknown;
	// 任意。省略時は CANDIDATE_MODELS の全 id を使う。
	readonly models?: unknown;
}

// 入力を安全に JobFixture[] へ寄せる（決定的）。name/body が文字列の要素のみ採用する。
function toFixtures(raw: unknown): JobFixture[] {
	if (!Array.isArray(raw)) return [];
	const fixtures: JobFixture[] = [];
	for (const item of raw) {
		if (item && typeof item === "object") {
			const name = (item as { name?: unknown }).name;
			const body = (item as { body?: unknown }).body;
			if (typeof name === "string" && typeof body === "string") {
				fixtures.push({ name, body });
			}
		}
	}
	return fixtures;
}

// models 指定を string[] へ寄せる。未指定・空なら全候補モデルにフォールバックする。
function toModels(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		const ids = raw.filter((m): m is string => typeof m === "string");
		if (ids.length > 0) return ids;
	}
	return CANDIDATE_MODELS.map((m) => m.id);
}

export const modelComparison = new Hono<{ Bindings: { AI: AiRunner } }>();

// 本文配列を受け、各候補モデルで抽出した結果を横並びで返す。
// 整形済みレポートをそのまま docs テンプレへ転記できる JSON 形にする。
modelComparison.post("/compare", async (c) => {
	const payload = (await c.req.json().catch(() => ({}))) as CompareRequest;
	const fixtures = toFixtures(payload.fixtures);
	if (fixtures.length === 0) {
		// 空・不正入力は AI を呼ばず 400（コスト保護・契約明確化）
		return c.json({ ok: false, reason: "no-fixtures" }, 400);
	}
	const models = toModels(payload.models);
	const report = await compareModels(c.env.AI, fixtures, models);
	return c.json({ ok: true, models, report });
});
