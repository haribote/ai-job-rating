import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
