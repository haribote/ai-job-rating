import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ApiClient, createApiClient } from "../lib/api";
import {
	deleteReputationSource as apiDeleteSource,
	saveReputationSource as apiSaveSource,
	FETCH_METHOD_OPTIONS,
	fetchReputationSources,
	type ReputationFetchMethod,
	type ReputationSource,
} from "../lib/reputation";

// 企業評判 取得元の設定フォーム（#34）。対象口コミサイトと優先順位を D1 へ永続化する（§7.2）。
//
// なぜ別コンポーネントか:
// - CriteriaForm（重み・希望値の PUT /api/config）とは保存経路・ライフサイクルが異なるため独立させ、
//   Settings.tsx へは 1 箇所差し込む局所結合に留める（責務分離 §9）。
// - 設定変更は決定的・AI 非再実行（抽出↔スコア分離 §5.3）。取得元は取得層（#30）が enabledOnly で参照する。
// - フォーク容易性（§8）: 既定の取得元はコードに直書きしない。空から運用者が追加する。

export interface ReputationSourcesFormProps {
	// 取得元一覧の取得関数（既定は GET /api/reputation/sources）。テストはフェイクを注入する。
	readonly sourcesFetcher?: () => Promise<ReputationSource[]>;
	// CRUD に使う API クライアント（既定は global fetch）。
	readonly api?: ApiClient;
}

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "success"; readonly sources: ReputationSource[] };

interface DraftSource {
	readonly name: string;
	readonly fetchMethod: ReputationFetchMethod;
	readonly identifier: string;
	readonly priority: string;
	readonly enabled: boolean;
}

const EMPTY_DRAFT: DraftSource = {
	name: "",
	fetchMethod: "web_search",
	identifier: "",
	priority: "0",
	enabled: true,
};

// 既定の取得関数・クライアントは安定参照（module スコープ）にする（Settings.tsx と同方針）。
const defaultFetcher: () => Promise<ReputationSource[]> = () =>
	fetchReputationSources();
const defaultApi = createApiClient();

export function ReputationSourcesForm({
	sourcesFetcher = defaultFetcher,
	api = defaultApi,
}: ReputationSourcesFormProps): JSX.Element {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = useState<DraftSource>(EMPTY_DRAFT);
	const [error, setError] = useState<string | null>(null);
	// 操作中フラグ。再入を防ぎ二重 PUT/DELETE（連打や reload 待ちの間の再操作）による競合を避ける。
	// load の loading とは別軸（一覧は表示したまま操作だけ抑止する）ため LoadState に畳まない。
	const [busy, setBusy] = useState(false);

	// 取得元一覧を読み直す。各 mutation 後に呼び、サーバの priority 昇順並びへ揃える。
	async function reload(): Promise<void> {
		const sources = await sourcesFetcher();
		setState({ status: "success", sources });
	}

	useEffect(() => {
		let active = true;
		setState({ status: "loading" });
		sourcesFetcher()
			.then((sources) => {
				if (active) setState({ status: "success", sources });
			})
			.catch(() => {
				if (active) setState({ status: "error" });
			});
		return () => {
			active = false;
		};
	}, [sourcesFetcher]);

	// priority の文字列入力を非負整数へ確定する。空・非整数は 0（既定）。
	function parsePriority(raw: string): number {
		const n = Number(raw);
		return Number.isInteger(n) && n >= 0 ? n : 0;
	}

	async function runMutation(op: () => Promise<void>): Promise<void> {
		// 進行中の操作があれば無視して二重実行を防ぐ（連打・in-flight 中の再操作対策）。
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await op();
			await reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function handleAdd(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		if (draft.name.trim() === "") {
			setError("取得元名を入力してください。");
			return;
		}
		await runMutation(async () => {
			await apiSaveSource(
				{
					name: draft.name.trim(),
					identifier: draft.identifier.trim() || null,
					fetchMethod: draft.fetchMethod,
					priority: parsePriority(draft.priority),
					enabled: draft.enabled,
				},
				api.put,
			);
			setDraft(EMPTY_DRAFT);
		});
	}

	// 既存行のフィールド更新（name は一意キーのため固定。method/identifier/priority/enabled を upsert）。
	async function handleUpdate(
		source: ReputationSource,
		patch: Partial<{
			fetchMethod: ReputationFetchMethod;
			identifier: string | null;
			priority: number;
			enabled: boolean;
		}>,
	): Promise<void> {
		await runMutation(async () => {
			await apiSaveSource(
				{
					name: source.name,
					identifier:
						patch.identifier !== undefined
							? patch.identifier
							: source.identifier,
					fetchMethod: patch.fetchMethod ?? source.fetch_method,
					priority: patch.priority ?? source.priority,
					enabled: patch.enabled ?? source.enabled === 1,
				},
				api.put,
			);
		});
	}

	async function handleDelete(source: ReputationSource): Promise<void> {
		await runMutation(() => apiDeleteSource(source.id, api.delete));
	}

	// 優先順位の入れ替え。隣接要素と位置を交換し、新しい並び順で priority を連番へ振り直して
	// 変化した行のみ upsert する（priority 小さいほど優先・§7.2）。連番化により equal priority でも
	// 入れ替えが必ず反映される。各 upsert は name 一意で互いに独立なので Promise.all で並行投入する。
	async function handleMove(index: number, dir: "up" | "down"): Promise<void> {
		if (state.status !== "success") return;
		const list = [...state.sources];
		const j = dir === "up" ? index - 1 : index + 1;
		if (j < 0 || j >= list.length) return;
		[list[index], list[j]] = [list[j], list[index]];
		const changed = list
			.map((s, i) => ({ s, priority: i }))
			.filter(({ s, priority }) => s.priority !== priority);
		await runMutation(async () => {
			await Promise.all(
				changed.map(({ s, priority }) =>
					apiSaveSource(
						{
							name: s.name,
							identifier: s.identifier,
							fetchMethod: s.fetch_method,
							priority,
							enabled: s.enabled === 1,
						},
						api.put,
					),
				),
			);
		});
	}

	return (
		<fieldset
			className="rounded-lg border p-4"
			data-testid="reputation-sources-form"
		>
			<legend className="px-1 font-semibold">企業評判 取得元</legend>
			<p className="mb-3 text-sm text-muted-foreground">
				企業評判の収集対象サイトと優先順位（小さいほど優先）。取得層が有効な取得元のみ参照します。
			</p>

			{state.status === "loading" && (
				<p data-testid="reputation-loading">読み込み中...</p>
			)}
			{state.status === "error" && (
				<p role="alert">取得元の読み込みに失敗しました。</p>
			)}

			{state.status === "success" && (
				<ul className="mb-4 flex flex-col gap-3">
					{state.sources.length === 0 && (
						<li className="text-sm text-muted-foreground">
							取得元は未登録です。
						</li>
					)}
					{state.sources.map((source, index) => (
						<li
							key={source.id}
							className="flex flex-wrap items-center gap-3 border-t pt-3 first:border-t-0 first:pt-0"
							data-testid={`reputation-source-${source.name}`}
						>
							<span className="font-medium">{source.name}</span>
							<label className="flex items-center gap-1 text-sm">
								<span className="text-muted-foreground">方式</span>
								<select
									aria-label={`取得方式（${source.name}）`}
									className="rounded-md border bg-background px-2 py-1"
									value={source.fetch_method}
									onChange={(e) =>
										handleUpdate(source, {
											fetchMethod: e.target.value as ReputationFetchMethod,
										})
									}
								>
									{FETCH_METHOD_OPTIONS.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							</label>
							<label className="flex items-center gap-1 text-sm">
								<span className="text-muted-foreground">識別子</span>
								{/* 非制御 input。onBlur で trim 保存し、key に updated_at を含めて保存後に
								    remount させ、サーバ正規化後の値（trim 済み）を表示へ反映する。 */}
								<input
									key={`${source.id}-${source.updated_at}`}
									aria-label={`識別子（${source.name}）`}
									type="text"
									className="w-48 rounded-md border bg-background px-2 py-1"
									defaultValue={source.identifier ?? ""}
									onBlur={(e) =>
										handleUpdate(source, {
											identifier: e.target.value.trim() || null,
										})
									}
								/>
							</label>
							<label className="flex items-center gap-1 text-sm">
								<input
									type="checkbox"
									aria-label={`有効（${source.name}）`}
									checked={source.enabled === 1}
									onChange={(e) =>
										handleUpdate(source, { enabled: e.target.checked })
									}
								/>
								<span className="text-muted-foreground">有効</span>
							</label>
							<span className="text-sm text-muted-foreground">
								優先 {source.priority}
							</span>
							<Button
								type="button"
								variant="outline"
								aria-label={`上へ（${source.name}）`}
								disabled={index === 0}
								onClick={() => handleMove(index, "up")}
							>
								上へ
							</Button>
							<Button
								type="button"
								variant="outline"
								aria-label={`下へ（${source.name}）`}
								disabled={index === state.sources.length - 1}
								onClick={() => handleMove(index, "down")}
							>
								下へ
							</Button>
							<Button
								type="button"
								variant="outline"
								aria-label={`削除（${source.name}）`}
								onClick={() => handleDelete(source)}
							>
								削除
							</Button>
						</li>
					))}
				</ul>
			)}

			<form
				className="flex flex-wrap items-end gap-3 border-t pt-3"
				onSubmit={handleAdd}
			>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">取得元名</span>
					<input
						aria-label="取得元名"
						type="text"
						className="w-40 rounded-md border bg-background px-2 py-1"
						placeholder="例: openwork"
						value={draft.name}
						onChange={(e) => setDraft({ ...draft, name: e.target.value })}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">取得方式</span>
					<select
						aria-label="取得方式"
						className="rounded-md border bg-background px-2 py-1"
						value={draft.fetchMethod}
						onChange={(e) =>
							setDraft({
								...draft,
								fetchMethod: e.target.value as ReputationFetchMethod,
							})
						}
					>
						{FETCH_METHOD_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">識別子（任意）</span>
					<input
						aria-label="識別子（base URL 等）"
						type="text"
						className="w-48 rounded-md border bg-background px-2 py-1"
						placeholder="例: openwork.jp"
						value={draft.identifier}
						onChange={(e) => setDraft({ ...draft, identifier: e.target.value })}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">優先順位</span>
					<input
						aria-label="優先順位"
						type="number"
						min={0}
						step={1}
						className="w-20 rounded-md border bg-background px-2 py-1"
						value={draft.priority}
						onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
					/>
				</label>
				<label className="flex items-center gap-1 text-sm">
					<input
						type="checkbox"
						aria-label="有効"
						checked={draft.enabled}
						onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
					/>
					<span className="text-muted-foreground">有効</span>
				</label>
				<Button type="submit" disabled={busy}>
					追加
				</Button>
			</form>

			{error !== null && (
				<p role="alert" className="mt-2 text-sm text-danger">
					{error}
				</p>
			)}
		</fieldset>
	);
}
