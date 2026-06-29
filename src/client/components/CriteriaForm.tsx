import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	KEYS_BY_CATEGORY,
} from "../../shared/categories";
import type { NormalizedKey } from "../../shared/job-schema";
import { type ApiClient, createApiClient } from "../lib/api";
import {
	CRITERION_META,
	type CriteriaConfigItem,
	type CriteriaFormRow,
	formRowToInput,
	type HardFilter,
	itemToFormRow,
	saveConfig,
} from "../lib/criteria";

// 設定フォーム（設計書 §4.5）。重み・希望値・ハードフィルタ ＋ benefitsCoverage 重視 signal を
// 1 画面で編集し、保存で PUT /api/config（＝決定的再スコア・AI 非再実行）を呼ぶ。
// 企業評判 取得元の設定は別コンポーネント（ReputationSourcesForm・#34）が D1 永続化で担う。
//
// なぜ api を注入するか:
// - 保存経路が「/config への PUT のみ」であることをテストで固定し、抽出（AI）を叩かないことを担保する
//   （抽出↔スコア分離 §5.3）。再ランキング反映は Dashboard 再マウント時の useRanking 再取得で行う。

export interface CriteriaFormProps {
	// GET /api/config の全正規キー項目（初期値）。
	readonly items: readonly CriteriaConfigItem[];
	// 保存に使う API クライアント（既定は global fetch）。テストはフェイクを注入する。
	readonly api?: ApiClient;
	// 保存成功（再スコア完了）時に件数を親へ通知する。
	readonly onRescored?: (count: number) => void;
}

type SaveState =
	| { readonly kind: "idle" }
	| { readonly kind: "saving" }
	| { readonly kind: "saved"; readonly count: number }
	| { readonly kind: "error"; readonly message: string };

const HARD_FILTER_LABELS: Record<HardFilter, string> = {
	none: "なし",
	required: "必須",
	exclude: "除外",
};

// 既定クライアントは安定参照（module スコープ）。レンダごとの再生成を避ける。
const defaultApi = createApiClient();

export function CriteriaForm({
	items,
	api = defaultApi,
	onRescored,
}: CriteriaFormProps): JSX.Element {
	const [rows, setRows] = useState<CriteriaFormRow[]>(() =>
		items.map(itemToFormRow),
	);
	const [save, setSave] = useState<SaveState>({ kind: "idle" });

	const rowByKey = new Map(rows.map((r) => [r.criterion, r]));

	function patchRow(criterion: NormalizedKey, next: CriteriaFormRow): void {
		setRows((prev) => prev.map((r) => (r.criterion === criterion ? next : r)));
	}

	async function handleSubmit(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setSave({ kind: "saving" });
		try {
			const inputs = rows.map(formRowToInput);
			const result = await saveConfig(inputs, api.put);
			setSave({ kind: "saved", count: result.count });
			onRescored?.(result.count);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setSave({ kind: "error", message });
		}
	}

	return (
		<form className="flex flex-col gap-6" onSubmit={handleSubmit}>
			{CATEGORY_KEYS.map((category) => (
				<fieldset
					key={category}
					className="rounded-lg border p-4"
					data-testid={`criteria-group-${category}`}
				>
					<legend className="px-1 font-semibold">
						{CATEGORY_LABELS[category]}
					</legend>
					<div className="flex flex-col gap-4">
						{KEYS_BY_CATEGORY[category].map((key) => {
							const row = rowByKey.get(key);
							if (row === undefined) return null;
							return (
								<CriterionRow
									key={key}
									row={row}
									onChange={(next) => patchRow(key, next)}
								/>
							);
						})}
					</div>
				</fieldset>
			))}

			<div className="flex items-center gap-4">
				<Button type="submit" disabled={save.kind === "saving"}>
					保存
				</Button>
				{save.kind === "saved" && (
					<p role="status" className="text-sm text-accent">
						再スコアしました（{save.count} 件）
					</p>
				)}
				{save.kind === "error" && (
					<p role="alert" className="text-sm text-danger">
						保存に失敗しました: {save.message}
					</p>
				)}
			</div>
		</form>
	);
}

// 1 項目の編集行。kind ごとに希望値の入力 UI を出し分ける。
function CriterionRow({
	row,
	onChange,
}: {
	readonly row: CriteriaFormRow;
	readonly onChange: (next: CriteriaFormRow) => void;
}): JSX.Element {
	const meta = CRITERION_META[row.criterion];
	return (
		<div className="flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0">
			<div className="font-medium">{meta.label}</div>
			<div className="flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-1 text-sm">
					<span className="text-muted-foreground">重み</span>
					<input
						aria-label={`重み（${meta.label}）`}
						type="number"
						min={0}
						step={1}
						className="w-20 rounded-md border bg-background px-2 py-1"
						value={row.weight}
						onChange={(e) => onChange({ ...row, weight: e.target.value })}
					/>
				</label>
				<label className="flex items-center gap-1 text-sm">
					<span className="text-muted-foreground">フィルタ</span>
					<select
						aria-label={`ハードフィルタ（${meta.label}）`}
						className="rounded-md border bg-background px-2 py-1"
						value={row.hardFilter}
						onChange={(e) =>
							onChange({ ...row, hardFilter: e.target.value as HardFilter })
						}
					>
						{(["none", "required", "exclude"] as const).map((value) => (
							<option key={value} value={value}>
								{HARD_FILTER_LABELS[value]}
							</option>
						))}
					</select>
				</label>
				<DesiredFields row={row} onChange={onChange} />
			</div>
		</div>
	);
}

// 希望値の入力 UI（kind 別）。
function DesiredFields({
	row,
	onChange,
}: {
	readonly row: CriteriaFormRow;
	readonly onChange: (next: CriteriaFormRow) => void;
}): JSX.Element | null {
	const meta = CRITERION_META[row.criterion];

	if (row.kind === "numericRange" && meta.kind === "numericRange") {
		return (
			<>
				<label className="flex items-center gap-1 text-sm">
					<span className="text-muted-foreground">希望値</span>
					<input
						aria-label={`希望値（${meta.label}）`}
						type="number"
						className="w-24 rounded-md border bg-background px-2 py-1"
						value={row.desired}
						onChange={(e) => onChange({ ...row, desired: e.target.value })}
					/>
				</label>
				<label className="flex items-center gap-1 text-sm">
					<span className="text-muted-foreground">{meta.boundLabel}</span>
					<input
						aria-label={`${meta.boundLabel}（${meta.label}）`}
						type="number"
						className="w-24 rounded-md border bg-background px-2 py-1"
						value={row.bound}
						onChange={(e) => onChange({ ...row, bound: e.target.value })}
					/>
				</label>
				<span className="text-sm text-muted-foreground">{meta.unit}</span>
			</>
		);
	}

	if (row.kind === "categorical" && meta.kind === "categorical") {
		const preferred = row.preferred;
		return (
			<div className="flex flex-wrap items-center gap-3">
				{meta.options.map((option) => (
					<label key={option.value} className="flex items-center gap-1 text-sm">
						<input
							type="checkbox"
							checked={preferred.includes(option.value)}
							onChange={(e) => {
								const next = e.target.checked
									? [...preferred, option.value]
									: preferred.filter((v) => v !== option.value);
								onChange({ ...row, preferred: next });
							}}
						/>
						{option.label}
					</label>
				))}
			</div>
		);
	}

	if (row.kind === "keywordMatch" && meta.kind === "keywordMatch") {
		return (
			<label className="flex flex-1 items-center gap-1 text-sm">
				<span className="text-muted-foreground">希望値</span>
				<input
					aria-label={`希望値（${meta.label}）`}
					type="text"
					className="min-w-48 flex-1 rounded-md border bg-background px-2 py-1"
					placeholder={meta.placeholder}
					value={row.keywords}
					onChange={(e) => onChange({ ...row, keywords: e.target.value })}
				/>
			</label>
		);
	}

	if (row.kind === "coverage" && meta.kind === "coverage") {
		return (
			<label className="flex flex-1 items-center gap-1 text-sm">
				<span className="text-muted-foreground">重視</span>
				<input
					aria-label={`重視する制度（${meta.label}）`}
					type="text"
					className="min-w-48 flex-1 rounded-md border bg-background px-2 py-1"
					placeholder={meta.placeholder}
					value={row.emphasis}
					onChange={(e) => onChange({ ...row, emphasis: e.target.value })}
				/>
			</label>
		);
	}

	return null;
}
