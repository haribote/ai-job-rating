// 企業名の正規化と名寄せキー生成（要件 §6 companies / §7.2 名寄せ・スコア統合 / #32）。
//
// なぜこのモジュールが存在するか:
// - 求人ごとに揺れる企業表記を決定的に 1 つの企業へ寄せ、評判を企業単位でキャッシュできるようにする。
//   後続 #33（reputation の企業単位キャッシュ）は本モジュールの companyKey を一意化キーとして消費する。
// - スコアリング側の「ラベル正規化」と同じ思想だが、対象は採点キーでなく企業の同一性。純関数として
//   切り出し、I/O（D1・法人番号 API）に依存しないことでフル offline・決定的にテストできる（§8）。

// 法人種別語（前株・後株どちらの位置でも企業の同一性に無関係なので名寄せキーから除去する）。
// NFKC 後の半角・展開済み表記で持つ（㈱→"(株)"、（株）→"(株)" は NFKC が吸収する）。
// 長い表記を先に除去するため文字数降順で適用する（例: 一般社団法人 を 社団法人 より先に）。
const LEGAL_ENTITY_TERMS: readonly string[] = [
	"特定非営利活動法人",
	"地方独立行政法人",
	"独立行政法人",
	"国立大学法人",
	"一般社団法人",
	"一般財団法人",
	"公益社団法人",
	"公益財団法人",
	"社会福祉法人",
	"医療法人社団",
	"医療法人財団",
	"医療法人",
	"学校法人",
	"宗教法人",
	"株式会社",
	"有限会社",
	"合同会社",
	"合資会社",
	"合名会社",
	// NFKC で展開される括弧付き略号（㈱→"(株)" 等）。
	"(株)",
	"(有)",
	"(同)",
	"(資)",
	"(名)",
	"(社)",
	"(財)",
];

// 文字数降順に固定し、長い種別語の取りこぼし（部分一致での誤削除）を防ぐ。
const LEGAL_ENTITY_TERMS_DESC: readonly string[] = [...LEGAL_ENTITY_TERMS].sort(
	(a, b) => b.length - a.length,
);

// 名寄せキーから落とすノイズ文字。空白（NFKC で半角化済み）と中黒のみに限定する。
// 長音符・ハイフン等の弁別に効く文字は残し、過剰併合を避ける。
const KEY_NOISE_PATTERN = /[\s・]/gu;

// 表示用の決定的正規化。NFKC で全角英数記号を半角へ寄せ、前後空白を落とすだけに留める
// （法人種別語は表示では残す）。UI の企業名表示・最初に観測した生表記の保存に使う。
export function normalizeCompanyName(raw: string): string {
	return raw.normalize("NFKC").trim();
}

// 名寄せキー（決定的）。NFKC → 法人種別語の除去 → ノイズ除去 → 小文字化の順で適用する。
// 同一企業の表記揺れ（前株/後株/(株)/㈱/全角/大小/空白/中黒）を 1 キーへ収束させる。
export function companyKey(raw: string): string {
	let s = raw.normalize("NFKC");
	for (const term of LEGAL_ENTITY_TERMS_DESC) {
		s = s.split(term).join("");
	}
	s = s.replace(KEY_NOISE_PATTERN, "").toLowerCase();
	// 種別語のみの入力で空になった場合は決定的にフォールバックし、空キーを返さない。
	if (s.length === 0) {
		return raw.normalize("NFKC").trim().toLowerCase();
	}
	return s;
}
