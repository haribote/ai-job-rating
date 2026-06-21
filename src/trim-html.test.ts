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
});
