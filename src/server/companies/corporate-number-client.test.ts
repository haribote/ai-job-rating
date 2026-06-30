import { describe, expect, it } from "vitest";
import { resolveCorporateNumberClient } from "./corporate-number-client";
import { NULL_CORPORATE_NUMBER_CLIENT } from "./houjin-bangou";

// env presence による client 選択のみを検証する（live エンドポイントは 要手動検証・#116）。
describe("resolveCorporateNumberClient（env 駆動の法人番号クライアント選択）", () => {
	it("HOUJIN_BANGOU_APP_ID 未設定は中立な NULL クライアントへ倒す", () => {
		expect(resolveCorporateNumberClient({})).toBe(NULL_CORPORATE_NUMBER_CLIENT);
	});

	it("空文字・空白のみも未設定扱い（NULL クライアント）", () => {
		expect(resolveCorporateNumberClient({ HOUJIN_BANGOU_APP_ID: "" })).toBe(
			NULL_CORPORATE_NUMBER_CLIENT,
		);
		expect(resolveCorporateNumberClient({ HOUJIN_BANGOU_APP_ID: "   " })).toBe(
			NULL_CORPORATE_NUMBER_CLIENT,
		);
	});

	it("applicationId 設定済みは NTA クライアント（NULL とは別実体）を返す", () => {
		const client = resolveCorporateNumberClient({
			HOUJIN_BANGOU_APP_ID: "app-id",
		});
		expect(client).not.toBe(NULL_CORPORATE_NUMBER_CLIENT);
		expect(typeof client.lookupByName).toBe("function");
	});
});
