# flexWork をフレックス専用にする（裁量労働を除外）

## Context（なぜ）

`flexWork` 軸が **フレックスタイム（労働者が始業終業を選べる＝望ましい）** と **裁量労働＝みなし労働（実働がみなしで固定され長時間化リスク＝むしろ逆）** を同一軸に束ねている。両者は性質が逆で、同一の `flexWork` categorical 値（`flex` / `discretionary`）として混在させると軸の意味が濁る。

混在は2箇所に存在する:
- `src/shared/job-schema.ts` `SECTION_LABEL_MAP`: 「フレックス」も「裁量労働」も同じ `flexWork` キーへ寄せる。
- `src/server/extract/extract.ts` `CATEGORY_RULES.flexWork`: 「フレックス」→`flex`／「裁量労働・裁量・みなし(労働)」→`discretionary`。

これは #141 の live golden eval でも顕在化した。flexWork は golden 4 件すべて期待値 `["flex"]` だが全候補モデルが regress し、strict no-regression gate を単一フィールドで支配していた（runner 自体は正しく動作）。本変更は flexWork の **意味の明確化**であり、eval gate の方針変更とは独立。

**ゴール**: `flexWork` を **フレックスの有無のみ**を表す軸にする。裁量労働は flexWork として抽出しない（どの軸にもマッピングしない）。

## 設計判断（確定済み）

- 裁量労働の扱い = **flexWork から除外（抽出しない）**。独立軸化・負シグナル化は今回行わない（スコープ外）。
- flexWork canonical 値は **`flex` か unknown のみ**になる。
- §5.2 ガードレール準拠: フレックス記載が無い求人（裁量労働のみ含む）は flexWork=unknown → **中立**（分母から除外）。

## 変更点

### プロダクションコード（3ファイル）

1. **`src/server/extract/extract.ts`** — `CATEGORY_RULES.flexWork`
   - 削除: `["裁量労働","discretionary"]` `["裁量","discretionary"]` `["みなし労働","discretionary"]` `["みなし","discretionary"]`
   - 残す: `["フレックス","flex"]`
   - コメント（L362 付近）を flex 専用へ更新。
   - **`hasNegation` の「みなし」除去ガード（L378-381, L381 `replace(/みなし/g,"")`）は残す**。`なし`⊂`みなし` による否定誤判定を防ぐ汎用安全策で、flexWork 以外にも効く。stale な「discretionary の語」コメントのみ修正。
   - **flexWork を closed categorical 化（必須）**: 現状の categorical 構築は未マップ値を捨てず生表記をカテゴリに残す（`rawToFieldValue` の `categories: [canonical ?? value]`・L485-489）。このままだと `flexWork:"裁量労働制"` → `categories:["裁量労働制"]` となり preferred=`["flex"]` 下で unknown 中立にならず 0 点側に落ちる。これを防ぐため flexWork は **canonical（=flex）に寄らない値を unknown へ畳む**。実装: `CLOSED_CATEGORICAL_KEYS: ReadonlySet<NormalizedKey> = new Set(["flexWork"])` を追加し、categorical 分岐で `canonical === null && CLOSED_CATEGORICAL_KEYS.has(key)` のとき `{ kind: "unknown", raw: value }` を返す（remoteWork/skillMatch 等の open categorical は従来通り生表記を保持）。これにより flexWork の値は **`flex` か `unknown` のみ**になり、裁量労働・「フレックス不可」・裸の「有/あり」はすべて中立（§5.2）。

2. **`src/shared/job-schema.ts`** — `SECTION_LABEL_MAP`
   - 削除: `["裁量労働","flexWork"]` `["裁量労働制","flexWork"]`
   - 残す: `["フレックス","flexWork"]` `["フレックスタイム","flexWork"]`
   - 効果: 裁量労働セクション見出しが flexWork に寄らない。

3. **`src/server/scoring/score.ts`** — flexWork 既定 preferred（L318-323 付近）
   - `preferred: ["yes","flex","discretionary"]` → **`["flex"]`**
   - "discretionary" は除外対象。"yes" は flexWork canonical 値に出現しない dead 値のため併せて整理。
   - コメント「フレックス・裁量労働は有を歓迎」→ flex のみへ修正。

### 変更しないもの（意図的）

- `src/server/extract/content-extract.ts` の `"裁量労働"`（HTML セクション保全キーワード・モデル非依存・L43）は**残す**。本件は flexWork 軸の意味の話であり、HTML から裁量労働文脈を消す話ではない（overtime 等に影響しうる）。
- `src/shared/categories.ts`（flexWork は flexibility 軸のまま）。
- `test-fixtures/golden/*`（全 case が `flexWork: ["flex"]` 期待で不変）。

### テスト更新（TDD: Red → Green）

- **`src/server/extract/extract.test.ts`**（L344-360）: 旧2テストを書き換え。
  - 「裁量労働制 → discretionary」→ **「裁量労働制 → unknown（flexWork に寄せない）」**
  - 「みなし労働 → discretionary」→ **「みなし単体 → unknown かつ否定誤判定なし」**
  - 「フレックス → flex」は維持（明示テスト）。
- **`src/server/scoring/rescore-core.test.ts`**（L113-136）/ **`src/server/scoring/criteria-config.test.ts`**（L77,83）: 採点機構テストの例値 `discretionary` を `flex`（または別の有効 categorical）へ差し替え。discretionary を有効値と誤認させない。

## 留意（既存データ）

- 既存保存ジョブに `flexWork=discretionary` が残っていれば、preferred=`["flex"]` 下で当該フィールドは非マッチ（0 点側）になる。抽出は config 変更で再実行しない（ガードレール）ため、中立化には再 ingest が要る。Phase 1 で本番データ僅少のため特例化せず許容（本節に記録）。

## 検証

- 決定的ロジック＋ユニットテストで担保（live AI 非依存）。
- `npm run test:server`（vitest server）/ `biome check` / `tsc -p tsconfig.json` green。
- 受け入れ: extract が フレックス→`flex`・裁量労働/みなし/「フレックス不可」→`unknown`（closed categorical）を返す。flexWork の値は `flex` か `unknown` のみ。scoring 既定 preferred が `["flex"]`。`discretionary` への参照がプロダクションコードから消える（テストの例値も整理）。
- live golden eval の再実行は **不要**（本変更は決定的。flexWork の意味が締まる効果は別途 eval で観測可だが必須でない）。

## スコープ外

- 裁量労働の独立軸化・負シグナル化。
- eval gate 方針変更（単一フィールド劣化の許容）や候補モデル採用（#141 の別判断）。
