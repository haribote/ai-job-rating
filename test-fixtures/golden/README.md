# golden-sample 抽出品質ゲート用フィクスチャ

実求人の golden セット（入力 HTML ＋ フィールド単位の期待値）を置く場所。抽出（モデル/プロンプト/コンテンツ抽出）の変更を「golden 精度 現行以上」で安全に回すための回帰土台。ランナーは `src/server/extract/golden.ts` の `runGolden` / `parseGoldenCase`。

## PII の扱い（重要）

実求人 HTML・期待値は **PII を含むためコミットしない**。このディレクトリの `.gitignore` は実体を ignore し、`*.example.json`（サニタイズ済み雛形）と本 README のみ追跡する。

- 実体ファイル: `*.json`（例: `acme-backend.json`）→ ignore される。ローカル/CI シークレット環境にのみ配置。
- 雛形: `*.example.json`（例: `sample-001.example.json`）→ 追跡。形式の一次ソース兼サニタイズ版。

## ケースの形式（`parseGoldenCase` が検証）

```jsonc
{
  "name": "一意なケース名",
  "html": "求人本文の HTML（trim 前で可）",
  "expected": {
    // 採点したい正規キーのみ列挙する（未指定キーは採点対象外＝分母に含めない）。
    "annualSalary": { "kind": "numericRange", "min": 700, "max": 900, "raw": "700万〜900万円" },
    "remoteWork":   { "kind": "categorical", "categories": ["full"] },
    "overtime":     { "kind": "unknown" }
  }
}
```

- `kind` は `numericRange` / `categorical` / `aiJudged` / `unknown`（`src/shared/job-schema.ts`）。
- `numericRange` の単位は万円（salary 系。`extract.ts` の正規化と揃える）。
- `categorical` は canonical トークン（例: remoteWork は `full`/`partial`/`onsite`）。表記揺れは採点時に `canonicalizeLabel` で吸収する。
- 採点対象外のフィールドは `expected` に書かない（`unknown` 中立の原則）。

## live 実行（要 Workers AI / secrets）

オフラインのユニットテスト（`golden.test.ts`）は採点・集計ロジックを fake 抽出器で決定的に検証する。実モデルでの精度計測は live 抽出が必要なため、driver から次の形で結線する:

```ts
import { runGolden, parseGoldenCase } from "../src/server/extract/golden";
import { extractJob } from "../src/server/extract/extract";
import { trimHtml } from "../src/server/extract/trim-html";

const extract = async (html: string) =>
  (await extractJob(ai /* env.AI */, trimHtml(html))).job;

const cases = rawJsonFiles.map(parseGoldenCase);
const report = await runGolden(cases, extract);
// report.perField[key] = { correct, total, accuracy }, report.overall, report.perCase
```

## CI ジョブ化

PII を含まないサンプル（`*.example.json`）のみを対象にすれば CI ジョブとして追加できる。実体（PII あり）を使う精度計測はシークレット環境でのみ実行する。
