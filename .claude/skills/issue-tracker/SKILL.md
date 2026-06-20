---
name: issue-tracker
description: "マイルストーン内 Issue の優先順位・依存関係を整理し Wave 単位の着手順を確定、トラッキング親 Issue を作成して既存 Issue を GitHub native sub-issues として紐付け、Sub-issue 間の申し送り事項を親 body に集約する。Issue の整理・優先順位付け・親子関係構築・フェーズ着手計画の場面で発動する。"
user-invocable: true
allowed-tools: "Bash(gh:*)"
---

# Issue ハンドリング（着手順整理 + トラッキング親 Issue 化）

指定マイルストーンの Issue 群を整理し、着手順を Wave で確定して、トラッキング親 Issue に native sub-issues としてぶら下げる手順。Phase 0/1/2 のいずれでも同じ手順で実行する。

## 入力

対象マイルストーン名（例: `Phase 0 — PoC`）。表記ゆれ（`—` em dash）に注意。

## 手順

### 1. 対象 Issue を収集・分析

1. マイルストーンの正確な title/number を取得する。
   - `gh api repos/<owner>/<repo>/milestones --jq '.[] | {number,title}'`
2. 該当 Issue を一覧化し、各 Issue の body / labels / 相互参照（`#N`, "depends on", "blocked by"）を収集する。
3. body・labels・設計ドキュメント（`docs/`）から **依存関係** を読み取る。明示的依存がなくても、責務分離（取得→抽出→スコアリング→保存→UI）と設計原則から自然な依存を推定する。

### 2. Wave 構成を確定

- 依存の深さで Issue を **Wave** にグルーピングする。**表記は "Wave" で固定（「波」と訳さない）。**
- 同一 Wave の Issue は前 Wave 完了後に並行着手可（worktree 並列化）とする。
- 前倒し可能な設計タスク・独立タスクは注記する。

### 3. 親 Issue を作成（マイルストーンを確実に付与）

1. 下記テンプレートで body を用意する。
2. `gh issue create --milestone "<正確な title>" --title "[tracking] <マイルストーン> 着手順トラッキング" --body-file <file>`。
   - title 不一致でエラーになる場合は number 指定にフォールバック。
3. **作成直後に検証**: `gh issue view <親番号> --json milestone --jq .milestone.title` が対象マイルストーンを返すこと。未設定なら `gh issue edit <親番号> --milestone ...` で付与し再確認。

### 4. 既存 Issue を native sub-issues として紐付け

native sub-issues は **内部 id（`.id`、databaseId ではない）** で操作する。

1. 子 Issue の id を取得: `gh api repos/<owner>/<repo>/issues/<N> --jq '.id'`。
2. REST API で紐付け（gh 2.9x 以降）:
   `gh api -X POST repos/<owner>/<repo>/issues/<親番号>/sub_issues -F sub_issue_id=<子id>`
   - レスポンスの `.sub_issues_summary.total` で累計件数を確認する。
3. まず 1 件で疎通確認してから残りを流す。
4. REST が使えない場合は GraphQL にフォールバック:
   `addSubIssue(input:{issueId:<親nodeId>, subIssueId:<子nodeId>})`（node id は GraphQL で取得）。

### 5. 申し送り事項を親 body に集約

- Sub-issue 間で引き継ぐ決定事項・前提（確定スキーマ、保存結果の再利用、テスト担保事項など）を親 body の「申し送り事項」に記載する。
- **native sub-issues は順序情報を持たない**ため、Wave/着手順/申し送りは **親 body を一次ソース**とする。進行に応じて追記する。

## 親 Issue body テンプレート

```markdown
<マイルストーン> の着手順・依存関係・進捗を一元管理するトラッキング Issue。
着手順と Wave 構成・Sub-issue 間の申し送りは本 body を一次ソースとする。

## 目的 / スコープ
（DoD・設計原則ドキュメントへのポインタ）

## Wave 構成（着手順）
表記は Wave で固定（「波」と訳さない）。

| Wave | Issue | 内容 | 主な依存 |
|---|---|---|---|
| Wave 1 ... | #a → #b, #c | ... | ... |

### 着手順サマリ
`#a → (#b / #c) → ...`

## 申し送り事項（Sub-issue 間）
- #x → #y: ...

## 進捗
下部の sub-issues 進捗バーで自動可視化。
```

## 注意

- 秘匿ファイル（`.dev.vars` 等）には触れない。
- 着手順は依存からの推定。運用中に依存が判明したら親 body の申し送りに追記して調整する。
