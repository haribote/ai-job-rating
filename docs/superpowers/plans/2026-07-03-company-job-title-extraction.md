# 会社名・職種タイトル抽出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推奨）or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ランキングカードのタイトルが求人 URL のまま表示される問題を解消する。会社名・職種タイトルを AI 抽出し、表示専用（スコアリング非依存）でランキング・詳細に表示する（#200 / 親 #205 Wave A）。

**Architecture:** `companyName`/`jobTitle` は **`NormalizedKey`/`NormalizedJob` に一切追加しない**。理由: `NormalizedJob`（`src/shared/job-schema.ts:108-110`）は全正規キー網羅の mapped type で、`NormalizedKey` に追加すると `CATEGORY_OF`（`src/shared/categories.ts`）・`NORMALIZED_KEY_KINDS`（`src/server/scoring/criteria-config.ts:40-56`）という網羅的 exhaustive map への追加が型的に強制され、スコアリング対象へ取り込まれてしまう（抽出↔スコアリング分離のガードレール違反、要件 §5.3）。

代わりに `extractions` テーブルへ**並列カラム**として追加し、抽出パイプラインでも `NORMALIZED_KEYS` の反復ロジックとは別の「素の自由記述」経路で扱う。これにより `ScoringConfig`/`scoreJob` から構造的に到達不可能にする。

**Tech Stack:** TypeScript / Vitest（`@cloudflare/vitest-pool-workers` server project）/ Biome / D1 migrations。

## Global Constraints

- TDD（t-wada メソッド: Red → Green → Refactor）。決定的ロジックは unit test 必須。
- コメント・テスト名は日本語で簡潔に。「何を」より「なぜ」。
- Biome 準拠（タブインデント・保存時整形）。`any` 禁止。
- 既存パターンに合わせる（周囲の命名・スタイル）。
- テスト実行: `npx vitest run --project server <path>`（server project 限定）。
- 抽出とスコアリングの分離・unknown 中立・ラベル正規化のガードレールを厳守する（CLAUDE.md）。
- 秘匿ファイル（`.dev.vars` 等）には触れない。live な Workers AI 検証（golden eval）は `#159` の手順に従い別途行う（本プランは offline 実装まで）。
- 親 Issue: #200（トラッキング #205 Wave A）。#198 も同時に `migrations/0004_*.sql` を追加するため、マージ順で本 Issue 側が `0005_` へリナンバーする可能性がある（Task 1 Step 4 で確認）。

---

### Task 1: migration と db-schema.ts — extractions に company_name/job_title を追加する

**Files:**
- Add: `migrations/0004_add_company_job_title.sql`（#198 の `0004_seed_default_criteria.sql` と番号が衝突したら `0005_` へリナンバー）
- Modify: `src/server/storage/db-schema.ts`（`ExtractionRow` L63-75 付近）
- Test: `src/server/storage/db-schema.test.ts`（存在すれば型/定数のみのためテスト不要。無ければ Task 3 の ingest 往復テストで間接的に担保）

**Interfaces:**
- Produces: `ExtractionRow.company_name: string | null` / `ExtractionRow.job_title: string | null`。

- [ ] **Step 1: 既存 migration 番号を確認（Red 前の前提確認）**

Run: `ls migrations/`
Expected: `0001_init_phase1.sql` `0002_companies.sql` `0003_reputation.sql` に加え、並行実装中の #198 が `0004_seed_default_criteria.sql` を追加済みかもしれない。既に存在すれば本 Task は `0005_add_company_job_title.sql` として作成する。

- [ ] **Step 2: migration ファイルを追加**

`migrations/0004_add_company_job_title.sql`（または `0005_`）:

```sql
-- 会社名・職種タイトルは表示専用（スコアリング非依存）。NormalizedJob/NormalizedKey には含めない
-- （抽出とスコアリングの分離・§5.3）。抽出できなければ NULL のまま（UI は sourceUrl へフォールバック）。
ALTER TABLE extractions ADD COLUMN company_name TEXT;
ALTER TABLE extractions ADD COLUMN job_title TEXT;
```

- [ ] **Step 3: `ExtractionRow` 型を拡張**

`src/server/storage/db-schema.ts` の `ExtractionRow`（L63-75 付近）に追加:

```ts
	// 会社名・職種タイトル（表示専用・スコアリング非依存）。抽出できなければ null（#200）。
	readonly company_name: string | null;
	readonly job_title: string | null;
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0（既存コードは `ExtractionRow` を分割代入で使う箇所が無ければ影響なし。あれば Task 3-5 で順次埋める）。

- [ ] **Step 5: Commit**

```bash
git add migrations/ src/server/storage/db-schema.ts
git commit -m "feat(storage): add company_name/job_title columns to extractions"
```

---

### Task 2: extract.ts — companyName/jobTitle を自由記述として抽出する

**Files:**
- Modify: `src/server/extract/extract.ts`
  - `ExtractionResult`（L57-66）
  - `fieldsFromObject`（L534-544）を汎用化
  - `extractRawFields`/`extractFcRawFields`/`parseExtractionOutput`（L564-653）に keys 引数を通す
  - `buildExtractionJsonSchema`（L187-197）/`buildExtractionTool`（L221-233）
  - `extractJob`（L699-757）/`extractJobFromHtml`（L768-792）
- Test: `src/server/extract/extract.test.ts`

**Interfaces:**
- Consumes: 既存 `isUnknownRaw(raw): boolean`（`src/shared/job-schema.ts:147-151`、extract.ts は既に import 済み）。
- Produces:
  - `PLAIN_TEXT_FIELDS = ["companyName", "jobTitle"] as const`（module-private）。
  - `ExtractionResult.companyName: string | null` / `ExtractionResult.jobTitle: string | null`。

- [ ] **Step 1: 失敗する統合テストを追加（Red）**

`src/server/extract/extract.test.ts` に追加（`extractJob`/`rawFieldsToNormalizedJob` の既存テスト群の近く）:

```ts
	it("companyName/jobTitle を自由記述として抽出し NormalizedJob には含めない", async () => {
		const ai = fakeAiRunner({
			response: {
				companyName: "株式会社サンプル",
				jobTitle: "バックエンドエンジニア",
			},
		});
		const result = await extractJob(ai, "求人本文");
		expect(result.companyName).toBe("株式会社サンプル");
		expect(result.jobTitle).toBe("バックエンドエンジニア");
		// NormalizedJob 側のキー集合に companyName/jobTitle が紛れ込んでいないことを型・実行時の両面で確認。
		expect(Object.keys(result.job)).not.toContain("companyName");
		expect(Object.keys(result.job)).not.toContain("jobTitle");
	});

	it("companyName/jobTitle が未記載（-）なら null にする", async () => {
		const ai = fakeAiRunner({ response: { companyName: "-", jobTitle: "" } });
		const result = await extractJob(ai, "求人本文");
		expect(result.companyName).toBeNull();
		expect(result.jobTitle).toBeNull();
	});
```

（`fakeAiRunner` は既存テストファイル内のヘルパー名に合わせる。無ければ既存の AI モック構築パターンに倣う。）

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/extract/extract.test.ts -t "companyName/jobTitle"`
Expected: FAIL（`ExtractionResult` に `companyName`/`jobTitle` が無くコンパイルエラーになる、または `undefined`）。

- [ ] **Step 3: `ExtractionResult` に companyName/jobTitle を追加**

`src/server/extract/extract.ts` の `ExtractionResult`（L57-66）に追加:

```ts
	// 会社名・職種タイトル（表示専用）。抽出できなければ null（抽出とスコアリングの分離・§5.3。
	// NormalizedKey には含めない＝スコアリングから構造的に到達不可能にする）。
	readonly companyName: string | null;
	readonly jobTitle: string | null;
```

- [ ] **Step 4: 自由記述フィールド定数を追加**

`KIND_BY_KEY`（L96-107）の直後に追加:

```ts
// 自由記述・開集合のプレーンテキストフィールド（#200）。NORMALIZED_KEYS とは独立に持ち、
// NormalizedJob/ScoringConfig には一切乗せない（スコアリングから構造的に到達不可能にする・§5.3）。
const PLAIN_TEXT_FIELDS = ["companyName", "jobTitle"] as const;
type PlainTextFieldKey = (typeof PLAIN_TEXT_FIELDS)[number];

const PLAIN_TEXT_DESCRIPTIONS: Record<PlainTextFieldKey, string> = {
	companyName: "求人票に記載の正式な企業名を原文の表記のまま返す。記載が無ければ『-』。",
	jobTitle: "求人の職種・ポジション名を原文の表記のまま返す。記載が無ければ『-』。",
};
```

- [ ] **Step 5: `fieldsFromObject` を汎用化**

`fieldsFromObject`（L534-544）を、任意のキー集合を受け取る形へ変更:

```ts
// 任意のオブジェクトから、指定キー集合ぶんの「キー = 文字列」ペアだけを拾う（両機構の最終合流点）。
// 想定外（非オブジェクト・非文字列値）は無視し、取れたキーのみ返す（落とさない）。
function pickStringFields<K extends string>(
	obj: unknown,
	keys: readonly K[],
): Partial<Record<K, string>> {
	if (typeof obj !== "object" || obj === null) return {};
	const fields: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const value = (obj as Record<string, unknown>)[key];
		if (typeof value === "string") {
			fields[key] = value;
		}
	}
	return fields;
}
```

呼び出し元 `extractRawFields`（L564-578 の `fieldsFromObject(obj)` 呼び出し2箇所）と `extractFcRawFields`（L628-643 の1箇所）を `pickStringFields(obj, NORMALIZED_KEYS)` に置換。

- [ ] **Step 6: `parseExtractionOutput` を keys 引数付きに変更**

`extractRawFields`/`extractFcRawFields`/`parseExtractionOutput`（L564-653）のシグネチャに `keys: readonly string[]` を追加し、内部の `pickStringFields(obj)` 呼び出しへ引き回す。呼び出し元（`extractJob` 内 L729）は `parseExtractionOutput(output, mechanism, NORMALIZED_KEYS)` に更新。

- [ ] **Step 7: companyName/jobTitle 抽出関数を追加**

`parseExtractionOutput` 定義の直後に追加:

```ts
// AI の生出力から companyName/jobTitle を取り出す（決定的）。未記載・空は null（表示は sourceUrl へ
// フォールバック）。NORMALIZED_KEYS の正規化パイプライン（rawToFieldValue 等）は一切通さない。
function extractPlainTextFields(
	output: unknown,
	mechanism: ExtractionMechanism,
): { companyName: string | null; jobTitle: string | null } {
	const fields = parseExtractionOutput(output, mechanism, PLAIN_TEXT_FIELDS);
	const clean = (raw: string | undefined): string | null => {
		if (raw === undefined) return null;
		const trimmed = raw.trim();
		return isUnknownRaw(trimmed) ? null : trimmed;
	};
	return {
		companyName: clean(fields.companyName),
		jobTitle: clean(fields.jobTitle),
	};
}
```

- [ ] **Step 8: JSON Schema / FC ツールへプロパティ追加**

`buildExtractionJsonSchema`（L187-197）の `for (const key of NORMALIZED_KEYS)` ループの直後に追加:

```ts
	for (const key of PLAIN_TEXT_FIELDS) {
		properties[key] = { type: "string", description: PLAIN_TEXT_DESCRIPTIONS[key] };
	}
```

`buildExtractionTool`（L221-233）の `required` は `[...NORMALIZED_KEYS]` のまま変更しない（companyName/jobTitle は必須にしない＝抽出できなくても全体を失敗させない）。`properties` は `buildExtractionJsonSchema()` 経由で自動的に companyName/jobTitle を含む。

- [ ] **Step 9: `extractJob`/`extractJobFromHtml` を配線**

`extractJob`（L699-757）の3箇所の return（空本文 L714-720・成功 L730-736・失敗 L750-756）に `companyName`/`jobTitle` を追加:
- 空本文・失敗時: `companyName: null, jobTitle: null`
- 成功時: `const plainText = extractPlainTextFields(output, mechanism); return { job: ..., ...plainText, model, mechanism, extractedAt, status: "ok" };`

`extractJobFromHtml`（L768-792）の return（L781-791）に追加:
```ts
		companyName: mainResult.companyName,
		jobTitle: mainResult.jobTitle,
```
（分割パスの `benefitsResult` は福利厚生セクションのみの抽出のため companyName/jobTitle には使わない。）

- [ ] **Step 10: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/extract/extract.test.ts`
Expected: PASS（全テスト green、既存テストの `ExtractionResult` を直接構築している箇所があれば `companyName`/`jobTitle` を追加する必要がある点に注意）。

- [ ] **Step 11: biome / tsc**

Run: `npx biome check src/server/extract/extract.ts src/server/extract/extract.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 12: Commit**

```bash
git add src/server/extract/extract.ts src/server/extract/extract.test.ts
git commit -m "feat(extract): extract companyName/jobTitle as display-only free text"
```

---

### Task 3: ingest.ts — 永続化

**Files:**
- Modify: `src/server/storage/ingest.ts`（`INSERT INTO extractions` L114-131 付近）
- Test: `src/server/storage/ingest.test.ts`（存在すれば往復テストに companyName/jobTitle を追加）

**Interfaces:**
- Consumes: `ExtractionResult.companyName`/`jobTitle`（Task 2）。
- Produces: `extractions.company_name`/`job_title` 行。

- [ ] **Step 1: 失敗する往復テストを追加（Red）**

`ingest.test.ts`（無ければ最も近い統合テストファイル）に、`ingestJob` 実行後に `SELECT company_name, job_title FROM extractions WHERE job_id = ?` で期待値を確認するテストを追加。

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/storage/ingest.test.ts -t "company_name"`
Expected: FAIL（現状 INSERT 文にカラムが無いため常に NULL または列不足エラー）。

- [ ] **Step 3: INSERT 文を拡張（Green）**

`src/server/storage/ingest.ts`（L114-131 付近）を以下のように拡張:

```ts
	await deps.db
		.prepare(
			`INSERT INTO ${TABLE_NAMES.extractions}
			 (id, job_id, structured_json, model, mechanism, extraction_status, extracted_at, company_name, job_title)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId(),
			jobId,
			JSON.stringify(extraction.job),
			extraction.model,
			extraction.mechanism,
			dbStatus,
			ts,
			extraction.companyName,
			extraction.jobTitle,
		)
		.run();
```

- [ ] **Step 4: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/storage/ingest.test.ts`
Expected: PASS。

- [ ] **Step 5: biome / tsc**

Run: `npx biome check src/server/storage/ingest.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 6: Commit**

```bash
git add src/server/storage/ingest.ts src/server/storage/ingest.test.ts
git commit -m "feat(storage): persist companyName/jobTitle on ingest"
```

---

### Task 4: ランキング一覧への配線（ranking.ts / ranking-list.ts）

**Files:**
- Modify: `src/server/scoring/ranking.ts`（`readJobsWithExtraction` L49-59 付近・`JobMaterial` インターフェース）
- Modify: `src/server/ranking-list.ts`（`toRankingItem` L79-90 付近、`RankedJobView`/`rescoredToView` L26-65 付近）
- Test: `src/server/ranking-list.test.ts`

**Interfaces:**
- Consumes: `extractions.company_name`/`job_title`（Task 1/3）。
- Produces: `toRankingItem(view).company`/`.title` が実値を返す。

- [ ] **Step 1: 失敗するテストを追加（Red）**

`src/server/ranking-list.test.ts` に、`companyName`/`jobTitle` を持つ `RankedJobView` フィクスチャから `toRankingItem` が `company`/`title` に実値を返すことを検証するテストを追加。

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/ranking-list.test.ts -t "company"`
Expected: FAIL（現状 `toRankingItem` は `company: null, title: null` に固定）。

- [ ] **Step 3: `readJobsWithExtraction` の SELECT を拡張**

`src/server/scoring/ranking.ts` の `JobMaterial`（L46-51 付近）に `companyName: string | null` / `jobTitle: string | null` を追加し、SELECT 文（L52-59 付近）に `e.company_name AS company_name, e.job_title AS job_title` を追加、map 構築部（L69-76 付近）にも反映。

- [ ] **Step 4: `RankedJobView`/`rescoredToView` を配線**

`src/server/ranking-list.ts` の `RankedJobView`（L26-34 付近）に `companyName: string | null` / `jobTitle: string | null` を追加し、`rescoredToView`（L44-65 付近）の引数からこれを渡す。呼び出し元 `src/server/scoring/ranking.ts` の `toView()`（L202-212 付近）で `JobMaterial.companyName`/`jobTitle` を渡す。

- [ ] **Step 5: `toRankingItem` を更新（Green）**

`src/server/ranking-list.ts` の `toRankingItem`（L79-90）:

```ts
	return {
		jobId: view.jobId,
		sourceUrl: view.sourceUrl,
		company: view.companyName ?? null,
		title: view.jobTitle ?? null,
		total: view.total,
		status: view.status,
		rejectedBy: view.rejectedBy,
	};
```

- [ ] **Step 6: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/ranking-list.test.ts src/server/scoring/ranking.test.ts`
Expected: PASS。

- [ ] **Step 7: biome / tsc**

Run: `npx biome check src/server/scoring/ranking.ts src/server/ranking-list.ts src/server/ranking-list.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: 終了コード 0。

- [ ] **Step 8: Commit**

```bash
git add src/server/scoring/ranking.ts src/server/ranking-list.ts src/server/ranking-list.test.ts
git commit -m "feat(ranking): wire companyName/jobTitle into ranking items"
```

---

### Task 5: 求人詳細への配線（jobs.ts）

**Files:**
- Modify: `src/server/jobs.ts`（`readJobDetail` の SELECT L296-307 付近・`JobDetailMeta` L226-232 付近）
- Test: `src/server/jobs.test.ts`

**Interfaces:**
- Produces: `readJobDetail(...).company`/`.title`（または既存命名に揃えたフィールド名）が実値を返す。

- [ ] **Step 1: 失敗するテストを追加（Red）**

`src/server/jobs.test.ts` に、company_name/job_title を持つ抽出行から `readJobDetail` が実値を返すテストを追加。

- [ ] **Step 2: テストが落ちることを確認（Red）**

Run: `npx vitest run --project server src/server/jobs.test.ts -t "company"`
Expected: FAIL（現状 `JobDetailMeta` に company/title 相当のフィールドが無い）。

- [ ] **Step 3: SELECT と型を拡張（Green）**

`readJobDetail`（L290-430）の `extractions` SELECT（L311-320 付近）に `company_name`, `job_title` を追加し、`JobDetailMeta`（L226-232 付近）に `companyName: string | null` / `jobTitle: string | null` を追加して詰める。

- [ ] **Step 4: テストが通ることを確認（Green）**

Run: `npx vitest run --project server src/server/jobs.test.ts`
Expected: PASS。

- [ ] **Step 5: クライアント側の型を確認**

`src/client/lib/jobDetail.ts` に対応する型があれば `companyName`/`jobTitle` を追加し、`JobDetailSheet.tsx` 等の表示側で見出しに使えるか確認（本 Task では最小限、型・API 契約の配線までとし、詳細画面の見出し表示 UI 変更が必要なら別途小さな follow-up とする）。

- [ ] **Step 6: biome / tsc（server + client）**

Run: `npx biome check src/server/jobs.ts src/server/jobs.test.ts && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.client.json`
Expected: 終了コード 0。

- [ ] **Step 7: Commit**

```bash
git add src/server/jobs.ts src/server/jobs.test.ts src/client/lib/jobDetail.ts
git commit -m "feat(jobs): expose companyName/jobTitle on job detail"
```

---

### Task 6: golden fixture（非ブロック・情報用途）

**Files:**
- Modify: 既存 `test-fixtures/golden/*.example.json` のうち2〜3件

**Interfaces:**
- 変更なし（`expected` に未列挙のキーは採点対象外という既存仕様のまま。README の方針を変更しない）。

- [ ] **Step 1: 代表 fixture に companyName/jobTitle の期待値を追記**

2〜3件の `*.example.json` の `expected` に `companyName`/`jobTitle` の期待文字列を追加する（`kind` 付き値ではなく単純文字列。golden ランナー（`src/server/extract/golden.ts`）がこの2キーを厳密一致の pass/fail 判定に使わないことを確認する。使う実装になっている場合は、この2キーを判定対象から明示的に除外する）。

- [ ] **Step 2: golden ランナーの挙動確認**

Run: `npx vitest run --project server src/server/extract/golden.test.ts`（存在すれば）
Expected: PASS。companyName/jobTitle の不一致で全体が fail しないことを確認。

- [ ] **Step 3: Commit**

```bash
git add test-fixtures/golden/
git commit -m "test(golden): add companyName/jobTitle reference examples (non-blocking)"
```

---

### Task 7: 全体 offline 検証

**Files:** なし（検証のみ）

- [ ] **Step 1: server テスト全通過**

Run: `npx vitest run --project server`
Expected: 全 test files PASS。

- [ ] **Step 2: 型チェック（server + client）**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.client.json`
Expected: 終了コード 0。

- [ ] **Step 3: biome 全体**

Run: `npx biome check .`
Expected: 終了コード 0。

- [ ] **Step 4: NormalizedKey に companyName/jobTitle が紛れていないことの最終確認**

Run: `rg -n "companyName|jobTitle" src/shared/job-schema.ts src/shared/categories.ts src/server/scoring/`
Expected: ヒットなし（スコアリング関連ファイルに一切現れない＝構造的分離の担保）。

- [ ] **Step 5: wrangler dry-run（migration 構文確認・secrets 不要）**

Run: `npx wrangler d1 migrations apply ai-job-rating --local --dry-run`（または既存の e2e webServer 起動プロセスに委ねる）
Expected: 新規 migration がエラーなく認識される。

- [ ] **Step 6: 抽出失敗時のフォールバック確認**

`extraction_status: "failed"` の求人で `RankingCard` の `heading` が `sourceUrl` にフォールバックすることをコンポーネントテスト（既存 `RankingCard.test.tsx`）で確認する（company/title 双方 null のケースは既存テストで既にカバーされているはずなので回帰確認のみ）。

- [ ] **Step 7: golden eval（live・#159 手順、secrets が必要なため別途実施）**

`#159` の Workers AI モデル eval スキルの手順に従い、既定 `EXTRACTION_MODEL`（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`）で companyName/jobTitle の抽出品質を live 確認する。劣化があれば据え置き判断し、Issue に記録する。

---

## Self-Review

**Spec coverage:**
- DB スキーマ拡張（extractions.company_name/job_title）→ Task 1。
- 抽出パイプライン（自由記述フィールドの追加・JSON Schema/FC ツール拡張）→ Task 2。
- 永続化（ingest）→ Task 3。
- ランキング一覧配線 → Task 4。
- 求人詳細配線 → Task 5。
- golden fixture（非ブロック） → Task 6。
- 検証（test/tsc/biome/構造的分離確認/フォールバック/live eval） → Task 7。
- 抽出とスコアリングの分離ガードレール → `NormalizedKey`/`NormalizedJob`/`CATEGORY_OF`/`NORMALIZED_KEY_KINDS` を一切変更しないという設計判断で担保（Task 2 冒頭 Architecture 節・Task 7 Step 4 で最終確認）。

**Placeholder scan:** なし（全 step に実コード・実コマンド）。

**Type consistency:** `ExtractionResult.companyName/jobTitle`（Task 2 定義）→ `ingest.ts`（Task 3）・`ranking.ts`/`ranking-list.ts`（Task 4）・`jobs.ts`（Task 5）が一貫して同名フィールドを参照。`PLAIN_TEXT_FIELDS`/`pickStringFields`（Task 2 内で定義・使用）は module-private で外部依存なし。整合。

**既知のリスク・申し送り:**
- Task 1 の migration 番号は #198（`0004_seed_default_criteria.sql`）との並行実装により衝突しうる。実装開始時に `ls migrations/` で確認しリナンバーする。
- Task 5 のクライアント側詳細表示 UI 変更は本プランでは配線までとし、見出し表示の実際の差し替えが必要な場合は小さな follow-up とする（#200 の受け入れ条件はランキング一覧の表示が主眼のため）。
