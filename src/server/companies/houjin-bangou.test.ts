import { describe, expect, it } from "vitest";
import {
	buildNameLookupUrl,
	createNtaCorporateNumberClient,
	DEFAULT_HOUJIN_BANGOU_BASE_URL,
	NULL_CORPORATE_NUMBER_CLIENT,
	parseCorporateNumberXml,
} from "./houjin-bangou";

// 国税庁 法人番号 Web-API v4 の name 検索が返す XML を模した代表レスポンス。
// 要素名（corporateNumber / name）は基本3情報の公式フィールド名。実レスポンス全体の形は要手動検証。
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<corporations>
  <corporation>
    <sequenceNumber>1</sequenceNumber>
    <corporateNumber>5010401052465</corporateNumber>
    <name>株式会社サイバーエージェント</name>
    <prefectureName>東京都</prefectureName>
  </corporation>
  <corporation>
    <sequenceNumber>2</sequenceNumber>
    <corporateNumber>1234567890123</corporateNumber>
    <name>サイバー株式会社</name>
  </corporation>
</corporations>`;

describe("buildNameLookupUrl（決定的な name 検索 URL 生成）", () => {
	it("base / id / name を組み立て企業名を URL エンコードする", () => {
		const url = buildNameLookupUrl(
			{ applicationId: "APP-ID-123" },
			"株式会社サイバーエージェント",
		);
		const parsed = new URL(url);
		expect(`${parsed.origin}${parsed.pathname}`).toBe(
			`${DEFAULT_HOUJIN_BANGOU_BASE_URL}/name`,
		);
		expect(parsed.searchParams.get("id")).toBe("APP-ID-123");
		expect(parsed.searchParams.get("name")).toBe(
			"株式会社サイバーエージェント",
		);
	});

	it("baseUrl を上書きできる（フォーク容易性）", () => {
		const url = buildNameLookupUrl(
			{ applicationId: "x", baseUrl: "https://example.test/v4" },
			"メルカリ",
		);
		expect(url.startsWith("https://example.test/v4/name?")).toBe(true);
	});
});

describe("parseCorporateNumberXml（決定的な XML パース）", () => {
	it("corporateNumber と name の組を順序通り抽出する", () => {
		expect(parseCorporateNumberXml(SAMPLE_XML)).toEqual([
			{
				corporateNumber: "5010401052465",
				name: "株式会社サイバーエージェント",
			},
			{ corporateNumber: "1234567890123", name: "サイバー株式会社" },
		]);
	});

	it("該当なし・空文字は空配列を返す", () => {
		expect(parseCorporateNumberXml("<corporations></corporations>")).toEqual(
			[],
		);
		expect(parseCorporateNumberXml("")).toEqual([]);
	});
});

describe("createNtaCorporateNumberClient（注入 fetch でオフライン検証）", () => {
	it("applicationId 未設定なら fetch せず中立（空配列）に倒す", async () => {
		let called = false;
		const client = createNtaCorporateNumberClient({
			applicationId: "",
			fetchImpl: async () => {
				called = true;
				return new Response("");
			},
		});
		expect(await client.lookupByName("メルカリ")).toEqual([]);
		expect(called).toBe(false);
	});

	it("成功レスポンスをパースして候補を返す", async () => {
		const client = createNtaCorporateNumberClient({
			applicationId: "APP",
			fetchImpl: async () => new Response(SAMPLE_XML, { status: 200 }),
		});
		const matches = await client.lookupByName("サイバーエージェント");
		expect(matches[0]?.corporateNumber).toBe("5010401052465");
	});

	it("非 2xx 応答は中立（空配列）に倒す", async () => {
		const client = createNtaCorporateNumberClient({
			applicationId: "APP",
			fetchImpl: async () => new Response("error", { status: 500 }),
		});
		expect(await client.lookupByName("x")).toEqual([]);
	});

	// なぜ: 評判の前段で名寄せが落ちても求人処理をブロックしない（unknown 中立）。
	it("fetch 例外は握って中立（空配列）に倒す", async () => {
		const client = createNtaCorporateNumberClient({
			applicationId: "APP",
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		expect(await client.lookupByName("x")).toEqual([]);
	});
});

describe("NULL_CORPORATE_NUMBER_CLIENT", () => {
	it("常に空配列を返す（API 無効時の既定）", async () => {
		expect(await NULL_CORPORATE_NUMBER_CLIENT.lookupByName("any")).toEqual([]);
	});
});
