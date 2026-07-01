import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	JobSubmissionBody,
	SubmitJobResponse,
} from "../../shared/submit-job";
import { ApiRequestError, apiPost } from "../lib/api";

// 求人投入モーダル（設計書 §4.2 / 実装計画 Task 20 / #113）。
//
// 構成:
// - URL タブ / HTML 貼り付けタブの 2 タブ（送信ボディは {url} か {html} の排他・#95 契約）。
// - 送信は POST /api/jobs。成功（201/202）で onSubmitted を通知し、親が再ランキングを促す。
//
// なぜ検証をクライアントにも持つか:
// - 決定的な前検証（空・不正 URL・サイズ超過）で無駄な API/AI 呼び出しを抑える（コスト保護）。
// - 最終的な真偽はサーバ責務（validateJobUrl / validatePastedHtml）。ここはその写像で、
//   サーバモジュールは D1/fetch 依存を引くため client からは import せず、契約のみを複製する。
// - submit 関数を注入可能にし、jsdom テストをネットワーク非依存・決定的に保つ。

// 貼り付け HTML の上限（バイト）。サーバ MAX_HTML_BYTES（jobs.ts）と同値。
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export type SubmitTab = "url" | "html";

export type SubmissionValidation =
	| { ok: true; body: JobSubmissionBody }
	| { ok: false; reason: "empty" | "invalid" | "too-large" };

// active タブと入力から送信ボディを決定する純関数。url/html の排他はここで閉じる。
// cookie は URL タブでのみ有効な任意フィールド（認証下ページ取得用・#187）。非空のときだけ載せる
// （空文字は送らず、Cookie 無しの後方互換を保つ）。
export function validateSubmission(
	tab: SubmitTab,
	url: string,
	html: string,
	cookie = "",
): SubmissionValidation {
	if (tab === "url") {
		const trimmed = url.trim();
		if (trimmed === "") return { ok: false, reason: "empty" };
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return { ok: false, reason: "invalid" };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { ok: false, reason: "invalid" };
		}
		const trimmedCookie = cookie.trim();
		return {
			ok: true,
			body:
				trimmedCookie === ""
					? { url: trimmed }
					: { url: trimmed, cookie: trimmedCookie },
		};
	}
	if (html.trim() === "") return { ok: false, reason: "empty" };
	// 文字数ではなく UTF-8 バイト長で上限判定する（サーバと同じ基準）。
	const bytes = new TextEncoder().encode(html).length;
	if (bytes > MAX_HTML_BYTES) return { ok: false, reason: "too-large" };
	return { ok: true, body: { html } };
}

// 投入関数。既定は POST /api/jobs。テストはフェイクを注入する。
export type SubmitJob = (body: JobSubmissionBody) => Promise<SubmitJobResponse>;

const defaultSubmit: SubmitJob = (body) =>
	apiPost<SubmitJobResponse>("/jobs", body);

// 検証/取得失敗の理由コードを利用者向けメッセージへ写す。未知理由は汎用文へ畳む。
function messageForReason(reason: string | undefined): string {
	switch (reason) {
		case "empty":
			return "入力が空です。";
		case "invalid":
			return "URL の形式が正しくありません（http(s) のみ）。";
		case "too-large":
			return "HTML が大きすぎます（2MB まで）。";
		case "body":
			return "入力が不正です。";
		case "http":
		case "timeout":
		case "network":
			return "ページの取得に失敗しました。URL を確認してください。";
		// 認証下ページ取得（Cookie 投入）の失敗分類（#187）。
		case "invalid-credential":
			return "Cookie の形式が正しくありません。";
		case "auth":
			return "認証に失敗しました。Cookie を確認してください。";
		case "redirect":
			return "別サイトへのリダイレクトを検出したため中断しました。";
		default:
			return "投入に失敗しました。時間をおいて再試行してください。";
	}
}

export interface AddJobModalProps {
	// モーダルの開閉。親（App）が状態を持つ。
	open: boolean;
	// 開閉変更（オーバーレイ／Esc／閉じるボタン／送信成功を含む）。
	onOpenChange: (open: boolean) => void;
	// 投入関数（既定は POST /api/jobs）。テストはフェイクを注入する。
	submit?: SubmitJob;
	// 投入成功時の通知。親が再ランキング（一覧再取得）を促すために使う。
	onSubmitted?: (response: SubmitJobResponse) => void;
}

export function AddJobModal({
	open,
	onOpenChange,
	submit = defaultSubmit,
	onSubmitted,
}: AddJobModalProps): JSX.Element {
	const [tab, setTab] = useState<SubmitTab>("url");
	const [url, setUrl] = useState("");
	const [html, setHtml] = useState("");
	// 認証下ページ取得用の Cookie（任意・URL タブのみ・#187）。秘匿値のため送信ヘッダにのみ使う。
	const [cookie, setCookie] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	// 開くたびにエラー表示をリセットし、前回の失敗文言を持ち越さない。
	useEffect(() => {
		if (open) setError(null);
	}, [open]);

	function selectTab(next: SubmitTab): void {
		setTab(next);
		// タブ切替で他タブ由来の検証エラーをクリアする。
		setError(null);
	}

	async function handleSubmit(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		// 送信中の二重投入を防ぐ（ボタン無効化だけでは Enter 連打を弾けない）。
		if (submitting) return;
		const validated = validateSubmission(tab, url, html, cookie);
		if (!validated.ok) {
			setError(messageForReason(validated.reason));
			return;
		}
		setError(null);
		setSubmitting(true);
		try {
			const response = await submit(validated.body);
			onSubmitted?.(response);
			// 成功時のみ入力を破棄してモーダルを閉じる。
			setUrl("");
			setHtml("");
			setCookie("");
			setSubmitting(false);
			onOpenChange(false);
		} catch (cause) {
			setSubmitting(false);
			const reason =
				cause instanceof ApiRequestError ? cause.reason : undefined;
			setError(messageForReason(reason));
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>求人を投入</DialogTitle>
					<DialogDescription>
						求人ページの URL、または貼り付けた HTML から投入します。
					</DialogDescription>
				</DialogHeader>

				<div
					role="tablist"
					aria-label="投入方法"
					className="flex gap-2 border-b"
				>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "url"}
						data-testid="add-job-tab-url"
						onClick={() => selectTab("url")}
						className={
							tab === "url"
								? "border-b-2 border-primary px-3 py-2"
								: "px-3 py-2 text-muted-foreground"
						}
					>
						URL
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "html"}
						data-testid="add-job-tab-html"
						onClick={() => selectTab("html")}
						className={
							tab === "html"
								? "border-b-2 border-primary px-3 py-2"
								: "px-3 py-2 text-muted-foreground"
						}
					>
						HTML を貼り付け
					</button>
				</div>

				{/* 検証は validateSubmission に一本化する。ブラウザのネイティブ検証が
				    送信を遮ると独自エラー UX が出せないため noValidate で無効化する。 */}
				<form
					onSubmit={handleSubmit}
					noValidate
					className="flex flex-col gap-3"
				>
					{tab === "url" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<label htmlFor="add-job-url" className="text-sm font-medium">
									求人ページの URL
								</label>
								<input
									id="add-job-url"
									data-testid="add-job-url-input"
									type="url"
									value={url}
									onChange={(event) => setUrl(event.target.value)}
									placeholder="https://example.com/jobs/123"
									className="h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								/>
							</div>
							{/* 認証下（ログイン後）の求人ページ用。任意。秘匿値のため type=password で伏せ、
							    送信時のリクエストヘッダにのみ使う（永続化・ログ出力しない・#187）。 */}
							<div className="flex flex-col gap-1.5">
								<label htmlFor="add-job-cookie" className="text-sm font-medium">
									Cookie（任意・認証下ページ用）
								</label>
								<input
									id="add-job-cookie"
									data-testid="add-job-cookie-input"
									type="password"
									value={cookie}
									onChange={(event) => setCookie(event.target.value)}
									placeholder="Cookie（任意・認証下ページ用）"
									className="h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								/>
							</div>
						</>
					) : (
						<div className="flex flex-col gap-1.5">
							<label htmlFor="add-job-html" className="text-sm font-medium">
								求人ページの HTML
							</label>
							<textarea
								id="add-job-html"
								data-testid="add-job-html-input"
								value={html}
								onChange={(event) => setHtml(event.target.value)}
								placeholder="<html>...</html>"
								rows={8}
								className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							/>
						</div>
					)}

					{error !== null && (
						<p
							role="alert"
							data-testid="add-job-error"
							className="text-sm text-destructive"
						>
							{error}
						</p>
					)}

					<DialogFooter>
						<Button
							type="submit"
							data-testid="add-job-submit"
							disabled={submitting}
						>
							{submitting ? "投入中..." : "投入"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
