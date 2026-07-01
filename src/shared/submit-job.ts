// 求人投入 API（POST /api/jobs）の共有契約型（#187）。
//
// なぜ shared に置くか:
// - 従来 client(AddJobModal) と server(app.ts の ad-hoc パース) が投入契約を人力同期していた。
//   Cookie フィールド追加を機に単一ソースへ集約し、双方が import して乖離を防ぐ。
// - 依存ゼロの純粋型のみ（D1/fetch/React を引かない）。client/server どちらからも安全に import できる。

// 抽出状態（契約。サーバ db-schema ExtractionStatus と同値）。求人取込時の抽出成否を表す。
export type ExtractionStatus = "ok" | "partial" | "failed";

// POST /api/jobs のリクエストボディ。url か html の排他（#95）。
// cookie は URL 投入時のみ有効な任意フィールド（認証下ページ取得用・#187）。
// 秘匿値のため取得時のリクエストヘッダにのみ使い、永続化・ログ出力しない。
export type JobSubmissionBody =
	| { url: string; cookie?: string }
	| { html: string };

// POST /api/jobs の応答（#95）。詳細/貼付は jobId＋抽出状態、一覧 URL はキュー投入件数。
export type SubmitJobResponse =
	| { jobId: string; status: ExtractionStatus }
	| { status: "queued"; count: number };
