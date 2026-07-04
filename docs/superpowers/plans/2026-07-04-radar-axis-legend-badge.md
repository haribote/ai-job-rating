# Radar Axis Legend Number Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Style the number in `RadarAxisLegend` as a small rounded badge, leaving the category label as plain text, per `docs/superpowers/specs/2026-07-04-radar-axis-legend-badge-design.md`.

**Architecture:** Single-file CSS class change on the existing `<dt>` element inside `RadarAxisLegend` (`src/client/components/RadarAxisLegend.tsx`). No structural, prop, or data changes. No new color tokens — reuses existing `bg-muted`/`text-foreground` theme variables, which already cover light/dark.

**Tech Stack:** React, Tailwind CSS v4 (`cn` utility from `@/lib/utils`), Vitest + Testing Library, Playwright (`@screenshot`).

## Global Constraints

- Do not touch `ScoreRadar.tsx` (SVG chart axis ticks) — out of scope per spec.
- Do not add a new categorical color palette to `design-tokens.ts` — out of scope per spec.
- `<dd>` (category label) stays plain text — no badge/pill styling on it.
- `data-testid="radar-axis-legend"`, `role="term"`/`role="definition"` (native `dt`/`dd` semantics), and component props (`RadarAxisLegendProps { className }`) must not change — existing tests assert on these.
- This work happens on the existing worktree branch `worktree-agent-aee8591a87e549193` (tracks PR #214) — commit here, do not create a new branch.
- Commit message convention: Conventional Commits, English, imperative, lowercase start, no trailing period, no AI co-author credits (per project's `commit` skill).

---

### Task 1: Badge-style the axis number in `RadarAxisLegend`

**Files:**
- Modify: `src/client/components/RadarAxisLegend.tsx:36-38`
- Test (regression only, no changes needed): `src/client/components/RadarAxisLegend.test.tsx`

**Interfaces:**
- Consumes: `CATEGORY_KEYS`, `CATEGORY_AXIS_NUMBERS`, `CATEGORY_LABELS` from `../../shared/categories` (unchanged imports).
- Produces: no new exports; `RadarAxisLegend` component signature (`RadarAxisLegendProps { className?: string }`) is unchanged, so `Dashboard.tsx` and `JobDetailSheet.tsx` callers are unaffected.

This is a pure presentation change — no new behavior to drive with a new failing test. The existing test suite already asserts the `dt`/`dd` structure and text content; those must stay green throughout (regression gate), and a Playwright screenshot pass is the acceptance check for the visual result (per spec's testing policy: Tailwind classes themselves aren't unit-tested in this codebase, matching the precedent set by `CARD_SIZE_STYLES` in `RankingCard.tsx`).

- [ ] **Step 1: Confirm current tests are green before changing anything**

Run: `npm test -- RadarAxisLegend` (from repo root of this worktree)
Expected: PASS (2 tests: `data-testid` present, number↔label correspondence)

- [ ] **Step 2: Change the `<dt>` className to a rounded badge**

In `src/client/components/RadarAxisLegend.tsx`, replace:

```tsx
					<dt className="font-semibold tabular-nums">
						{CATEGORY_AXIS_NUMBERS[key]}
					</dt>
```

with:

```tsx
					<dt className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-foreground">
						{CATEGORY_AXIS_NUMBERS[key]}
					</dt>
```

Leave the surrounding `<div key={key} className="flex items-baseline gap-1">` and `<dd>{CATEGORY_LABELS[key]}</dd>` untouched.

- [ ] **Step 3: Run the same tests again to confirm no regression**

Run: `npm test -- RadarAxisLegend`
Expected: PASS (identical 2 tests, unchanged assertions — only the class list changed, which these tests don't assert on)

- [ ] **Step 4: Run the full unit test suite to confirm no wider regression**

Run: `npm test`
Expected: PASS (same total count as PR #214's last green run — no new failures)

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx biome check .`
Expected: no errors

- [ ] **Step 6: Regenerate and visually inspect the screenshot artifacts**

Run: `npx playwright test e2e/screenshots.spec.ts`
Expected: 6 passed. Then open `screenshots/dashboard-mock-scored.png` and `screenshots/dashboard-mock-unscored.png` (and any screenshot covering `JobDetailSheet`, since it also renders `RadarAxisLegend`) and confirm: the axis numbers render as small filled circles, the category label text next to them is unstyled, and this holds for both the scored (known values) and unscored (all-unknown) fixtures.

- [ ] **Step 7: Commit**

```bash
git add src/client/components/RadarAxisLegend.tsx
git commit -m "style: badge the axis number in RadarAxisLegend"
```

Do not push yet — push happens after the user confirms the visual result (see plan note below).

---

## Post-plan note (not a task — orchestrator follow-up)

After Task 1 is done, show the regenerated `dashboard-mock-scored.png` to the user for final visual confirmation before pushing the commit to PR #214's remote branch. Pushing to the PR branch is otherwise unconfirmed additional-commit territory and should get an explicit go-ahead, consistent with how the rest of this session has gated pushes/merges.
