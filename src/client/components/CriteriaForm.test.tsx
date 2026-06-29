import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import type { ApiClient } from "../lib/api";
import {
	CRITERION_META,
	type CriteriaConfigInput,
	type CriteriaConfigItem,
} from "../lib/criteria";
import { CriteriaForm } from "./CriteriaForm";

// 設定フォームの核となる受け入れ条件: 編集 → PUT /api/config → 再スコア（AI 非再実行）。
// AI 非再実行は「保存経路が /config への PUT のみで、抽出系（POST）を一切叩かない」ことで担保する。

// 全正規キーの既定 item を組み立てる（kind は表示メタから引く）。
function buildItems(): CriteriaConfigItem[] {
	return NORMALIZED_KEYS.map((criterion) => ({
		criterion,
		kind: CRITERION_META[criterion].kind,
		weight: 1,
		hardFilter: "none" as const,
		desired: null,
	}));
}

// 呼び出しを記録するフェイク ApiClient。put のみ応答を返し、post（抽出系 = AI）が呼ばれないことを検査する。
function fakeApi(count = 3) {
	const calls = {
		get: [] as string[],
		post: [] as { path: string; body?: unknown }[],
		put: [] as { path: string; body?: unknown }[],
	};
	const client: ApiClient = {
		get: async <T,>(path: string) => {
			calls.get.push(path);
			return {} as T;
		},
		post: async <T,>(path: string, body?: unknown) => {
			calls.post.push({ path, body });
			return {} as T;
		},
		put: async <T,>(path: string, body?: unknown) => {
			calls.put.push({ path, body });
			return { status: "rescored", count } as T;
		},
		delete: async <T,>(_path: string) => {
			return {} as T;
		},
	};
	return { client, calls };
}

describe("CriteriaForm", () => {
	it("全正規キーの設定行を描画する", () => {
		render(<CriteriaForm items={buildItems()} api={fakeApi().client} />);
		expect(screen.getByText("想定年収")).toBeInTheDocument();
		expect(screen.getByText("リモートワーク")).toBeInTheDocument();
		expect(screen.getByText("スキル適合")).toBeInTheDocument();
		expect(screen.getByText("福利厚生の充実")).toBeInTheDocument();
	});

	it("重みを編集して保存すると変換後 items を PUT /api/config へ送り、抽出(AI)は呼ばない", async () => {
		const { client, calls } = fakeApi(7);
		const onRescored = vi.fn();
		render(
			<CriteriaForm
				items={buildItems()}
				api={client}
				onRescored={onRescored}
			/>,
		);

		fireEvent.change(screen.getByLabelText("重み（想定年収）"), {
			target: { value: "5" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(calls.put.length).toBe(1));
		expect(calls.put[0].path).toBe("/config");
		const body = calls.put[0].body as { items: CriteriaConfigInput[] };
		const salary = body.items.find((i) => i.criterion === "annualSalary");
		expect(salary?.weight).toBe(5);
		// 抽出系（AI）は一切叩かない＝再スコアのみ（抽出↔スコア分離 §5.3）。
		expect(calls.post.length).toBe(0);
		expect(onRescored).toHaveBeenCalledWith(7);
	});

	it("カテゴリ選択を preferred として保存に反映する", async () => {
		const { client, calls } = fakeApi();
		render(<CriteriaForm items={buildItems()} api={client} />);

		fireEvent.click(screen.getByRole("checkbox", { name: "フルリモート" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(calls.put.length).toBe(1));
		const body = calls.put[0].body as { items: CriteriaConfigInput[] };
		const remote = body.items.find((i) => i.criterion === "remoteWork");
		expect(remote?.desired).toEqual({ preferred: ["full"] });
	});

	it("保存成功で再スコア件数を表示する", async () => {
		const { client } = fakeApi(12);
		render(<CriteriaForm items={buildItems()} api={client} />);

		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(await screen.findByRole("status")).toHaveTextContent("12");
	});
});
