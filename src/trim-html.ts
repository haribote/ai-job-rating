// 生 HTML から求人本文を抽出・トリミングし AI 入力（#11 構造化抽出）の入力トークンを削減する純関数。
// 責務は「本文抽出・トリミング」のみ: fetch（#8）・AI 抽出（#11）・スコアリング（#12）・
// ラベル正規化（#10）は持ち込まない。ネットワーク不要・同期・決定的でユニットテスト可能にする。
//
// パース手段は文字列処理を選択（HTMLRewriter ではない）。理由:
//  - HTMLRewriter は非同期ストリーミング parser で取得時 transform 向き。#9 は決定的な同期純関数が要件のため不適。
//  - 追加依存ゼロでフォーク容易性（CLAUDE.md）と min-release-age 制約を満たす。
//  - 求人ページは SSR のテキスト主体で、完全な DOM ツリーは不要。script/style/不要タグ除去＋空白正規化で十分に減量できる。
//
// 出力形はプレーンテキスト。理由: §7.1 の目的は入力トークン削減。タグやマークアップは抽出に不要で、
// AI（#11）は本文（ミッション・業務内容等）の自然言語を読む。ブロック境界のみ改行で保持し語の結合を防ぐ。

// 中身ごと丸ごと捨てる要素（本文でないノイズ）。i フラグで大小文字無視。
const STRIP_WITH_CONTENT =
	/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

// ブロックレベル要素の開始/終了。境界を改行に置換し、隣接ブロックの語が結合するのを防ぐ。
const BLOCK_BOUNDARY =
	/<\/?(p|div|section|article|main|header|footer|nav|aside|h[1-6]|ul|ol|li|table|tr|br|hr|blockquote)\b[^>]*>/gi;

// タグらしい構造のみにマッチする（開始タグ・終了タグ・宣言/コメント）。
// 先頭が英字・`/`・`!`・`?` の場合だけタグとみなす。理由: 本文中の
// `経験 < 3年 > 不可` のような生の不等号をタグ誤認して削除しないため（#55 課題2）。
const TAG = /<[/!?]?[a-z][^>]*>/gi;

// 名前付き実体のセット。求人本文に現れる代表的なものに限定する
// （通貨・単価記号・箇条書き記号など #55 で拡充）。完全な HTML5 実体表は持たない。
// 大小文字を問わず lower-case キーで引くため、キーはすべて小文字で定義する。
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	yen: "¥",
	cent: "¢",
	pound: "£",
	euro: "€",
	times: "×",
	divide: "÷",
	plusmn: "±",
	middot: "·",
	bull: "•",
	deg: "°",
	sup2: "²",
	sup3: "³",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	sect: "§",
	para: "¶",
	dagger: "†",
	laquo: "«",
	raquo: "»",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

// 本文に意味のない制御文字を完全除去する（#55 課題1）。対象は C0 制御文字（U+0000–U+001F）
// と DEL（U+007F）のうち、整形に使う tab/LF/CR/VT/FF を除いたもの。理由: NUL(&#0;)・BS(&#8;)
// 等は本文でなく、下流 #11 の JSON 直列化に壊れた制御文字を持ち込むため。tab/LF/CR/VT/FF は
// 除去せず後段の空白正規化で空白/改行へ畳む。数値参照デコード後に現れる制御文字もここで除去する。
// 範囲: U+0000–U+0008, U+000E–U+001F, U+007F（U+0009 tab/U+000A LF/U+000B VT/U+000C FF/U+000D CR を除外）。
// 正規表現に制御文字を直書きすると lint（noControlCharactersInRegex）に触れるため code point で判定する。
const TAB = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const DEL = 0x7f;
function stripControlChars(text: string): string {
	let result = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const isC0 = code <= 0x1f;
		const isFormatting =
			code === TAB || code === LF || code === VT || code === FF || code === CR;
		if ((isC0 && !isFormatting) || code === DEL) {
			continue;
		}
		result += char;
	}
	return result;
}

// HTML エンティティ（数値参照・名前付き）を本文の文字へデコードする。
function decodeEntities(text: string): string {
	return text.replace(
		/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi,
		(match, body: string) => {
			if (body[0] === "#") {
				const codePoint =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				// 不正なコードポイントは元の文字列を温存する（壊れた入力で例外にしない）。
				// サロゲート範囲（U+D800–U+DFFF）も除外する: 単独サロゲートを出力に漏らすと
				// 下流 #11 の JSON 直列化で壊れた符号単位になるため。
				if (
					Number.isNaN(codePoint) ||
					codePoint < 0 ||
					codePoint > 0x10ffff ||
					(codePoint >= 0xd800 && codePoint <= 0xdfff)
				) {
					return match;
				}
				return String.fromCodePoint(codePoint);
			}
			const named = NAMED_ENTITIES[body.toLowerCase()];
			return named ?? match;
		},
	);
}

// 生 HTML 文字列を受け取り、AI 入力向けのトリミング済みプレーンテキストを返す。
export function trimHtml(rawHtml: string): string {
	return (
		rawHtml
			// 1. script/style 等を中身ごと除去（最優先: タグ除去前に中身を消す）
			.replace(STRIP_WITH_CONTENT, " ")
			// 2. HTML コメントを除去
			.replace(/<!--[\s\S]*?-->/g, " ")
			// 3. ブロック境界を改行に変換し語の結合を防ぐ
			.replace(BLOCK_BOUNDARY, "\n")
			// 4. 残りのタグ（インライン等）を除去。タグらしい構造のみ対象にし生の `<` は残す
			.replace(TAG, " ")
			// 5. 制御文字を除去し、エンティティをデコード（タグ除去後にやることで `<` 等の誤再解釈を避ける）
			.split("\n")
			.map((line) =>
				stripControlChars(decodeEntities(line))
					// 制御文字除去後に空白系（tab/CR/VT/FF/連続空白）を 1 つの空白へ畳む
					.replace(/[ \t\f\v\r]+/g, " ")
					.trim(),
			)
			.filter((line) => line !== "")
			// 6. 行を連結。最大でも 1 つの改行で段落を区切る
			.join("\n")
			.trim()
	);
}
