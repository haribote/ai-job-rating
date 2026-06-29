import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../lib/api";
import { AddJobModal, MAX_HTML_BYTES, validateSubmission } from "./AddJobModal";

// 投入入力のバリデーション（決定的・純関数）。サーバ契約（#95）と同義の判定を
// クライアント前検証として持ち、url/html の排他（送信ボディ形）を担保する。
describe("validateSubmission（投入入力の検証）", () => {
	it("URL タブ: 空入力は empty", () => {
		expect(validateSubmission("url", "  ", "")).toEqual({
			ok: false,
			reason: "empty",
		});
	});

	it("URL タブ: 解釈できない文字列は invalid", () => {
		expect(validateSubmission("url", "not a url", "")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("URL タブ: http(s) 以外のスキームは invalid", () => {
		expect(validateSubmission("url", "ftp://example.com/job", "")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("URL タブ: 正常 URL は前後空白を除いた url ボディ", () => {
		expect(
			validateSubmission("url", "  https://example.com/job-1  ", ""),
		).toEqual({ ok: true, body: { url: "https://example.com/job-1" } });
	});

	it("HTML タブ: 空入力は empty", () => {
		expect(validateSubmission("html", "", "   ")).toEqual({
			ok: false,
			reason: "empty",
		});
	});

	it("HTML タブ: 正常は html ボディ（原文を保持）", () => {
		expect(validateSubmission("html", "", "  <html>x</html>  ")).toEqual({
			ok: true,
			body: { html: "  <html>x</html>  " },
		});
	});

	it("HTML タブ: 2MB 超は too-large", () => {
		const tooLarge = "a".repeat(MAX_HTML_BYTES + 1);
		expect(validateSubmission("html", "", tooLarge)).toEqual({
			ok: false,
			reason: "too-large",
		});
	});
});

describe("AddJobModal（求人投入モーダル）", () => {
	it("既定は URL タブで URL 入力を表示する", () => {
		render(<AddJobModal open={true} onOpenChange={() => {}} />);

		expect(screen.getByTestId("add-job-url-input")).toBeInTheDocument();
		expect(screen.queryByTestId("add-job-html-input")).not.toBeInTheDocument();
	});

	it("HTML タブへ切替で textarea を表示し URL 入力は隠す（排他）", () => {
		render(<AddJobModal open={true} onOpenChange={() => {}} />);

		fireEvent.click(screen.getByTestId("add-job-tab-html"));

		expect(screen.getByTestId("add-job-html-input")).toBeInTheDocument();
		expect(screen.queryByTestId("add-job-url-input")).not.toBeInTheDocument();
	});

	it("空のまま送信するとエラーを出し submit を呼ばない", () => {
		const submit = vi.fn();
		render(<AddJobModal open={true} onOpenChange={() => {}} submit={submit} />);

		fireEvent.click(screen.getByTestId("add-job-submit"));

		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(submit).not.toHaveBeenCalled();
	});

	it("URL を入力して送信すると {url} で submit し、成功で onSubmitted＋クローズ", async () => {
		const submit = vi.fn(async () => ({
			jobId: "job-1",
			status: "ok" as const,
		}));
		const onSubmitted = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<AddJobModal
				open={true}
				onOpenChange={onOpenChange}
				submit={submit}
				onSubmitted={onSubmitted}
			/>,
		);

		fireEvent.change(screen.getByTestId("add-job-url-input"), {
			target: { value: "https://example.com/job-1" },
		});
		fireEvent.click(screen.getByTestId("add-job-submit"));

		expect(submit).toHaveBeenCalledWith({ url: "https://example.com/job-1" });
		// 送信の解決（マイクロタスク）を待ってからコールバックを確認する。
		await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
		expect(onSubmitted).toHaveBeenCalledWith({ jobId: "job-1", status: "ok" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("HTML を入力して送信すると {html} で submit する", async () => {
		const submit = vi.fn(async () => ({
			jobId: "job-2",
			status: "partial" as const,
		}));
		render(<AddJobModal open={true} onOpenChange={() => {}} submit={submit} />);

		fireEvent.click(screen.getByTestId("add-job-tab-html"));
		fireEvent.change(screen.getByTestId("add-job-html-input"), {
			target: { value: "<html>job</html>" },
		});
		fireEvent.click(screen.getByTestId("add-job-submit"));

		await vi.waitFor(() =>
			expect(submit).toHaveBeenCalledWith({ html: "<html>job</html>" }),
		);
	});

	it("不正 URL は送信前に弾き submit を呼ばない", () => {
		const submit = vi.fn();
		render(<AddJobModal open={true} onOpenChange={() => {}} submit={submit} />);

		fireEvent.change(screen.getByTestId("add-job-url-input"), {
			target: { value: "not-a-url" },
		});
		fireEvent.click(screen.getByTestId("add-job-submit"));

		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(submit).not.toHaveBeenCalled();
	});

	it("API エラー時はメッセージを出しモーダルを閉じない", async () => {
		const submit = vi.fn(async () => {
			throw new ApiRequestError(502, "failed to fetch url", "http");
		});
		const onOpenChange = vi.fn();
		render(
			<AddJobModal open={true} onOpenChange={onOpenChange} submit={submit} />,
		);

		fireEvent.change(screen.getByTestId("add-job-url-input"), {
			target: { value: "https://example.com/job-1" },
		});
		fireEvent.click(screen.getByTestId("add-job-submit"));

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});
});
