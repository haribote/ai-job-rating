-- Phase 2 企業評判の基盤: 評判スナップショットと取得元設定（要件 §6 §197-198 / §7.2 / #33）。
--
-- 設計の要点（なぜこの形か）:
-- - 評判は求人単位でなく企業単位の属性（§7.2）。companies.id を企業キーに紐付け、同一企業の全求人で
--   再利用できるよう企業単位でキャッシュする（#32 の名寄せ済み companies に依存・migration 0002）。
-- - reputation_snapshots は append-only の履歴（extractions と同じ流儀）。最新を fetched_at で引く。
--   再取得しても過去スナップショットを破壊しないため監査・再現性に資する（§8）。
-- - unknown 中立（§5.2）: 「未取得（行が無い）」と「取得したが該当スコア無し（overall_score IS NULL）」を
--   区別できるよう overall_score / review_count / sub_scores_json を NULL 許容にする。後者は negative cache
--   として機能し、直近確認済みの企業を Claude API へ再問い合わせしない判断材料になる（#30）。スコア層（#36）は
--   値が NULL の項目を加重合計の分母から外す。
-- - source は口コミサイト名や "web_search" 等の取得元識別子（§6）。reputation_sources への hard FK は張らない。
--   設定（sources）が編集・削除されても過去スナップショットの取得元表記を保つため、ソフトな参照にする。
-- - review_count は件数による信頼度減衰（少件数の高評価が支配しない・§7.2）にスコア層が使う。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- reputation_snapshots: 企業 1 件・取得元 1 つの評判スナップショット（企業単位キャッシュ・append-only）。
-- ---------------------------------------------------------------------------
CREATE TABLE reputation_snapshots (
  id TEXT PRIMARY KEY,
  -- 企業参照。名寄せ済み companies.id（#32）。企業が消えればスナップショットも CASCADE 削除する。
  company_id TEXT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  -- 取得元識別子（口コミサイト名 / "web_search" 等・§6）。reputation_sources への soft 参照。
  source TEXT NOT NULL,
  -- 総合スコア。取得できなかった場合は NULL（unknown 中立で分母除外・§5.2）。スケールは取得元依存のため
  -- 正規化はスコア層（#36）が担う。
  overall_score REAL,
  -- 口コミ件数。信頼度減衰に使う（少件数の高評価が支配しない・§7.2）。不明は NULL。
  review_count INTEGER,
  -- サブ項目（成長/年収/残業 等）の JSON。スキーマは取得元依存のため文字列で保持し、解釈はスコア層（#36）が担う。
  -- 取得できなければ NULL。
  sub_scores_json TEXT,
  -- 取得時刻（企業単位キャッシュの鮮度判定に使う・unix 秒）。
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 企業単位キャッシュの読み出し経路: 企業（＋取得元）ごとの最新スナップショットを fetched_at 降順で引く。
CREATE INDEX idx_reputation_snapshots_company
  ON reputation_snapshots (company_id, source, fetched_at);

-- ---------------------------------------------------------------------------
-- reputation_sources: 対象口コミサイトの設定（設定画面で永続化・#34 が CRUD する・§6 §7.2）。
-- ---------------------------------------------------------------------------
CREATE TABLE reputation_sources (
  id TEXT PRIMARY KEY,
  -- 取得元の表示名（例: "OpenWork"）。設定の一意キーとする。
  name TEXT NOT NULL,
  -- base_url または識別子（§6）。web_search 主体の取得元は URL を持たないため NULL 可。
  identifier TEXT,
  -- 取得方式（§7.2）: web_search=Claude API 検索（主軸） / url_html=URL/HTML 投入→AI 抽出（補助） /
  -- manual=スコア手入力（任意上書き）。
  fetch_method TEXT NOT NULL
    CHECK (fetch_method IN ('web_search', 'url_html', 'manual')),
  -- 優先順位（小さいほど優先・§7.2「対象サイト・優先順位を設定画面で永続化」）。
  priority INTEGER NOT NULL DEFAULT 0,
  -- 有効フラグ。SQLite に boolean 型が無いため 0/1 で持つ。無効化しても設定は残す。
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 取得元名で一意化する（同名の重複設定を禁止・upsert の照合キー）。
CREATE UNIQUE INDEX idx_reputation_sources_name ON reputation_sources (name);
