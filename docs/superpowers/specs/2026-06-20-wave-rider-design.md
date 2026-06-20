# wave-rider — 設計仕様

トラッキング親 Issue を起点に、sub-issue 単位の自律開発をオーケストレーションするプロジェクトローカル skill の設計。

## Context

Phase 0 のトラッキング親 Issue [#44](https://github.com/haribote/ai-job-rating/issues/44) に、10 件の sub-issue（#6〜#15）が Wave 構成・依存関係・申し送り付きで紐付いている（[issue-tracker](../../../.claude/skills/issue-tracker/SKILL.md) で構築）。これを「親 Issue を渡すと sub-issue 単位で開発に着手し、PR 作成・レビュー対応・受け入れ確認まで自律で回す」運用に乗せたい。

**必要性の見解**: Phase 0 の 10 issue 単体では、orchestrator を作って枯らすコストに対し payoff は限定的（手動の方が速い可能性）。一方インフラ（worktree 設定・sub-issues・`/pr`・`/code-review`・`dispatching-parallel-agents`）は既に揃っており、新規実装は**オーケストレーション層に集中**できる。Phase 1(14)＋Phase 2(14) と続くため**横断資産として投資回収できる**。よって「skill＋spike を最安 issue で end-to-end 実証 → 1〜2 件で確認 → 残りを回すか手動かを判断」を方針とする。

## 設計判断（確定事項）

| 論点 | 決定 |
|---|---|
| skill 名 / 呼び出し | `wave-rider` / `/wave-rider #44` |
| 配置 | プロジェクトローカル `.claude/skills/wave-rider/SKILL.md`（issue-tracker と同様） |
| 骨格 | **プレイブック型**。メインエージェントが orchestrator、Agent サブエージェントを駆動 |
| merge 境界 | **merge は人間ゲート**。承認後、merge→cleanup は自動 |
| secrets 依存 issue | **オフライン検証＋Draft PR でエスカレ**（hook が `.dev.vars` を遮断するため live 検証は人間に回す） |
| review-fix ループ | `/code-review`（plain。`ultra` は不可）→ 自律修正、**上限 2 回**、残件は報告にエスカレ |
| 同時実行 | worktree 分離・background。**同時実行 cap 既定 3**（ディスク／トークン制御） |

## アーキテクチャ

3 コンポーネントが GitHub（親 Issue body＋ラベル）を介して状態共有する。

| コンポーネント | 責務 | 依存 |
|---|---|---|
| **orchestrator**（メインエージェント） | 親 Issue 解析 → ready-set 算出 → subagent dispatch → 報告集約 → merge 人間ゲート → merge → cleanup → 前進 | issue-tracker / `/pr merge` |
| **dev subagent**（worktree 分離・background、issue ごとに 1） | TDD 開発 → オフライン検証 → `/pr create` → `/code-review` 修正ループ → 受け入れ確認 → 報告 | `/pr` / `/code-review` / test-driven-development |
| **状態**（GitHub） | 親 #44 body（PR 表・申し送り）＋ sub-issue の `status:*` ラベル | issue-tracker |

### コンポーネント境界（独立性）

- orchestrator は subagent の内部実装を知らない。インターフェースは **報告スキーマ** `{ issue, pr, state, acceptance, handoff }` のみ。
- dev subagent は他 subagent と状態を共有しない（worktree 分離）。共有は GitHub 上の親 Issue／ラベルに限定。
- 状態（GitHub）が単一の source of truth。orchestrator が落ちても再実行で状態から再開できる。

## データフロー

```
/wave-rider #44
  └─ orchestrator
       1. 解析: 親 #44 body + sub-issues → Wave / 依存 / 申し送り
       2. ready-set 算出（依存トポロジ駆動。Wave は可読グループ）
       3. dispatch（cap=3, worktree 分離, background）─┬─ dev subagent (issueA)
                                                      ├─ dev subagent (issueB)
                                                      └─ ...
       4. 報告集約 → 親 #44 body 更新 + status ラベル更新
       5. merge 人間ゲート: mergeable PR を一括提示 → 承認 → /pr merge
       6. cleanup（自動）: MERGED 確認 → worktree + local/remote ブランチ削除 → Issue close
       7. main を pull → ready-set 再計算 → 次の塊へ
```

### ready-set 算出

- 「依存する sub-issue が全て **merged（closed）**」の issue を着手可とする。厳密な Wave 順でなく依存トポロジ駆動（独立 issue は Wave をまたいで先行可）。
- closed はスキップ。open PR を持つ issue は途中段階から**再開**（冪等）。

### 報告スキーマ（subagent → orchestrator）

```
{
  issue:      "#N",
  pr:         "#M",
  state:      "mergeable" | "draft" | "blocked",
  acceptance: [{ 条件, 充足: true|false|"要手動検証" }],
  handoff:    "後続 issue への申し送り（あれば）"
}
```

## dev subagent コントラクト

skill が定義するプロンプト雛形に沿って、自分の worktree 内で実行する。

1. **読み込み**: 自分の sub-issue ＋親の関連申し送り ＋ docs 該当節（requirements §5.2/§5.3/§7.1 等）。
2. **TDD（t-wada）**: 決定的ロジックは失敗テスト先行 → 実装 → リファクタ。ガードレール厳守（抽出/スコアリング分離・unknown 中立・ラベル正規化）。test-driven-development skill に従う。
3. **オフライン検証**: vitest / tsc / biome / `wrangler` dry-run など、secrets なしで可能な検証を全実行。
4. **PR 作成**: `/pr create`。live な Workers AI/secrets 検証が要る部分は **Draft PR** とし、本文と報告に「要手動検証」を明記。
5. **自己レビュー修正ループ**: `/code-review`（plain）→ 指摘を自律修正、**最大 2 回**。残件は報告にエスカレ。
6. **受け入れ確認**: Issue の受け入れ条件を 1 件ずつ確認し、充足／要手動検証を記録。
7. **報告**: 上記スキーマで orchestrator へ返す。

**禁止事項**: merge / main への push / ブランチ・worktree 削除はしない。自分の feature ブランチの push のみ。`.dev.vars` 等の秘匿ファイルに触れない（hook が deny）。

## 状態管理・冪等性

- **status ラベル**: `status:in-progress` / `status:in-review` / `status:blocked`。merged で close。
- **親 #44 body**: issue ごとの PR 番号・状態の表と、申し送りの追記を集約（Wave/着手順の一次ソースは親 body）。
- **再実行安全**: merged(closed) はスキップ、open PR は段階判定して再開。orchestrator 中断後も状態から復旧可能。

## エラー処理・failure isolation

- subagent 失敗（テストが通らない・依存不足等）→ `status:blocked`＋理由を報告。**同じ ready-set の兄弟をブロックしない**。
- merge ゲートは `/pr merge` の内部ゲート（CI green＋全レビュー解決＋ユーザー承認）に委譲。1 つでも欠ければ当該 PR を merge せず理由報告。
- 同時実行 cap でディスク／トークンを制御。未変更 worktree は自動削除。

## spike（本格運用前の必須先行検証）

未確認の前提を、**最も安全な #10（求人スキーマ定義：secrets 不要・オフライン検証可・他への波及小）** 1 件の dry-run で潰す。

検証項目と分岐:

1. **subagent からの skill 呼び出し**: Agent サブエージェントが Skill ツール経由で `/pr`・`/code-review` を呼べるか。
   - 不可の場合のフォールバック → subagent は **inline `gh pr create`** と **手動レビューパス**（diff を自己レビューし修正）を実行。skill に両経路を用意する。
2. **worktree 分離＋background 通知**: `isolation:"worktree"` ＋ `run_in_background` で起動した subagent の完了通知・状態取得がオーケストレーションとして成立するか。node_modules は `symlinkDirectories` で共有される前提を確認。
3. **push 権限**: subagent からの feature ブランチ push が permission でどう扱われるか（プロンプト発生／継承）。

**spike の合格条件**: #10 で「実装→Draft でない通常 PR→`/code-review` 1 ループ→受け入れ確認→orchestrator が mergeable と認識」まで通り、上記 1〜3 の挙動が判明していること。spike 結果に応じて本実装のフォールバック分岐を確定する。

## 既存資産との関係

- **issue-tracker**: 親 Issue／sub-issues／Wave／申し送りの解析と body 更新を再利用。
- **`/pr`（pr-lifecycle）**: PR の create/review/merge/postmerge。merge ゲート（ユーザー承認必須）と「明示指示なしにブランチ・worktree を削除しない」方針に整合。cleanup は wave-rider が明示的に駆動する。
- **`/code-review`（plain）**: subagent の自己レビュー。`ultra`（クラウド・課金・ユーザー起動専用）は使わない。
- **dispatching-parallel-agents / subagent-driven-development**: 並列 subagent 運用の下敷き。

## 段階導入（YAGNI）

最初から全自動を作り込まない。

1. **Phase A（spike）**: #10 1 件で dry-run、未確認点を確定。
2. **Phase B（最小 orchestrator）**: 単一 ready-set の逐次〜小並列 dispatch、報告集約、merge 人間ゲート、cleanup。
3. **Phase C（拡張）**: ready-set トポロジ駆動の自動前進、status ラベル運用、冪等再開を本格化。

Phase B 完了時点で 1〜2 件を end-to-end で回し、残りを wave-rider で回すか手動かを判断する。

## 検証（skill 完成時）

- `/wave-rider #44` で親と sub-issues が正しく解析され、ready-set と Wave が提示されること。
- spike: #10 で PR 作成 → `/code-review` ループ → mergeable 報告まで通ること。
- merge 人間ゲートが必ず挟まり、未承認で merge されないこと。
- merge 後に worktree＋local/remote ブランチが削除され、Issue が close されること。
- secrets 依存 issue が Draft＋「要手動検証」でエスカレされること。
- 再実行で merged issue がスキップされ、open PR が再開されること。
- 秘匿ファイルに触れていないこと（hook deny を踏まない）。

## 未解決・要検証

- spike 1〜3 の挙動（skill 呼び出し可否・background 通知・push 権限）は spike 完了まで未確定。本実装はフォールバック経路を必ず持つ。
