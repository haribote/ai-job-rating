import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NORMALIZED_KEYS } from "../../shared/job-schema";
import { CRITERION_META, type CriteriaConfigItem } from "../lib/criteria";
import { Settings } from "./Settings";

// 設定ビュー（全画面ルート）。GET /api/config を取得して CriteriaForm を描画する。
// e2e セレクタ settings-view は取得中も保持する（SPA フォールバックの直接アクセス検証のため）。

function buildItems(): CriteriaConfigItem[] {
	return NORMALIZED_KEYS.map((criterion) => ({
		criterion,
		kind: CRITERION_META[criterion].kind,
		weight: 1,
		hardFilter: "none" as const,
		desired: null,
	}));
}

describe("Settings", () => {
	it("取得中も settings-view を保ちローディングを表示する", () => {
		render(<Settings configFetcher={() => new Promise(() => {})} />);
		expect(screen.getByTestId("settings-view")).toBeInTheDocument();
		expect(screen.getByTestId("settings-loading")).toBeInTheDocument();
	});

	it("取得成功で設定フォームを描画する", async () => {
		render(<Settings configFetcher={async () => buildItems()} />);
		expect(await screen.findByText("想定年収")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
	});

	it("取得失敗でエラーを表示する", async () => {
		render(
			<Settings
				configFetcher={async () => {
					throw new Error("boom");
				}}
			/>,
		);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
	});

	// 既定 configFetcher（prop 未指定）でも取得が 1 回で収束することを担保する。
	// 既定値をレンダごとに生成すると useEffect 依存が毎回変わり無限再取得になる回帰を防ぐ。
	it("既定の取得経路は再レンダで再取得ループしない（config は 1 回で収束）", async () => {
		// Settings は config と評判取得元（#34）の 2 経路を持つ。URL で出し分け、config が
		// 1 回で収束する（無限再取得しない）ことを担保する。
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : String(input);
				const body = url.includes("/reputation/sources")
					? { sources: [] }
					: { items: [] };
				return Promise.resolve(
					new Response(JSON.stringify(body), {
						headers: { "content-type": "application/json" },
					}),
				);
			});
		render(<Settings />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument(),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const configCalls = fetchSpy.mock.calls.filter(([input]) =>
			(typeof input === "string" ? input : String(input)).includes("/config"),
		);
		expect(configCalls).toHaveLength(1);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
