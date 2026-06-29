import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../lib/api";
import type { ReputationSource } from "../lib/reputation";
import { ReputationSourcesForm } from "./ReputationSourcesForm";

// 取得元設定フォームの受け入れ条件: 一覧表示・追加（PUT）・削除（DELETE）・優先順位変更（PUT 連番）。
// CRUD は API 経由のみで決定的。AI（POST 抽出系）は一切叩かないことを担保する。

function source(over: Partial<ReputationSource>): ReputationSource {
	return {
		id: "id",
		name: "s",
		identifier: null,
		fetch_method: "web_search",
		priority: 0,
		enabled: 1,
		created_at: 0,
		updated_at: 0,
		...over,
	};
}

// 呼び出しを記録するフェイク ApiClient。post（AI 抽出系）が呼ばれないことを検査する。
function fakeApi() {
	const calls = {
		post: [] as { path: string; body?: unknown }[],
		put: [] as { path: string; body?: unknown }[],
		delete: [] as string[],
	};
	const client: ApiClient = {
		get: async <T,>() => ({}) as T,
		post: async <T,>(path: string, body?: unknown) => {
			calls.post.push({ path, body });
			return {} as T;
		},
		put: async <T,>(path: string, body?: unknown) => {
			calls.put.push({ path, body });
			return { source: source({}) } as T;
		},
		delete: async <T,>(path: string) => {
			calls.delete.push(path);
			return { status: "deleted" } as T;
		},
	};
	return { client, calls };
}

describe("ReputationSourcesForm", () => {
	it("取得元を priority 昇順で一覧表示する", async () => {
		const sources = [
			source({ id: "1", name: "alpha", priority: 0 }),
			source({ id: "2", name: "beta", priority: 1 }),
		];
		render(
			<ReputationSourcesForm
				sourcesFetcher={() => Promise.resolve(sources)}
				api={fakeApi().client}
			/>,
		);
		expect(await screen.findByText("alpha")).toBeInTheDocument();
		expect(screen.getByText("beta")).toBeInTheDocument();
	});

	it("追加すると PUT /reputation/sources を呼び一覧を再取得する（AI 非実行）", async () => {
		const { client, calls } = fakeApi();
		let fetchCount = 0;
		const fetcher = () => {
			fetchCount += 1;
			return Promise.resolve<ReputationSource[]>([]);
		};
		render(<ReputationSourcesForm sourcesFetcher={fetcher} api={client} />);

		await screen.findByText("取得元は未登録です。");
		fireEvent.change(screen.getByLabelText("取得元名"), {
			target: { value: "openwork" },
		});
		fireEvent.change(screen.getByLabelText("優先順位"), {
			target: { value: "2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "追加" }));

		await waitFor(() => expect(calls.put).toHaveLength(1));
		expect(calls.put[0].path).toBe("/reputation/sources");
		expect(calls.put[0].body).toMatchObject({
			name: "openwork",
			fetchMethod: "web_search",
			priority: 2,
			enabled: true,
		});
		// 初回ロード + 追加後の再取得。
		await waitFor(() => expect(fetchCount).toBe(2));
		expect(calls.post).toHaveLength(0);
	});

	it("空の取得元名では追加せずエラーを出す", async () => {
		const { client, calls } = fakeApi();
		render(
			<ReputationSourcesForm
				sourcesFetcher={() => Promise.resolve([])}
				api={client}
			/>,
		);
		await screen.findByText("取得元は未登録です。");
		fireEvent.click(screen.getByRole("button", { name: "追加" }));
		await screen.findByRole("alert");
		expect(calls.put).toHaveLength(0);
	});

	it("削除すると DELETE /reputation/sources/:id を呼ぶ", async () => {
		const { client, calls } = fakeApi();
		render(
			<ReputationSourcesForm
				sourcesFetcher={() =>
					Promise.resolve([source({ id: "abc", name: "openwork" })])
				}
				api={client}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "削除（openwork）" }),
		);
		await waitFor(() => expect(calls.delete).toHaveLength(1));
		expect(calls.delete[0]).toBe("/reputation/sources/abc");
	});

	it("優先順位を上げると入れ替えた行を連番で upsert する", async () => {
		const { client, calls } = fakeApi();
		const sources = [
			source({ id: "1", name: "a", priority: 0 }),
			source({ id: "2", name: "b", priority: 1 }),
			source({ id: "3", name: "c", priority: 2 }),
		];
		render(
			<ReputationSourcesForm
				sourcesFetcher={() => Promise.resolve(sources)}
				api={client}
			/>,
		);
		// c を上へ → 並び [a, c, b]。連番で c:1, b:2 が変化（a:0 据置）。
		fireEvent.click(await screen.findByRole("button", { name: "上へ（c）" }));
		await waitFor(() => expect(calls.put).toHaveLength(2));
		const byName = new Map(
			calls.put.map((p) => [
				(p.body as { name: string }).name,
				(p.body as { priority: number }).priority,
			]),
		);
		expect(byName.get("c")).toBe(1);
		expect(byName.get("b")).toBe(2);
	});
});
