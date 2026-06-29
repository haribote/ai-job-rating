// 国税庁 法人番号 Web-API クライアント（企業名 → 法人番号の名寄せ強化・要件 §7.2 / #32）。
//
// なぜこのモジュールが存在するか:
// - 企業名は表記揺れするため、可能なら法人番号で一意化して評判キャッシュの取り違えを防ぐ（§7.2）。
// - 外部 API はアダプタ（CorporateNumberClient）越しにし、本体ロジックは fetch を注入して
//   フル offline・決定的にテストできるようにする。未設定・失敗・該当なしは空配列で中立に倒し、
//   名寄せが落ちても求人処理をブロックしない（unknown 中立 §5.2）。
// - アプリケーションID 等のアカウント固有値・秘匿値は直書きせず env 経由で注入する（フォーク容易性 §8）。
//
// 一次ソース: https://www.houjin-bangou.nta.go.jp/webapi/
//   - エンドポイント base: https://api.houjin-bangou.nta.go.jp/4/
//   - name 検索: GET /4/name?id=<アプリケーションID>&name=<法人名> …（type/mode 等の応答形式・
//     検索条件コードと XML 全体の形は live でのみ確定するため 要手動検証）。

// 名寄せ候補（基本3情報のうち本機能が使う 2 つ）。corporateNumber は 13 桁、name は商号又は名称。
export interface CorporateNumberMatch {
	readonly corporateNumber: string;
	readonly name: string;
}

// 外部 API の差し替え点。テストは Fake/注入 fetch で回し、本番は NTA クライアントを使う。
export interface CorporateNumberClient {
	// 企業名から候補を引く。未設定・失敗・該当なしは [] を返し中立に倒す（非ブロック）。
	lookupByName(name: string): Promise<readonly CorporateNumberMatch[]>;
}

// Web-API v4 のエンドポイント base（公式）。フォーク先は baseUrl で上書きできる。
export const DEFAULT_HOUJIN_BANGOU_BASE_URL =
	"https://api.houjin-bangou.nta.go.jp/4";

// 応答形式コード（公式の type）。12=XML(UTF-8) を既定とするが、正確なコード・mode 等は要手動検証。
const DEFAULT_RESPONSE_TYPE = "12";

export interface NtaClientConfig {
	// アプリケーションID（秘匿・env 注入）。空なら API を呼ばず中立に倒す。
	applicationId: string;
	// エンドポイント base の上書き（既定 DEFAULT_HOUJIN_BANGOU_BASE_URL）。
	baseUrl?: string;
	// 注入 fetch（テスト用）。既定はグローバル fetch。
	fetchImpl?: typeof fetch;
}

// name 検索 URL を決定的に組み立てる（純関数）。企業名は URL エンコードされる。
export function buildNameLookupUrl(
	config: Pick<NtaClientConfig, "applicationId" | "baseUrl">,
	name: string,
): string {
	const base = config.baseUrl ?? DEFAULT_HOUJIN_BANGOU_BASE_URL;
	const url = new URL(`${base}/name`);
	url.searchParams.set("id", config.applicationId);
	url.searchParams.set("name", name);
	url.searchParams.set("type", DEFAULT_RESPONSE_TYPE);
	return url.toString();
}

// 各レコードを囲む corporation ブロック。
const CORPORATION_BLOCK_PATTERN =
	/<corporation\b[^>]*>([\s\S]*?)<\/corporation>/g;
const CORPORATE_NUMBER_PATTERN =
	/<corporateNumber>\s*(\d{13})\s*<\/corporateNumber>/;
const NAME_PATTERN = /<name>([\s\S]*?)<\/name>/;

// name 検索の XML 応答から corporateNumber/name の組を決定的に抽出する（純関数）。
// 正規表現抽出にして要素順序・属性差異に頑健にする。両フィールドが揃わないブロックは捨てる。
export function parseCorporateNumberXml(
	xml: string,
): readonly CorporateNumberMatch[] {
	const matches: CorporateNumberMatch[] = [];
	for (const block of xml.matchAll(CORPORATION_BLOCK_PATTERN)) {
		const body = block[1];
		const number = body.match(CORPORATE_NUMBER_PATTERN)?.[1];
		const name = body.match(NAME_PATTERN)?.[1]?.trim();
		if (number && name) {
			matches.push({ corporateNumber: number, name });
		}
	}
	return matches;
}

// NTA Web-API クライアント。applicationId 未設定・失敗・例外は空配列で中立に倒す（非ブロック）。
// 注意（要手動検証）: 実エンドポイント・パラメータ・XML 全体の形は live でのみ確定する。本体ロジック
// （URL 生成・パース・中立フォールバック）は注入 fetch でオフライン検証済み。
export function createNtaCorporateNumberClient(
	config: NtaClientConfig,
): CorporateNumberClient {
	const fetchImpl = config.fetchImpl ?? fetch;
	return {
		async lookupByName(name) {
			if (config.applicationId.trim() === "" || name.trim() === "") {
				return [];
			}
			try {
				const res = await fetchImpl(buildNameLookupUrl(config, name));
				if (!res.ok) {
					return [];
				}
				return parseCorporateNumberXml(await res.text());
			} catch {
				// 名寄せ強化は best-effort。失敗しても求人処理を止めない。
				return [];
			}
		},
	};
}

// API 無効時の既定クライアント（常に空配列＝中立）。
export const NULL_CORPORATE_NUMBER_CLIENT: CorporateNumberClient = {
	async lookupByName() {
		return [];
	},
};
