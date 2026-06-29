import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReputationApiKeyConfig } from "../lib/reputation";
import { ReputationApiKeySection } from "./ReputationApiKeySection";

// 評判 API キー設定節（#31）。presence に応じて案内を出し分け、未実装のスコア数値を描かないことを担保する。
describe("ReputationApiKeySection", () => {
	const configFetcher =
		(config: ReputationApiKeyConfig) => (): Promise<ReputationApiKeyConfig> =>
			Promise.resolve(config);

	it("未構成なら設定方法（wrangler secret / .dev.vars）を案内する", async () => {
		render(
			<ReputationApiKeySection
				configFetcher={configFetcher({ apiKeyConfigured: false })}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("reputation-api-key-status")).toHaveTextContent(
				/未設定/,
			);
		});
		// フォーク先が設定できるよう注入元の案内を出す。
		expect(screen.getByTestId("reputation-api-key-section")).toHaveTextContent(
			/wrangler secret/,
		);
		expect(screen.getByTestId("reputation-api-key-section")).toHaveTextContent(
			/\.dev\.vars/,
		);
	});

	it("構成済みなら設定済みと表示し、設定方法の案内は出さない", async () => {
		render(
			<ReputationApiKeySection
				configFetcher={configFetcher({ apiKeyConfigured: true })}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("reputation-api-key-status")).toHaveTextContent(
				/設定済み/,
			);
		});
		expect(
			screen.queryByTestId("reputation-api-key-setup-guide"),
		).not.toBeInTheDocument();
	});

	it("スコア数値表示は #36/#37 待ちの旨を明示し、未実装の数値を描かない", async () => {
		render(
			<ReputationApiKeySection
				configFetcher={configFetcher({ apiKeyConfigured: true })}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("reputation-score-placeholder"),
			).toBeInTheDocument();
		});
	});

	it("取得失敗時はエラーを表示する", async () => {
		render(
			<ReputationApiKeySection
				configFetcher={() => Promise.reject(new Error("boom"))}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeInTheDocument();
		});
	});
});
