import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api";
import {
	deleteReputationSource,
	fetchReputationSources,
	type ReputationSource,
	saveReputationSource,
} from "./reputation";

// 記録付きフェイク ApiClient。呼び出しパス・body を捕捉して契約を決定的に検証する。
function fakeApi(responses: {
	get?: unknown;
	put?: unknown;
	delete?: unknown;
}): {
	api: ApiClient;
	calls: { method: string; path: string; body?: unknown }[];
} {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const api: ApiClient = {
		get: <T>(path: string) => {
			calls.push({ method: "GET", path });
			return Promise.resolve(responses.get as T);
		},
		post: <T>(path: string, body?: unknown) => {
			calls.push({ method: "POST", path, body });
			return Promise.resolve(undefined as T);
		},
		put: <T>(path: string, body?: unknown) => {
			calls.push({ method: "PUT", path, body });
			return Promise.resolve(responses.put as T);
		},
		delete: <T>(path: string) => {
			calls.push({ method: "DELETE", path });
			return Promise.resolve(responses.delete as T);
		},
	};
	return { api, calls };
}

const sample: ReputationSource = {
	id: "s1",
	name: "openwork",
	identifier: "openwork.jp",
	fetch_method: "web_search",
	priority: 0,
	enabled: 1,
	created_at: 0,
	updated_at: 0,
};

describe("fetchReputationSources", () => {
	it("GET /reputation/sources の sources を返す", async () => {
		const { api, calls } = fakeApi({ get: { sources: [sample] } });
		const result = await fetchReputationSources(api.get);
		expect(result).toEqual([sample]);
		expect(calls[0]).toEqual({ method: "GET", path: "/reputation/sources" });
	});
});

describe("saveReputationSource", () => {
	it("PUT /reputation/sources へ入力を送り保存済み行を返す", async () => {
		const { api, calls } = fakeApi({ put: { source: sample } });
		const result = await saveReputationSource(
			{ name: "openwork", fetchMethod: "web_search", priority: 0 },
			api.put,
		);
		expect(result).toEqual(sample);
		expect(calls[0]).toEqual({
			method: "PUT",
			path: "/reputation/sources",
			body: { name: "openwork", fetchMethod: "web_search", priority: 0 },
		});
	});
});

describe("deleteReputationSource", () => {
	it("DELETE /reputation/sources/:id を叩く", async () => {
		const { api, calls } = fakeApi({ delete: { status: "deleted" } });
		await deleteReputationSource("s1", api.delete);
		expect(calls[0]).toEqual({
			method: "DELETE",
			path: "/reputation/sources/s1",
		});
	});
});
