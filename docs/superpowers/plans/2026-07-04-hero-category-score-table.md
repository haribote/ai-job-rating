# Hero Category Score Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard-wide `RadarAxisLegend` with a minimal per-category score table shown only on the rank-1 (`hero`) `RankingCard`, per `docs/superpowers/specs/2026-07-04-hero-category-score-table-design.md`.

**Architecture:** A new presentation component `CategoryScoreTable` renders a 3-column (number / category name / score) table from `categoryScores`. `RankingCard` renders it conditionally when `size === "hero"`. `Dashboard.tsx` drops its standalone `RadarAxisLegend` render. `JobDetailSheet.tsx` is untouched — it keeps its own `RadarAxisLegend`. To avoid a circular import between `RankingCard.tsx` (which will import `CategoryScoreTable`) and `CategoryScoreTable.tsx` (which needs the existing `formatScore` helper), `formatScore` moves to a new small shared file and `RankingCard.tsx` re-exports it so `JobDetailSheet.tsx`'s existing import keeps working unchanged.

**Tech Stack:** React, TypeScript, Tailwind CSS v4, shadcn `Table` primitives (`@/components/ui/table`, already used by `BreakdownTable.tsx`), Vitest + Testing Library, Playwright (`@screenshot`).

## Global Constraints

- No independent/standalone legend area anywhere in `Dashboard.tsx` — only the hero card's table.
- `src/client/components/JobDetailSheet.tsx` must not change — it keeps using `RadarAxisLegend`.
- `src/client/components/RadarAxisLegend.tsx` itself is not deleted or modified.
- Category scores in the new table use the same scale and precision as the total score: `categoryScores` (0..1) × 100, formatted with the existing `formatScore` (null → "—", else `toFixed(2)`).
- Unknown (null) categories keep their row — never omit a row — displaying "—" (project-wide unknown-is-neutral rule, §5.2).
- `e2e/fixtures/mockRanking.ts` needs no changes — hero/podium/default mock jobs already carry mixed known/unknown `categoryScores` from PR #214.

---

### Task 1: Extract `formatScore` and create `CategoryScoreTable`

**Files:**
- Create: `src/client/lib/formatScore.ts`
- Modify: `src/client/components/RankingCard.tsx:1-4` (imports), `src/client/components/RankingCard.tsx:88-91` (remove local definition, re-export instead)
- Create: `src/client/components/CategoryScoreTable.tsx`
- Test: `src/client/components/CategoryScoreTable.test.tsx` (new)

**Interfaces:**
- Consumes: `CATEGORY_KEYS`, `CATEGORY_AXIS_NUMBERS`, `CATEGORY_LABELS`, `type CategoryKey` from `../../shared/categories` (all already exist, unchanged).
- Produces: `formatScore(score: number | null): string` now lives in `src/client/lib/formatScore.ts`, re-exported from `./RankingCard` so `JobDetailSheet.tsx`'s existing `import { formatScore, SCORE_UNAVAILABLE_NOTE } from "./RankingCard";` keeps working unchanged. `CategoryScoreTable({ scores: Record<CategoryKey, number | null>; className?: string }): JSX.Element`, rendered with `data-testid="category-score-table"` — Task 2 consumes this.

- [ ] **Step 1: Write the failing test**

Create `src/client/components/CategoryScoreTable.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { CategoryScoreTable } from "./CategoryScoreTable";

// 全軸 unknown（null）の既定値。
const NEUTRAL_SCORES = Object.fromEntries(
	CATEGORY_KEYS.map((key) => [key, null]),
) as Record<CategoryKey, number | null>;

describe("CategoryScoreTable", () => {
	it("data-testid=category-score-table で描画する", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		expect(screen.getByTestId("category-score-table")).toBeInTheDocument();
	});

	it("CATEGORY_KEYS 順で番号・カテゴリ名を過不足なく対応させる（ハードコードしない）", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		const table = screen.getByTestId("category-score-table");
		const rows = within(table).getAllByRole("row");
		expect(rows).toHaveLength(CATEGORY_KEYS.length);

		CATEGORY_KEYS.forEach((key, index) => {
			const row = rows[index];
			expect(row).toHaveTextContent(String(CATEGORY_AXIS_NUMBERS[key]));
			expect(row).toHaveTextContent(CATEGORY_LABELS[key]);
		});
	});

	it("既知の軸は categoryScores（0..1）を ×100・小数2桁で表示する（総合スコアと同じスケール・精度）", () => {
		render(
			<CategoryScoreTable scores={{ ...NEUTRAL_SCORES, compensation: 0.9 }} />,
		);
		const table = screen.getByTestId("category-score-table");
		expect(within(table).getByText("90.00")).toBeInTheDocument();
	});

	it("unknown（null）軸は行を消さず「—」で表示する（中立表示・§5.2）", () => {
		render(<CategoryScoreTable scores={NEUTRAL_SCORES} />);
		const table = screen.getByTestId("category-score-table");
		const rows = within(table).getAllByRole("row");
		expect(rows).toHaveLength(CATEGORY_KEYS.length);
		for (const row of rows) {
			expect(row).toHaveTextContent("—");
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- CategoryScoreTable`
Expected: FAIL — `CategoryScoreTable.tsx` does not exist yet (module not found).

- [ ] **Step 3: Extract `formatScore` into a shared lib file**

Create `src/client/lib/formatScore.ts`:

```ts
// スコアの表示整形（決定的）。未スコア（null）は中立記号、それ以外は小数2桁。
export function formatScore(score: number | null): string {
	return score === null ? "—" : score.toFixed(2);
}
```

- [ ] **Step 4: Point `RankingCard.tsx` at the shared `formatScore` and re-export it**

In `src/client/components/RankingCard.tsx`, change the import block at the top (currently lines 1-5):

```tsx
import type { JSX, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RankingItem } from "../lib/useRanking";
import { ScoreRadar } from "./ScoreRadar";
```

to:

```tsx
import type { JSX, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatScore } from "../lib/formatScore";
import type { RankingItem } from "../lib/useRanking";
import { CategoryScoreTable } from "./CategoryScoreTable";
import { ScoreRadar } from "./ScoreRadar";
```

Then remove the local definition (currently lines 88-91):

```tsx
// スコアの表示整形（決定的）。未スコア（null）は中立記号、それ以外は小数2桁。
export function formatScore(total: number | null): string {
	return total === null ? "—" : total.toFixed(2);
}
```

and replace it with a re-export so `JobDetailSheet.tsx`'s existing import keeps working:

```tsx
export { formatScore };
```

(The `CategoryScoreTable` import is added now so Step 6 below only needs to add JSX, not another import edit — the component itself is created in Step 6.)

- [ ] **Step 5: Run the existing RankingCard tests to confirm the re-export works (regression)**

Run: `npm test -- RankingCard`
Expected: PASS (existing `formatScore` describe block in `RankingCard.test.tsx` still imports `formatScore` from `./RankingCard`, which now re-exports the moved function — same behavior, same 2 tests pass). `CategoryScoreTable.test.tsx` will still fail at this point since the component doesn't exist yet — that's expected.

- [ ] **Step 6: Implement `CategoryScoreTable`**

Create `src/client/components/CategoryScoreTable.tsx`:

```tsx
import type { JSX } from "react";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
	CATEGORY_AXIS_NUMBERS,
	CATEGORY_KEYS,
	CATEGORY_LABELS,
	type CategoryKey,
} from "../../shared/categories";
import { formatScore } from "../lib/formatScore";

// 1位カードのカテゴリ別スコアテーブル（#203 方針転換）。
//
// なぜこのコンポーネントか:
// - 独立した凡例欄（ダッシュボード単位の RadarAxisLegend）を廃止した代わりに、1位カードの
//   テーブルへ番号列を残すことで番号→カテゴリ名の対応表を兼ねる（2位以下は引き続き番号のみの軸ラベル）。
// - スコアは categoryScores（0..1）を ×100 し、総合スコアと同じ formatScore を再利用して
//   スケール・精度（toFixed(2)・null→「—」）を統一する。

export interface CategoryScoreTableProps {
	readonly scores: Record<CategoryKey, number | null>;
	readonly className?: string;
}

export function CategoryScoreTable({
	scores,
	className,
}: CategoryScoreTableProps): JSX.Element {
	return (
		<Table data-testid="category-score-table" className={className}>
			<TableBody>
				{CATEGORY_KEYS.map((key) => {
					const score = scores[key];
					return (
						<TableRow key={key}>
							<TableCell className="p-1 text-xs tabular-nums text-muted-foreground">
								{CATEGORY_AXIS_NUMBERS[key]}
							</TableCell>
							<TableCell className="p-1 text-xs">
								{CATEGORY_LABELS[key]}
							</TableCell>
							<TableCell className="p-1 text-right text-xs tabular-nums">
								{formatScore(score === null ? null : score * 100)}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
```

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npm test -- CategoryScoreTable`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add src/client/lib/formatScore.ts src/client/components/RankingCard.tsx src/client/components/CategoryScoreTable.tsx src/client/components/CategoryScoreTable.test.tsx docs/superpowers/plans/2026-07-04-hero-category-score-table.md
git commit -m "feat: add CategoryScoreTable component"
```

---

### Task 2: Show `CategoryScoreTable` only on hero-sized `RankingCard`

**Files:**
- Modify: `src/client/components/RankingCard.tsx:141-164` (`CardContent` block)
- Test: `src/client/components/RankingCard.test.tsx`

**Interfaces:**
- Consumes: `CategoryScoreTable({ scores, className }): JSX.Element` from Task 1 (already imported into `RankingCard.tsx` in Task 1 Step 4).
- Produces: no new exports — `RankingCard`'s own props/signature are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/client/components/RankingCard.test.tsx`, inside the existing `describe("RankingCard", ...)` block (after the last `it(...)`, i.e. after the `"size 指定でスコア・レーダーの表示サイズが変わる..."` test):

```tsx
	it("hero サイズのときだけカテゴリ別スコアテーブルを表示する（#203 方針転換）", () => {
		render(
			<RankingCard item={item()} rank={1} onSelect={vi.fn()} size="hero" />,
		);
		expect(screen.getByTestId("category-score-table")).toBeInTheDocument();
	});

	it("podium/default サイズではカテゴリ別スコアテーブルを表示しない", () => {
		const podium = render(
			<RankingCard item={item()} rank={2} onSelect={vi.fn()} size="podium" />,
		);
		expect(
			within(podium.container).queryByTestId("category-score-table"),
		).not.toBeInTheDocument();

		const defaultSize = render(
			<RankingCard item={item()} rank={5} onSelect={vi.fn()} />,
		);
		expect(
			within(defaultSize.container).queryByTestId("category-score-table"),
		).not.toBeInTheDocument();
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- RankingCard`
Expected: FAIL — the two new tests fail because `category-score-table` is never rendered yet (first test fails on `getByTestId` not found; second test's assertions trivially pass since nothing is rendered yet, so only the first new test actually fails — that's fine, it confirms the missing behavior).

- [ ] **Step 3: Render `CategoryScoreTable` conditionally on `size === "hero"`**

In `src/client/components/RankingCard.tsx`, change the score wrapper block (currently lines 147-163):

```tsx
					<div className={sizeStyle.scoreWrapperClassName}>
						<span className="text-xs text-muted-foreground">総合スコア</span>
						<span data-testid="card-score" className={sizeStyle.scoreClassName}>
							{formatScore(item.total)}
						</span>
						{item.total === null && (
							// unknown は中立（§5.2）: 0 点ではなく「未算出」と明示する。ready なのに
							// スコアが出ない＝設定不足（重み・希望値未設定等）のヒントを添える。
							<span
								role="status"
								data-testid="score-unavailable-note"
								className="text-xs text-muted-foreground"
							>
								{SCORE_UNAVAILABLE_NOTE}
							</span>
						)}
					</div>
```

to:

```tsx
					<div className={sizeStyle.scoreWrapperClassName}>
						<span className="text-xs text-muted-foreground">総合スコア</span>
						<span data-testid="card-score" className={sizeStyle.scoreClassName}>
							{formatScore(item.total)}
						</span>
						{item.total === null && (
							// unknown は中立（§5.2）: 0 点ではなく「未算出」と明示する。ready なのに
							// スコアが出ない＝設定不足（重み・希望値未設定等）のヒントを添える。
							<span
								role="status"
								data-testid="score-unavailable-note"
								className="text-xs text-muted-foreground"
							>
								{SCORE_UNAVAILABLE_NOTE}
							</span>
						)}
						{size === "hero" && (
							// 独立した凡例欄は設けず、1位カードのテーブルが番号→カテゴリ名の
							// 対応表を兼ねる（2位以下は引き続き番号のみの軸ラベル・#203 方針転換）。
							<CategoryScoreTable scores={item.categoryScores} className="mt-2" />
						)}
					</div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- RankingCard`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/client/components/RankingCard.tsx src/client/components/RankingCard.test.tsx
git commit -m "feat: show category score table on hero ranking card"
```

---

### Task 3: Remove the standalone dashboard legend

**Files:**
- Modify: `src/client/routes/Dashboard.tsx:5` (import), `src/client/routes/Dashboard.tsx:135-144`
- Modify: `src/shared/categories.ts:58-60` (stale comment update)
- Test: `src/client/routes/Dashboard.test.tsx:294-349` (replace)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task only removes rendering, it doesn't change any component's public interface.

- [ ] **Step 1: Write the failing test**

In `src/client/routes/Dashboard.test.tsx`, replace the entire block from the comment at line 294 through the closing `});` of the `describe` at line 349 (i.e. lines 294-349):

```tsx
	// #203: 軸番号↔カテゴリ名の凡例はダッシュボード単位で1箇所のみ。レーダーが1件以上表示される
	// 状態（確定ランキングに1件以上 or 投入中カードが1件以上）でのみ出す。
	describe("軸凡例（RadarAxisLegend）の表示条件（#203）", () => {
		it("取得中（ローディング）は凡例を表示しない", () => {
			render(
				<Dashboard
					rankingFetcher={() => new Promise<RankingResponse>(() => {})}
				/>,
			);
			expect(screen.queryByTestId("radar-axis-legend")).not.toBeInTheDocument();
		});

		it("取得失敗時は凡例を表示しない", async () => {
			render(
				<Dashboard
					rankingFetcher={async () => {
						throw new Error("boom");
					}}
				/>,
			);
			await screen.findByRole("alert");
			expect(screen.queryByTestId("radar-axis-legend")).not.toBeInTheDocument();
		});

		it("確定ランキングが0件・投入中も無いときは凡例を表示しない", async () => {
			render(
				<Dashboard rankingFetcher={async () => ({ jobs: [], excluded: [] })} />,
			);
			await screen.findByTestId("dashboard-view");
			expect(screen.queryByTestId("radar-axis-legend")).not.toBeInTheDocument();
		});

		it("確定ランキングが1件以上あるときは凡例を1回だけ表示する", async () => {
			const jobs = ["a", "b"].map((id) => item({ jobId: id }));
			render(
				<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />,
			);

			expect(await screen.findAllByTestId("radar-axis-legend")).toHaveLength(1);
		});

		it("確定ランキングは0件でも投入中カードが1件以上あれば凡例を表示する", async () => {
			const jobStatusFetcher = vi.fn().mockResolvedValue(detail("scored"));
			render(
				<Dashboard
					rankingFetcher={async () => ({ jobs: [], excluded: [] })}
					pendingJobIds={["job-x"]}
					jobStatusFetcher={jobStatusFetcher}
					jobStatusIntervalMs={5}
				/>,
			);

			await screen.findByTestId("pending-card");
			expect(screen.getAllByTestId("radar-axis-legend")).toHaveLength(1);
		});
	});
```

with:

```tsx
	// #203 方針転換: 独立した凡例欄は廃止し、1位カードのカテゴリ別スコアテーブル
	// （CategoryScoreTable）が番号→カテゴリ名の対応を兼ねる。Dashboard は
	// RadarAxisLegend を一切描画しない（JobDetailSheet は対象外・現状維持）。
	it("凡例（RadarAxisLegend）を描画しない", async () => {
		const jobs = ["a", "b"].map((id) => item({ jobId: id }));
		render(<Dashboard rankingFetcher={async () => ({ jobs, excluded: [] })} />);

		await screen.findByTestId("ranking-hero-region");
		expect(screen.queryByTestId("radar-axis-legend")).not.toBeInTheDocument();
	});
```

- [ ] **Step 2: Run test to verify it still passes (Dashboard still renders the legend at this point)**

Run: `npx vitest run src/client/routes/Dashboard.test.tsx -t "凡例（RadarAxisLegend）を描画しない"`
Expected: FAIL — `Dashboard.tsx` still renders `RadarAxisLegend` at this point (Step 3 hasn't run yet), so `queryByTestId("radar-axis-legend")` finds an element and `not.toBeInTheDocument()` fails.

- [ ] **Step 3: Remove the `RadarAxisLegend` render from `Dashboard.tsx`**

Remove the import (currently line 5):

```tsx
import { RadarAxisLegend } from "../components/RadarAxisLegend";
```

Change (currently lines 134-144):

```tsx
	// 投入中カードは確定ランキングの末尾へ続けて並べる（再ランキングまでの暫定位置）。
	const rankedCount = ranking.status === "success" ? ranking.jobs.length : 0;
	// 軸凡例（RadarAxisLegend）はダッシュボード単位で1箇所のみ。番号↔カテゴリ名の対応は
	// CATEGORY_KEYS 順で全カード共通・不変のため、レーダーが1件以上表示される状態でのみ出す
	// （確定ランキングに1件以上 or 投入中カードが1件以上・#203）。
	const hasAnyRadarCard = rankedCount > 0 || pendingJobIds.length > 0;

	return (
		<section data-testid="dashboard-view" className="p-4">
			<h2 className="sr-only">ランキング</h2>
			{hasAnyRadarCard && <RadarAxisLegend className="mb-3" />}

```

to:

```tsx
	// 投入中カードは確定ランキングの末尾へ続けて並べる（再ランキングまでの暫定位置）。
	const rankedCount = ranking.status === "success" ? ranking.jobs.length : 0;

	return (
		<section data-testid="dashboard-view" className="p-4">
			<h2 className="sr-only">ランキング</h2>

```

- [ ] **Step 4: Update the stale comment in `categories.ts`**

In `src/shared/categories.ts`, change (currently lines 58-60):

```ts
// 軸 → レーダー目盛り番号（1始まり・CATEGORY_KEYS 順で決定的に導出）。
// レーダーの軸ラベルは狭枠で重なるため番号に置換し、凡例（RadarAxisLegend）で
// 番号 → CATEGORY_LABELS の対応を示す（#203）。
```

to:

```ts
// 軸 → レーダー目盛り番号（1始まり・CATEGORY_KEYS 順で決定的に導出）。
// レーダーの軸ラベルは狭枠で重なるため番号に置換する。番号 → CATEGORY_LABELS の対応は、
// JobDetailSheet では凡例（RadarAxisLegend）、ダッシュボードでは1位カードの
// カテゴリ別スコアテーブル（CategoryScoreTable）で示す（#203 方針転換）。
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/client/routes/Dashboard.test.tsx -t "凡例（RadarAxisLegend）を描画しない"`
Expected: PASS

- [ ] **Step 6: Run the full Dashboard test file to confirm no regression**

Run: `npm test -- Dashboard`
Expected: PASS (all tests in `Dashboard.test.tsx`)

- [ ] **Step 7: Commit**

```bash
git add src/client/routes/Dashboard.tsx src/client/routes/Dashboard.test.tsx src/shared/categories.ts
git commit -m "refactor: drop standalone dashboard radar legend"
```

---

### Task 4: Full verification and visual check

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: PASS, all test files green (no regressions from Tasks 1-3).

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit && npx biome check .`
Expected: no errors.

- [ ] **Step 3: Regenerate and visually inspect the screenshot artifacts**

Run: `npx playwright test e2e/screenshots.spec.ts`
Expected: 6 passed.

Then view `screenshots/dashboard-mock-scored.png` and confirm:
- No standalone legend row appears above the ranking cards.
- The rank-1 (hero) card shows a 3-column table (number, category name, score) below its total score.
- Rank 2/3 (podium) and rank 4+ (default/grid) cards show only their radar with numbered axis ticks — no table.

Also view `screenshots/dashboard-mock-unscored.png` and confirm the hero card's table still renders all 5 rows with "—" for unknown categories (rather than omitting rows).

- [ ] **Step 4: Report readiness**

No commit in this step — Tasks 1-3 already committed their changes. This task is verification-only; if Step 1-3 all pass, the branch is ready for the same push/PR-update flow already established for this PR (#214): show the regenerated screenshot to the user and get explicit go-ahead before pushing.
