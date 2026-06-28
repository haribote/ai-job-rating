# flexWork flex-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `flexWork` 軸をフレックスの有無のみで評価し、裁量労働（みなし労働）を flexWork として抽出しない。

**Architecture:** 抽出時の canonical 化（`extract.ts`）・セクション見出し正規化（`job-schema.ts`）・スコアリング既定 preferred（`score.ts`）の3層から「裁量労働=discretionary」を除去する。flexWork は flex に寄らない値を unknown 中立へ畳む closed categorical にする。すべて決定的ロジックで unit test 必須。

**Tech Stack:** TypeScript / Vitest（`@cloudflare/vitest-pool-workers` server project）/ Biome。

## Global Constraints

- TDD（t-wada メソッド: Red → Green → Refactor）。決定的ロジックは unit test 必須。
- コメント・テスト名は日本語で簡潔に。「何を」より「なぜ」。
- Biome 準拠（タブインデント・保存時整形）。`any` 禁止。
- 既存パターンに合わせる（周囲の命名・スタイル）。
- テスト実行: `npx vitest run --project server <path>`（server project 限定）。
- spec: `docs/superpowers/specs/2026-06-28-flexwork-flex-only-design.md`。

---

### Task 1: extract.ts — flexWork を flex-only の closed categorical にする

**Files:**
- Modify: `src/server/extract/extract.ts`（`CATEGORY_RULES.flexWork` L362-369 / `hasNegation` コメント L378-379 / categorical 分岐 L483-490、行番号は目安）
- Test: `src/server/extract/extract.test.ts`（L344-362 の2テストを書き換え）

**Interfaces:**
- Consumes: 既存 `rawFieldsToNormalizedJob(raw): NormalizedJob`、`canonicalizeCategoryValue(key, raw): string | null`、`NormalizedKey`。
- Produces: flexWork の `NormalizedFieldValue` は `{ kind: "categorical", categories: ["flex"], ... }` か `{ kind: "unknown", raw }` のみ。新規 `CLOSED_CATEGORICAL_KEYS: ReadonlySet<NormalizedKey>`（module-private）。

- [ ] **Step 1: 既存2テストを新挙動へ書き換え（Red）**

`src/server/extract/extract.test.ts` の以下2テスト（L344-362 付近）を置き換える:

```ts
	it("フレックスは flex へ寄せ、裁量労働は flexWork に含めず unknown 中立にする", () => {
		const flex = rawFieldsToNormalizedJob({ flexWork: "フレックスタイム制" });
		const discretionary = rawFieldsToNormalizedJob({ flexWork: "裁量労働制" });
		expect(flex.flexWork.kind).toBe("categorical");
		if (flex.flexWork.kind === "categorical") {
			expect(flex.flexWork.categories).toEqual(["flex"]);
		}
		// 裁量労働＝みなし労働は flex と別物。closed categorical のため生表記を残さず unknown へ畳む。
		expect(discretionary.flexWork.kind).toBe("unknown");
	});

	// closed categorical 回帰: flex に寄らない値（みなし単体・否定）は unknown 中立。否定誤判定もしない。
	it("みなし・フレックス不可は flexWork に残さず unknown にする", () => {
		const deemed = rawFieldsToNormalizedJob({ flexWork: "みなし労働制" });
		const negated = rawFieldsToNormalizedJob({ flexWork: "フレックス不可" });
		expect(deemed.flexWork.kind).toBe("unknown");
		expect(negated.flexWork.kind).toBe("unknown");
	});
```

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/extract/extract.test.ts -t "flexWork に含めず unknown"`
Expected: FAIL（現状は `categories:["裁量労働制"]` を返すため kind は "categorical"）。

- [ ] **Step 3: `CATEGORY_RULES.flexWork` を flex 専用にする（Green の一部）**

`src/server/extract/extract.ts` の `CATEGORY_RULES.flexWork`（L362-369 付近）を置換:

```ts
		// フレックス（労働者が始業終業を選べる）→ flex のみ。裁量労働=みなし労働は別物のため寄せない（§5.2）。
		flexWork: [["フレックス", "flex"]],
```

- [ ] **Step 4: closed categorical 集合を追加**

`CATEGORY_RULES` 定義の直後（`NEGATION_TO_ONSITE` 付近 L372-375）に追加:

```ts
// flexWork は flex の有無のみを表す closed categorical。canonical(=flex)に寄らない値（裁量労働・
// 「フレックス不可」・裸の「有/あり」）は生表記を残さず unknown 中立へ畳む（§5.2）。open categorical
// （remoteWork 等）は情報を捨てず生表記をカテゴリに残す従来挙動を保つ。
const CLOSED_CATEGORICAL_KEYS: ReadonlySet<NormalizedKey> = new Set<NormalizedKey>([
	"flexWork",
]);
```

- [ ] **Step 5: categorical 分岐で closed key を unknown へ畳む**

`rawToFieldValue` の categorical 分岐（L483-490 付近 `const canonical = canonicalizeCategoryValue(...)` 以降）を置換:

```ts
	// categorical: 主要キーは canonical トークンへ寄せ scoring の preferred と突合可能にする（§5.2）。
	const canonical = canonicalizeCategoryValue(key, value);
	// closed categorical（flexWork）は canonical に寄らない値を unknown 中立にする（生表記を残さない）。
	if (canonical === null && CLOSED_CATEGORICAL_KEYS.has(key)) {
		return { kind: "unknown", raw: value };
	}
	// open categorical はマッピングに無い値も生表記を 1 カテゴリとして残す（情報を捨てない）。
	return {
		kind: "categorical",
		categories: [canonical ?? value],
		raw: value,
	};
```

- [ ] **Step 6: `hasNegation` の stale コメントを修正**

`hasNegation`（L378-379 付近）のコメントを更新（ガード自体は残す）:

```ts
// なぜ「みなし」を除くか: 否定 needle「なし」は「みなし（労働）」の部分文字列に一致し否定と誤判定する。
// みなしは否定語ではないため先に除去する（flexWork 以外の categorical でも安全側に効く汎用ガード）。
```

- [ ] **Step 7: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/extract/extract.test.ts`
Expected: PASS（全テスト green）。

- [ ] **Step 8: biome / tsc**

Run: `npx biome check src/server/extract/extract.ts src/server/extract/extract.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 9: Commit**

```bash
git add src/server/extract/extract.ts src/server/extract/extract.test.ts
git commit -m "feat(extract): make flexWork flex-only closed categorical (exclude discretionary labor)"
```

---

### Task 2: job-schema.ts — 裁量労働セクション見出しを flexWork に寄せない

**Files:**
- Modify: `src/shared/job-schema.ts`（`SECTION_LABEL_MAP` L203-204 を削除）
- Test: `src/shared/job-schema.test.ts`（`normalizeLabel` describe に回帰テスト追加）

**Interfaces:**
- Consumes: `normalizeLabel(label): NormalizedKey | null`（未マップは null）。
- Produces: `normalizeLabel("裁量労働")` / `normalizeLabel("裁量労働制")` は `null`。フレックス系は従来通り `"flexWork"`。

- [ ] **Step 1: 回帰テストを追加（Red）**

`src/shared/job-schema.test.ts` の `describe("normalizeLabel", ...)` 内（L46 付近の既存 it の後）に追加:

```ts
	it("裁量労働は flexWork に寄せない（フレックスのみ flexWork）", () => {
		expect(normalizeLabel("フレックス")).toBe("flexWork");
		expect(normalizeLabel("フレックスタイム")).toBe("flexWork");
		expect(normalizeLabel("裁量労働")).toBeNull();
		expect(normalizeLabel("裁量労働制")).toBeNull();
	});
```

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/shared/job-schema.test.ts -t "裁量労働は flexWork に寄せない"`
Expected: FAIL（現状は `normalizeLabel("裁量労働")` が `"flexWork"` を返す）。

- [ ] **Step 3: SECTION_LABEL_MAP から裁量労働を削除（Green）**

`src/shared/job-schema.ts` の以下2行（L203-204）を削除する:

```ts
	["裁量労働", "flexWork"],
	["裁量労働制", "flexWork"],
```

残すのは直前の2行:

```ts
	["フレックス", "flexWork"],
	["フレックスタイム", "flexWork"],
```

- [ ] **Step 4: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/shared/job-schema.test.ts`
Expected: PASS。

- [ ] **Step 5: biome / tsc**

Run: `npx biome check src/shared/job-schema.ts src/shared/job-schema.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 6: Commit**

```bash
git add src/shared/job-schema.ts src/shared/job-schema.test.ts
git commit -m "feat(extract): stop mapping discretionary-labor section headers to flexWork"
```

---

### Task 3: score.ts — 既定 preferred を flex のみにし、テストの discretionary 例値を整理

**Files:**
- Modify: `src/server/scoring/score.ts`（`DEFAULT_SCORING_CONFIG.items.flexWork.preferred` L318-323）
- Test: `src/server/scoring/score.test.ts`（既定 preferred を pin する回帰追加）
- Test: `src/server/scoring/rescore-core.test.ts`（L113,120,136 の `discretionary` を `flex` へ）
- Test: `src/server/scoring/criteria-config.test.ts`（L77,83 の `["flex","discretionary"]` を `["flex"]` へ）

**Interfaces:**
- Consumes: `DEFAULT_SCORING_CONFIG: ScoringConfig`（`src/server/scoring/score.ts:276` で export）。
- Produces: `DEFAULT_SCORING_CONFIG.items.flexWork.preferred` は `["flex"]`。

- [ ] **Step 1: 既定 preferred を pin する回帰テストを追加（Red）**

`src/server/scoring/score.test.ts` の先頭 describe 内（L22 付近の既存 it の近く）に追加:

```ts
	it("既定の flexWork preferred は flex のみ（裁量労働を歓迎しない）", () => {
		const flexWork = DEFAULT_SCORING_CONFIG.items.flexWork;
		expect(flexWork?.kind).toBe("categorical");
		if (flexWork?.kind === "categorical") {
			expect(flexWork.preferred).toEqual(["flex"]);
		}
	});
```

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/scoring/score.test.ts -t "既定の flexWork preferred は flex のみ"`
Expected: FAIL（現状は `["yes","flex","discretionary"]`）。

- [ ] **Step 3: 既定 preferred を flex のみにする（Green）**

`src/server/scoring/score.ts` の flexWork 定義（L318-323 付近）を置換:

```ts
		// フレックス（労働者が始業終業を選べる）の有無のみを評価する。裁量労働は別物のため歓迎値に含めない。
		flexWork: {
			weight: 1,
			kind: "categorical",
			preferred: ["flex"],
		},
```

- [ ] **Step 4: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/scoring/score.test.ts`
Expected: PASS。

- [ ] **Step 5: rescore-core.test.ts の discretionary 例値を flex へ差し替え**

`src/server/scoring/rescore-core.test.ts` の3箇所を置換:

L113:
```ts
			flexWork: { kind: "categorical", categories: ["flex"] },
```

L120 と L136（2つの `preferred: ["discretionary"]`）をいずれも:
```ts
					preferred: ["flex"],
```

- [ ] **Step 6: criteria-config.test.ts の discretionary 例値を flex へ差し替え**

`src/server/scoring/criteria-config.test.ts` の L77 と L83 を置換:

L77:
```ts
				desired_value: JSON.stringify({ preferred: ["flex"] }),
```

L83:
```ts
			preferred: ["flex"],
```

- [ ] **Step 7: scoring テスト一式を通す（Green）**

Run: `npx vitest run --project server src/server/scoring/score.test.ts src/server/scoring/rescore-core.test.ts src/server/scoring/criteria-config.test.ts`
Expected: PASS。

- [ ] **Step 8: discretionary 残存がないことを確認**

Run: `rg -n "discretionary" src`
Expected: 出力なし（プロダクション・テスト双方から消えている）。

- [ ] **Step 9: biome / tsc**

Run: `npx biome check src/server/scoring/score.ts src/server/scoring/score.test.ts src/server/scoring/rescore-core.test.ts src/server/scoring/criteria-config.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 10: Commit**

```bash
git add src/server/scoring/score.ts src/server/scoring/score.test.ts src/server/scoring/rescore-core.test.ts src/server/scoring/criteria-config.test.ts
git commit -m "feat(scoring): default flexWork preferred to flex only (drop discretionary/yes)"
```

---

### Task 4: 全体 offline 検証

**Files:** なし（検証のみ）

- [ ] **Step 1: server テスト全通過**

Run: `npx vitest run --project server`
Expected: 全 test files PASS（merge 前 492 に Task1-3 の増減を加味）。

- [ ] **Step 2: 型チェック（server+client）**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.client.json`
Expected: 終了コード 0。

- [ ] **Step 3: biome 全体**

Run: `npx biome check .`
Expected: 終了コード 0。

- [ ] **Step 4: discretionary 完全消去の最終確認**

Run: `rg -n "discretionary|裁量労働|みなし労働" src/server/extract/extract.ts src/shared/job-schema.ts src/server/scoring/score.ts`
Expected: `extract.ts` / `job-schema.ts` / `score.ts` に discretionary・裁量労働・みなし労働への参照なし（overtime 用「みなし残業」は別ファイル・別キーで対象外）。

---

## Self-Review

**Spec coverage:**
- 変更点1（extract.ts CATEGORY_RULES + closed categorical + hasNegation コメント）→ Task 1。
- 変更点2（job-schema.ts SECTION_LABEL_MAP）→ Task 2。
- 変更点3（score.ts preferred ["flex"]）→ Task 3。
- テスト更新（extract/rescore-core/criteria-config）→ Task 1・Task 3。
- 変更しないもの（content-extract.ts / categories.ts / golden）→ 触れず（プランに変更タスクなし＝意図的）。
- 既存データ留意 → コード変更なし（spec に記録のみ）。
- 検証（test:server / biome / tsc / discretionary 消去）→ Task 4。

**Placeholder scan:** なし（全 step に実コード・実コマンド）。

**Type consistency:** `CLOSED_CATEGORICAL_KEYS: ReadonlySet<NormalizedKey>`（Task1 定義・Task1 使用）。`DEFAULT_SCORING_CONFIG.items.flexWork.preferred`（Task3 で参照する既存 export）。`normalizeLabel(): NormalizedKey | null`（Task2 既存）。整合。
