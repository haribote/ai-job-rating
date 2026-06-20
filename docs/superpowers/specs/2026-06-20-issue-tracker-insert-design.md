# issue-tracker insert モード — 設計仕様

後から起票した単一 Issue を、適切なマイルストーン設定の上で既存の Wave 構造へ差し込み、トラッキング親 Issue に反映する機能の設計。既存 [issue-tracker](../../../.claude/skills/issue-tracker/SKILL.md) skill の拡張として実装する。

## Context

[issue-tracker](../../../.claude/skills/issue-tracker/SKILL.md) はマイルストーン内 Issue を**一括**で解析し、Wave 構築・親 Issue 作成・native sub-issues 紐付けまで行う（bootstrap）。一方、開発中にスコープが判明して**後から単一 Issue を起票**するケースでは、(a) 適切なマイルストーン設定、(b) 優先順位・依存の見直しと Wave への差し込み、(c) トラッキング親 Issue への反映（sub-issue 紐付け＋body 更新）が必要になる。これを手動で行うと、sub-issue 紐付け漏れにより [wave-rider](../../../.claude/skills/wave-rider/SKILL.md) が当該 Issue を拾えない、着手順の一次ソース（親 body）がずれる、といったギャップが生じる。

本機能は issue-tracker（bootstrap）と wave-rider（実行）の間を埋める**増分投入**の役割を担う。

## 設計判断（確定事項）

| 論点 | 決定 |
|---|---|
| skill 構成 | **issue-tracker を拡張**（独立 skill にしない）。bootstrap / insert の 2 モード |
| 呼び出し | `/issue-tracker insert #N`（bootstrap は従来どおり、引数省略または `bootstrap <milestone>`） |
| 配置の自律度 | **提案→ユーザー承認→反映**。マイルストーン・依存・Wave 位置は judgment のため誤配置を防ぐ |
| 紐付け機構 | bootstrap と共有（native sub-issues / addSubIssue REST、親 body 更新） |

## モード構成

issue-tracker を引数でモード切替する。

- **bootstrap**（既定）: マイルストーン全体を解析 → Wave 構築 → 親 Issue 作成 → 全 sub-issue 紐付け。（既存手順、変更なし）
- **insert**: 単一 Issue #N を既存構造へ差し込む。（本仕様）

共有コンポーネント（重複を作らない）:
- native sub-issues 紐付け（子 `.id` 取得 → REST `POST .../sub_issues`、GraphQL フォールバック）
- 親 body の Wave 表・着手順・申し送りの更新
- マイルストーン名の正確取得・付与・検証

## insert モードの手順

1. **読み込み**: #N の title / body / labels と、`docs/roadmap.md`（Phase 定義）/ `docs/requirements.md`（責務分離）を読む。
2. **マイルストーン推定（提案）**: labels（`area:*` 等）と内容を roadmap の Phase に照合し、適切なマイルストーンを推定する。
3. **トラッキング Issue 特定**: 推定マイルストーンの `[tracking]` 親 Issue を探す。
   - 無い場合 → 差し込み先が存在しないため、bootstrap の先行実行を促して停止。
4. **依存・Wave 再評価**: 既存 sub-issue 群と #N を比較し、
   - #N が依存するもの（先行が必要）／#N に依存されるもの（後続）を判定。
   - 差し込む Wave（既存 Wave or 新設）を決める。
   - 依存により**既存着手順の入れ替えが必要なら**その差分も算出。
5. **提案（承認ゲート）**: 次を提示してユーザー承認を得る。
   - マイルストーン
   - 依存関係（先行・後続）
   - 差し込む Wave 位置
   - 既存順の変更有無
   - 追記する申し送り
6. **反映（承認後）**:
   - `gh issue edit #N --milestone "<正確な title>"` → `gh issue view #N --json milestone` で検証。
   - #N を親の native sub-issue として紐付け（共有機構）。
   - 親 body の Wave 表・着手順サマリ・申し送りを更新。
   - 必要なら `status:*` ラベル付与。
7. **検証**: マイルストーン付与・sub-issue 紐付け・親 body 反映を確認。

## エッジケース

- **マイルストーンが親と異なる**: 推定マイルストーンの別トラッキング Issue を対象にする（Phase 0 の親に Phase 1 の Issue を差し込まない）。
- **対象マイルストーンのトラッキング Issue が無い**: bootstrap 先行を促して停止（勝手に親を作らない）。
- **依存による順序変更**: wave-rider は親 body を source of truth として読むため、順序変更は body に正確に反映する。曖昧なら提案段階でユーザーに確認。
- **#N が既に sub-issue 化済み**: 二重紐付けを避け、body の差分更新のみ行う（冪等）。

## 既存資産との関係

- **issue-tracker bootstrap**: 紐付け・body 更新ロジックを共有。
- **wave-rider**: insert により親 body の Wave/着手順が最新化されることで、`/wave-rider #NN` の ready-set 算出が新 Issue を正しく拾える。
- **GitHub native sub-issues**: bootstrap と同一の REST / GraphQL 機構。

## 検証（実装時）

- `/issue-tracker insert #N` で #N のマイルストーンが提案され、承認後に正しく付与・検証されること。
- #N が対象トラッキング Issue の native sub-issue として紐付くこと。
- 親 body の Wave 表・着手順・申し送りに #N が反映されること。
- 対象マイルストーンのトラッキング Issue が無い場合に bootstrap を促して停止すること。
- 既に紐付け済みの #N で二重紐付けが起きず body 差分のみ更新されること（冪等）。
- 秘匿ファイルに触れないこと。

## 未解決・要検証

- マイルストーン推定の精度（labels/内容 → Phase）は提案ゲートで人間が補正する前提。自動確定はしない。
