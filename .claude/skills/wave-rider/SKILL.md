---
name: wave-rider
description: "トラッキング親 Issue (#NN) を渡すと、sub-issue 単位で worktree 分離の dev サブエージェントを起動し自律開発をオーケストレーションする。各 subagent は TDD 開発→オフライン検証→/pr create→/code-review 自己修正→受け入れ確認→報告まで自律実行。orchestrator は依存トポロジで着手可能な issue を並列 dispatch、merge は人間ゲート、承認後に merge と worktree・ブランチ削除を自動化する。親 Issue 起点で開発に着手したい・複数 issue を並列で回したい場面で発動する。"
user-invocable: true
---

# wave-rider — 親 Issue 起点の自律開発オーケストレーション

トラッキング親 Issue にぶら下がる sub-issue 群を、依存順に dev サブエージェントへ振り分けて自律開発を回すプレイブック。設計の単一 source of truth は [docs/superpowers/specs/2026-06-20-wave-rider-design.md](../../../docs/superpowers/specs/2026-06-20-wave-rider-design.md)。親 Issue の構築は [issue-tracker](../issue-tracker/SKILL.md) で行う。

呼び出し: `/wave-rider #NN`（親 Issue 番号）。任意で Wave / sub-issue の絞り込みを引数で受ける。

## 役割分担

- **orchestrator**（あなた＝メインエージェント）: 解析・dispatch・報告集約・**merge 人間ゲート**・merge・cleanup・前進。
- **dev subagent**（worktree 分離・background、issue ごとに 1）: 開発〜PR〜自己レビュー〜受け入れ確認〜報告。merge・main への push・削除はしない。
- **状態の source of truth**: GitHub（親 Issue body の PR 表＋申し送り、sub-issue の `status:*` ラベル）。orchestrator が落ちても状態から再開できる。

## 前提・ガードレール（厳守）

- **merge は必ず人間ゲート**。`/pr merge` の内部ゲート（CI green＋全レビュー解決＋ユーザー承認）を通す。未承認で merge しない。
- **push は無確認で通る**（プローブ確認済み）。dev subagent には「自分の feature ブランチ以外へ push しない／`main` へ push しない」を必ず明示し、ブランチ名を orchestrator が制御する。
- **秘匿ファイル（`.dev.vars` 等）に触れない**（hook が deny）。live な Workers AI/secrets 検証が要る部分は Draft PR でエスカレ。
- **TDD（t-wada）**・決定的ロジックのユニットテスト必須・設計ガードレール（抽出/スコアリング分離・unknown 中立・ラベル正規化）を subagent に継承させる。

## 手順

### 0. 準備（初回のみ）

`status:*` ラベルが無ければ作成する。

```bash
for s in in-progress in-review blocked; do
  gh label create "status:$s" --color BFD4F2 -f >/dev/null 2>&1 || true
done
```

### 1. 解析

親 Issue の body と sub-issues を読み、Wave／依存／申し送りを抽出する（issue-tracker の構造）。

```bash
gh issue view <NN> --json title,body,milestone
gh api repos/{owner}/{repo}/issues/<NN>/sub_issues --jq '.[] | {number,title,state,labels:[.labels[].name]}'
```

- Wave 構成・着手順・申し送りは**親 body を一次ソース**とする（sub-issues は順序情報を持たない）。

### 2. ready-set 算出

- 「依存する sub-issue が全て **merged（closed）**」の issue を着手可とする（依存トポロジ駆動。Wave は人間向けの可読グループ）。
- `state=closed` はスキップ。open PR を持つ issue は途中段階から**再開**（冪等）。`status:blocked` は理由を確認してから再投入。
- 着手可 issue が無ければ、ブロック要因（未 merge の依存）を報告して停止。

### 3. dispatch（並列・worktree 分離・background）

ready-set の各 issue に対し、**同時実行 cap = 3**（既定）で dev subagent を起動する。Agent ツールを `isolation: "worktree"`・`run_in_background: true` で使い、下記「dev subagent プロンプト雛形」を渡す。dispatch 直後に当該 issue を `status:in-progress` にする。

### 4. 報告集約

各 subagent の完了通知（報告スキーマ）を受け、

- 親 Issue body の PR 表（issue・PR#・state・受け入れ）を更新、申し送りを追記。
- ラベル更新: PR 作成済み→`status:in-review`、ブロック→`status:blocked`。
- `state=blocked` は理由を記録し、**同 ready-set の兄弟をブロックしない**。

### 5. merge 人間ゲート

`state=mergeable` の PR を一括でユーザーに提示し、承認を得る（AskUserQuestion 等）。承認された PR のみ `/pr merge` する（方式はリポジトリ設定／履歴から判定、不明ならユーザー確認）。Draft / blocked は merge 対象外。

### 6. cleanup（merge 成功後・自動）

`gh pr view <PR> --json state` が `MERGED` であることを確認してから、当該 issue のぶんだけ:

```bash
git worktree remove --force <worktree-path>
git branch -D <branch>
git push origin --delete <branch>
```

受け入れ条件を満たしていれば Issue を close（sub-issue は親の進捗バーに反映）。`main` を `git switch main && git pull` で最新化。

### 7. 前進

ready-set を再算出し、新たに着手可になった issue があれば 3. へ戻る。全 sub-issue が closed になるか、着手可が尽きたら、残課題（blocked・要手動検証の Draft）を要約して終了。

## dev subagent プロンプト雛形

各 issue の dispatch 時に、`<...>` を埋めて渡す。

```text
あなたは wave-rider の dev サブエージェントです。担当 sub-issue を 1 件、自分の隔離 worktree 内で自律開発します。

担当: #<N> "<title>"
親 Issue: #<NN>（関連する申し送り: <該当の申し送りを転記>）
参照すべき docs: <例: docs/requirements.md §5.2/§5.3, docs/roadmap.md>

## ガードレール（厳守）
- t-wada の TDD（Red→Green→Refactor）。決定的ロジックはユニットテスト必須。
- 設計ガードレール: 抽出とスコアリングの分離 / unknown は中立（分母から除外）/ ラベル正規化。
- 秘匿ファイル（.dev.vars 等）に触れない。
- 自分の feature ブランチ以外へ push しない。main へ push しない。merge しない。ブランチ・worktree を削除しない。

## 手順
1. sub-issue 本文・申し送り・docs 該当節を読み、受け入れ条件を洗い出す。
2. TDD で実装。失敗テスト先行→実装→リファクタ。
3. オフライン検証を全実行: vitest / tsc / biome / wrangler dry-run など secrets 不要のもの。
4. `/pr create` skill で PR を作成（commit 規約は /commit に従う、AI co-author 不含）。
   - live な Workers AI / secrets 検証が必要な部分が残る場合は **Draft PR** とし、PR 本文と報告に「要手動検証」を明記する。
5. `/code-review`（plain。ultra は使わない）で自己レビュー → 指摘を自律修正。**最大 2 回**。残件は報告にエスカレ。
6. 受け入れ条件を 1 件ずつ確認し、充足 / 未充足 / 要手動検証を記録。

## 最終メッセージ（これがあなたの戻り値）= 報告スキーマ
- issue: "#<N>"
- pr: "#<M>"（未作成なら none）
- state: "mergeable" | "draft" | "blocked"
- acceptance: [{ 条件, 充足: true|false|"要手動検証" }]
- handoff: "後続 issue への申し送り（あれば）"
- notes: "blocked の理由・残レビュー指摘など"
```

## エラー処理・冪等性

- subagent 失敗（テスト通らない・依存不足）→ `status:blocked`＋理由を親 body に記録。兄弟はブロックしない。
- 再実行時: closed はスキップ、open PR は段階判定して再開。orchestrator 中断後も GitHub の状態から復旧する。
- 同時実行 cap でディスク／トークンを制御。未変更 worktree は自動削除される。

## 段階導入（spec の Phase B→C）

最初から全自動を作り込まない。単一 ready-set の逐次〜小並列 dispatch → 報告集約 → merge 人間ゲート → cleanup を回し、1〜2 件を end-to-end で確認してから ready-set トポロジ自動前進・冪等再開を本格化する。

## 参照

- 設計仕様: [docs/superpowers/specs/2026-06-20-wave-rider-design.md](../../../docs/superpowers/specs/2026-06-20-wave-rider-design.md)
- 親 Issue 構築: [issue-tracker](../issue-tracker/SKILL.md)
- PR ライフサイクル: `/pr`（create / review / merge / postmerge、ゲート付き）
- 自己レビュー: `/code-review`（plain）
