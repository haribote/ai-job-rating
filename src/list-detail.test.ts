import { describe, expect, it } from "vitest";
import { classifyPage, extractDetailUrls, normalizeUrl } from "./list-detail";

// URL 正規化（決定的）: 後続 #24/#25 が同一 URL を二重処理しないよう、表記揺れを正規キーへ寄せる。
describe("normalizeUrl", () => {
	// 相対パスはページ URL を基準に絶対化する（一覧→詳細リンクは相対指定が多い）
	it("相対パスを base URL で絶対化する", () => {
		expect(normalizeUrl("/jobs/42", "https://example.com/jobs")).toBe(
			"https://example.com/jobs/42",
		);
	});

	// フラグメントは同一リソースを指すので除去して重複を防ぐ
	it("フラグメントを除去する", () => {
		expect(
			normalizeUrl("https://example.com/jobs/42#apply", "https://example.com"),
		).toBe("https://example.com/jobs/42");
	});

	// 末尾スラッシュの有無は同一とみなして揃える（重複排除のため）
	it("末尾スラッシュを除去して揃える", () => {
		expect(
			normalizeUrl("https://example.com/jobs/42/", "https://example.com"),
		).toBe("https://example.com/jobs/42");
	});

	// クエリは求人 ID を担うことがあるので温存する（情報欠落を避ける）
	it("クエリ文字列は温存する", () => {
		expect(
			normalizeUrl("https://example.com/job?id=42", "https://example.com"),
		).toBe("https://example.com/job?id=42");
	});

	// クエリ付き URL の末尾スラッシュは畳まない。/jobs/?id=1 と /jobs?id=1 を
	// 別リソースとするサイトがあり、クエリで求人を区別する前提と衝突するため。
	it("クエリ付き URL の末尾スラッシュは温存する", () => {
		expect(
			normalizeUrl("https://example.com/jobs/?id=1", "https://example.com"),
		).toBe("https://example.com/jobs/?id=1");
	});

	// 解釈できない href は正規化対象外として null を返す（後続から除外する）
	it("不正な href は null", () => {
		expect(
			normalizeUrl("javascript:void(0)", "https://example.com"),
		).toBeNull();
		expect(
			normalizeUrl("mailto:a@example.com", "https://example.com"),
		).toBeNull();
		expect(normalizeUrl("", "https://example.com")).toBeNull();
	});
});

// 詳細 URL 抽出（決定的）: 同一オリジンの詳細リンク群を重複なく取り出す。
describe("extractDetailUrls", () => {
	const base = "https://example.com/jobs";

	// 同一オリジンのリンクを抽出する。クロスオリジン・非 http(s) は除外（取得対象外）
	it("同一オリジンのリンクのみ抽出する", () => {
		const html = `
			<a href="/jobs/1">A</a>
			<a href="/jobs/2">B</a>
			<a href="https://other.com/jobs/3">外部</a>
			<a href="mailto:x@example.com">mail</a>
		`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
			"https://example.com/jobs/2",
		]);
	});

	// 同一 URL の重複（末尾スラッシュ違い・フラグメント違い含む）は 1 件に畳む
	it("重複 URL を 1 件に畳む", () => {
		const html = `
			<a href="/jobs/1">A</a>
			<a href="/jobs/1/">A 別表記</a>
			<a href="/jobs/1#detail">A アンカー</a>
		`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
		]);
	});

	// ページ自身（base と同一）への自己リンクは詳細候補から除外する
	it("ページ自身へのリンクは除外する", () => {
		const html = `
			<a href="/jobs">一覧へ戻る</a>
			<a href="/jobs/1">A</a>
		`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
		]);
	});

	// 出現順を保ち決定的に返す（同一入力→同一出力、後続処理の再現性のため）
	it("出現順を保つ", () => {
		const html = `<a href="/jobs/9">9</a><a href="/jobs/3">3</a>`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/9",
			"https://example.com/jobs/3",
		]);
	});

	// 単引用符・引用符なし href も拾う（実データの HTML は多様）
	it("引用符の種類に依存せず href を拾う", () => {
		const html = `<a href='/jobs/1'>A</a><a href=/jobs/2>B</a>`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
			"https://example.com/jobs/2",
		]);
	});

	// data-href 等の接尾辞属性は遷移先 href ではないので拾わない（解析用属性の誤抽出を防ぐ）
	it("data-href 等の接尾辞属性は拾わない", () => {
		const html = `
			<a data-href="/tracking/1">解析用</a>
			<a href="/jobs/1">本物</a>
		`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
		]);
	});

	// script/style/コメント内の a href リテラルは実リンクではないので拾わない（件数水増しを防ぐ）
	it("script・コメント内の href リテラルは拾わない", () => {
		const html = `
			<!-- <a href="/jobs/old">過去版</a> -->
			<script>var s = '<a href="/jobs/script">';</script>
			<a href="/jobs/1">本物</a>
		`;
		expect(extractDetailUrls(html, base)).toEqual([
			"https://example.com/jobs/1",
		]);
	});
});

// 一覧/詳細判定（決定的）: 同一オリジン詳細リンク数のヒューリスティックで分類する。
describe("classifyPage", () => {
	const base = "https://example.com/jobs";

	// 詳細リンクが閾値以上なら一覧ページと判定し、詳細 URL 群を返す
	it("詳細リンクが多数なら list と判定する", () => {
		const html = `
			<a href="/jobs/1">1</a>
			<a href="/jobs/2">2</a>
			<a href="/jobs/3">3</a>
		`;
		const result = classifyPage(html, base);
		expect(result.kind).toBe("list");
		if (result.kind === "list") {
			expect(result.detailUrls).toEqual([
				"https://example.com/jobs/1",
				"https://example.com/jobs/2",
				"https://example.com/jobs/3",
			]);
		}
	});

	// 詳細候補リンクがない（または閾値未満）なら詳細ページと判定する
	it("詳細リンクが乏しければ detail と判定する", () => {
		const html = `
			<h1>ソフトウェアエンジニア募集</h1>
			<p>年収 700万〜900万</p>
			<a href="/company">運営会社</a>
		`;
		const result = classifyPage(html, base);
		expect(result.kind).toBe("detail");
	});

	// 同一オリジンでも自己リンクのみなら詳細ページ（一覧ではない）
	it("自己リンクしかなければ detail と判定する", () => {
		const html = `<a href="/jobs">一覧</a><a href="#top">先頭へ</a>`;
		const result = classifyPage(html, base);
		expect(result.kind).toBe("detail");
	});
});
