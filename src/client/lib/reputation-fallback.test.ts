import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api";
import {
	ingestReputationFromUrlHtml,
	overrideReputationManually,
	type ReputationSnapshot,
} from "./reputation";

// #35 の補助/フォールバック経路 client ラッパの契約（呼び出しパス・body・戻り値の snapshot 取り出し）。
function fakeApi(snapshot: ReputationSnapshot): {
	api: Pick<ApiClient, "put" | "post">;
	calls: { method: string; path: string; body?: unknown }[];
} {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const api = {
		put: <T>(path: string, body?: unknown) => {
			calls.push({ method: "PUT", path, body });
			return Promise.resolve({ snapshot } as T);
		},
		post: <T>(path: string, body?: unknown) => {
			calls.push({ method: "POST", path, body });
			return Promise.resolve({ snapshot } as T);
		},
	};
	return { api, calls };
}

const SNAPSHOT: ReputationSnapshot = {
	id: "rep-1",
	company_id: "co-1",
	source: "openwork",
	overall_score: 4,
	review_count: 9,
	sub_scores_json: null,
	fetched_at: 1000,
	created_at: 1000,
};

describe("overrideReputationManually", () => {
	it("PUT /jobs/:id/reputation/manual を呼び snapshot を返す", async () => {
		const { api, calls } = fakeApi(SNAPSHOT);
		const input = { companyName: "Acme", source: "openwork", overallScore: 4 };
		const snap = await overrideReputationManually("job-1", input, api.put);
		expect(snap).toEqual(SNAPSHOT);
		expect(calls).toEqual([
			{ method: "PUT", path: "/jobs/job-1/reputation/manual", body: input },
		]);
	});
});

describe("ingestReputationFromUrlHtml", () => {
	it("POST /jobs/:id/reputation/url を呼び snapshot を返す", async () => {
		const { api, calls } = fakeApi(SNAPSHOT);
		const input = { companyName: "Acme", source: "openwork", html: "<p>x</p>" };
		const snap = await ingestReputationFromUrlHtml("job-1", input, api.post);
		expect(snap).toEqual(SNAPSHOT);
		expect(calls).toEqual([
			{ method: "POST", path: "/jobs/job-1/reputation/url", body: input },
		]);
	});
});
