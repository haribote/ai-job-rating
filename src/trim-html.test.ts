import { describe, expect, it } from "vitest";
import { trimHtml } from "./trim-html";

// script/style/不要タグを含む代表的な合成 HTML fixture。
// 実ページ（herp.careers 等）を直コミットせず、本文 + ノイズの構造だけ再現する。
const FIXTURE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>採用情報 | Example Inc.</title>
    <style>body { color: #333; } .nav { display: none; }</style>
    <script type="application/ld+json">{"@type":"JobPosting","title":"x"}</script>
  </head>
  <body>
    <nav class="global-nav"><a href="/">Home</a><a href="/about">About</a></nav>
    <main>
      <h1>ソフトウェアエンジニア</h1>
      <section>
        <h2>ミッション</h2>
        <p>私たちは&quot;働く&quot;の課題を解決します。</p>
      </section>
      <section>
        <h2>業務内容</h2>
        <ul>
          <li>バックエンド開発</li>
          <li>インフラ構築 &amp; 運用</li>
        </ul>
      </section>
    </main>
    <script>window.__DATA__ = { hydrate: true };</script>
    <footer><small>&copy; Example Inc.</small></footer>
  </body>
</html>`;

describe("trimHtml", () => {
	// 本文（ミッション・業務内容）が残ることがトリミングの主目的
	it("本文テキストを残す", () => {
		const out = trimHtml(FIXTURE);
		expect(out).toContain("ソフトウェアエンジニア");
		expect(out).toContain("ミッション");
		expect(out).toContain("バックエンド開発");
		expect(out).toContain("インフラ構築");
	});

	// script の中身は本文でないので AI 入力から除外する
	it("script の中身を除去する", () => {
		const out = trimHtml(FIXTURE);
		expect(out).not.toContain("hydrate");
		expect(out).not.toContain("JobPosting");
		expect(out).not.toContain("__DATA__");
	});

	// 隣接する複数の script を非貪欲に各個除去し、間の本文を巻き込まない
	it("隣接する複数 script の間の本文を残す", () => {
		const out = trimHtml("<script>a()</script><p>本文</p><script>b()</script>");
		expect(out).toBe("本文");
	});

	// style の中身も本文でないので除外する
	it("style の中身を除去する", () => {
		const out = trimHtml(FIXTURE);
		expect(out).not.toContain("color: #333");
		expect(out).not.toContain("display: none");
	});

	// タグ自体は AI 入力では不要なので落とす（出力はプレーンテキスト）
	it("HTML タグを除去する", () => {
		const out = trimHtml(FIXTURE);
		expect(out).not.toMatch(/<[a-z!/]/i);
	});

	// HTML エンティティをデコードして本文を読める形にする
	it("HTML エンティティをデコードする", () => {
		const out = trimHtml(FIXTURE);
		expect(out).toContain('"働く"');
		expect(out).toContain("インフラ構築 & 運用");
		expect(out).not.toContain("&quot;");
		expect(out).not.toContain("&amp;");
	});

	// 連続する空白・改行を畳んで入力トークンを削減する
	it("空白を正規化する", () => {
		const out = trimHtml(FIXTURE);
		expect(out).not.toMatch(/[ \t]{2,}/);
		expect(out).not.toMatch(/\n{3,}/);
		expect(out.trim()).toBe(out);
	});

	// トリミングの目的はサイズ削減。生 HTML より十分に小さくなる
	it("出力サイズが生 HTML より縮む", () => {
		const out = trimHtml(FIXTURE);
		expect(out.length).toBeLessThan(FIXTURE.length / 2);
	});

	// 決定的: 同一入力なら同一出力（スコアリング基盤としての再現性）
	it("同一入力に対して決定的", () => {
		expect(trimHtml(FIXTURE)).toBe(trimHtml(FIXTURE));
	});

	// 空入力・本文なしでも安全に空文字を返す（呼び出し側 #11 の前提を壊さない）
	it("空入力は空文字を返す", () => {
		expect(trimHtml("")).toBe("");
		expect(trimHtml("   \n\t ")).toBe("");
		expect(trimHtml("<script>noise()</script>")).toBe("");
	});

	// ブロック要素境界は改行に落とし、語の結合を防ぐ
	it("ブロック要素の境界で語が結合しない", () => {
		const out = trimHtml("<p>前半</p><p>後半</p>");
		expect(out).not.toContain("前半後半");
	});

	// HTML コメントは本文ではないので除去する
	it("HTML コメントを除去する", () => {
		const out = trimHtml("<p>本文</p><!-- 内部メモ secret -->");
		expect(out).toBe("本文");
	});

	// エンティティはタグ除去後にデコードするため、&lt;b&gt; は本文中の文字列として残りタグ再解釈されない
	it("エンティティ由来の山括弧はタグ再解釈されない", () => {
		const out = trimHtml("<p>&lt;b&gt;太字&lt;/b&gt;</p>");
		expect(out).toBe("<b>太字</b>");
	});

	// 数値文字参照（10進・16進）もデコードする
	it("数値文字参照をデコードする", () => {
		expect(trimHtml("<p>&#x3042;&#12356;</p>")).toBe("あい");
	});

	// 未知の名前付き実体・裸の & は壊れた入力で例外を出さず原文のまま温存する
	it("未知のエンティティと裸の & を温存する", () => {
		expect(trimHtml("<p>R&amp;D &foo; A&B</p>")).toBe("R&D &foo; A&B");
	});

	// 不正な数値文字参照（範囲外コードポイント）も原文のまま温存する
	it("範囲外の数値文字参照を温存する", () => {
		expect(trimHtml("<p>&#xFFFFFF;</p>")).toBe("&#xFFFFFF;");
	});

	// サロゲート範囲の数値参照は単独サロゲートを出力に漏らさない。
	// 下流 #11 の JSON 直列化で壊れた符号単位になるのを防ぐため原文のまま温存する。
	it("サロゲート範囲の数値参照を温存する", () => {
		const out = trimHtml("<p>&#xD800;&#xDFFF;</p>");
		expect(out).toBe("&#xD800;&#xDFFF;");
		expect(/[\ud800-\udfff]/.test(out)).toBe(false);
	});

	// 課題1: C0 制御文字は本文でなく下流 #11 の JSON 直列化を壊すため除去する。
	// tab/改行は空白として扱うので対象外。NUL(&#0;)・BS(&#8;)・ESC 等の数値参照も除去する。
	it("数値参照由来の C0 制御文字を除去する", () => {
		expect(trimHtml("<p>前&#0;後</p>")).toBe("前後");
		expect(trimHtml("<p>前&#8;後</p>")).toBe("前後");
		expect(trimHtml("<p>前&#x1b;後</p>")).toBe("前後");
	});

	// 課題1: 生 HTML 中に紛れた C0 制御文字・DEL も同様に除去する。
	it("生の制御文字を除去する", () => {
		expect(trimHtml("<p>前\x00\x08\x1b\x7f後</p>")).toBe("前後");
	});

	// 課題1: 垂直タブ・改ページ・復帰は空白として畳む（連続でも 1 つの空白）。
	it("垂直系空白を空白として正規化する", () => {
		expect(trimHtml("<p>前\v\f\r後</p>")).toBe("前 後");
	});

	// 課題2: 本文中の生 `<`〜`>` をタグと誤認して削除しない（不等号・範囲表記の保全）。
	it("本文中の生の山括弧をタグ誤認で削除しない", () => {
		expect(trimHtml("<p>経験 < 3年 > 不可</p>")).toBe("経験 < 3年 > 不可");
	});

	// 課題2: タグらしい形（英字・/・!・? で始まる）のみ除去し、それ以外の `<` は残す。
	it("タグらしくない山括弧は本文として残す", () => {
		expect(trimHtml("<p>x < y かつ y > z</p>")).toBe("x < y かつ y > z");
	});

	// 課題3: 求人本文に現れる名前付き実体（通貨・記号）を拡充してデコードする。
	it("拡充した名前付き実体をデコードする", () => {
		expect(
			trimHtml("<p>&yen;500 &times; &middot; &bull; &deg; &euro;</p>"),
		).toBe("¥500 × · • ° €");
	});

	// 課題2: 宣言・CDATA・PI は本文でないので除去する（不等号保全のために漏らさない）。
	it("宣言・CDATA・PI を除去する", () => {
		expect(trimHtml("<!DOCTYPE html><p>本文</p>")).toBe("本文");
		expect(trimHtml("<p>前<![CDATA[ junk ]]>後</p>")).toBe("前 後");
		expect(trimHtml("<p>前<?xml version='1.0'?>後</p>")).toBe("前 後");
	});
});
