-- Phase 1 MVP の D1 スキーマ初期化（要件 §6 データモデル / §5.2 unknown 中立 / §5.3 抽出とスコアリングの分離）。
--
-- 設計の要点（なぜこの形か）:
-- - 抽出（extractions）とスコアリング（scores / criteria_config）を別テーブルに分離する。
--   希望値・重みの変更で再スコアリングのみ走り、AI 抽出は再実行しない（§5.3 / #20）。
-- - extractions は機構識別列 mechanism と extraction_status を必ず持つ。後者が無いと
--   #20 が抽出失敗を unknown 中立と誤認するため（#65 確定方針）。
-- - 生 HTML は R2 に置き、extractions ではなく jobs から R2 オブジェクトキーで参照する（#16→#17）。
-- - unknown 中立はアプリ層の責務。DB は構造化 JSON をそのまま保持し、分母除外はスコアリングが行う。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- jobs: 取得した求人 1 件（取得元 URL・種別・状態・生 HTML 参照）。
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  -- 取得元 URL。同一 URL の重複投入を抑止する（PoC の単一詳細 URL から MVP の一覧展開まで）。
  source_url TEXT NOT NULL,
  -- 取得経路。detail=詳細ページ / listing=一覧ページ / paste=本文貼り付け（§6）。
  source_type TEXT NOT NULL CHECK (source_type IN ('detail', 'listing', 'paste')),
  -- パイプライン状態。fetched→extracted→scored の単調進行、失敗は failed（§6）。
  status TEXT NOT NULL DEFAULT 'fetched'
    CHECK (status IN ('fetched', 'extracted', 'scored', 'failed')),
  -- 生 HTML(R2) への参照キー（#16→#17）。未取得・paste 経路では NULL。
  raw_html_r2_key TEXT,
  -- 企業参照（Phase 2 の companies 名寄せ用に予約）。Phase 1 では NULL のまま。
  company_id TEXT,
  fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source_url)
);

-- ---------------------------------------------------------------------------
-- extractions: 求人 1 件に対する AI 抽出結果（1 回・保存して再利用、§5.3）。
-- ---------------------------------------------------------------------------
CREATE TABLE extractions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  -- 正規化済み構造化 JSON（NormalizedJob 構造）。スコアリングはこれを読む（#16→#20）。
  structured_json TEXT NOT NULL,
  -- 抽出に用いた AI モデル ID（監査・再現性、§8）。
  model TEXT NOT NULL,
  -- 構造化機構の識別子。差し替え可能なアダプタを区別する（#65: json-mode 等）。
  mechanism TEXT NOT NULL,
  -- 抽出の結果状態。failed/partial を unknown 中立と区別する（#65 必須・#20 が参照）。
  extraction_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (extraction_status IN ('ok', 'partial', 'failed')),
  -- 任意: 機構の生フィールド出力（検証→修復→正規化レイヤの監査用）。
  raw_fields TEXT,
  -- 任意: コード側修復レイヤが補正を行ったか（§品質保証レイヤ、0/1）。
  repaired INTEGER NOT NULL DEFAULT 0 CHECK (repaired IN (0, 1)),
  -- 任意: structured_json のスキーマ版。NormalizedJob 構造の互換管理用。
  schema_version INTEGER NOT NULL DEFAULT 1,
  extracted_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 求人ごとの最新抽出を引くためのインデックス（#20 再ランキングの読み出し経路）。
CREATE INDEX idx_extractions_job ON extractions (job_id, extracted_at);

-- ---------------------------------------------------------------------------
-- criteria_config: ユーザー設定の評価項目（希望値・重み・ハードフィルタ）。
-- 変更で再スコアリングのみ走り、AI 抽出は再実行しない（§5.3 / #16→#20）。シングルユーザー前提。
-- ---------------------------------------------------------------------------
CREATE TABLE criteria_config (
  -- 正規キー（NormalizedKey）。スコアリングは正規キーのみ参照する（§5.2 ラベル正規化）。
  criterion TEXT PRIMARY KEY,
  -- 希望値。kind により意味が異なるため JSON で持つ（numericRange の desired/floor 等・categorical の preferred 集合）。
  desired_value TEXT,
  -- 加重平均の重み（§5.2）。0 以上。
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  -- ハードフィルタ。required=必須 / exclude=除外 / none=スコアのみ（§6）。
  hard_filter TEXT NOT NULL DEFAULT 'none'
    CHECK (hard_filter IN ('none', 'required', 'exclude')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- scores: スコアリング結果のキャッシュ（決定的・AI 非依存、§5.3 / §8）。
-- criterion='__total__' の行に総合スコアをキャッシュ。各正規キー行にサブスコアを保持。
-- unknown 中立で分母から外れた項目は included=0 / sub_score NULL で表す（§5.2）。
-- ---------------------------------------------------------------------------
CREATE TABLE scores (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  -- 正規キー、または総合スコア行を表す予約値 '__total__'。
  criterion TEXT NOT NULL,
  -- サブスコア（0..1）。算出不能（unknown・kind 不一致）は NULL（分母から除外、§5.2）。
  sub_score REAL,
  -- スコアリングに採用されたか（included=0 は分母から除外、§5.2）。
  included INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0, 1)),
  -- 重み（criteria_config からのコピー。再現性のためスナップショットとして保持）。
  weight REAL,
  scored_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (job_id, criterion)
);

-- 一覧（ランキング）表示用に総合スコアを引くインデックス（#18 / #19）。
CREATE INDEX idx_scores_total ON scores (criterion, sub_score);
