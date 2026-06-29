-- Phase 2 企業評判の基盤: 企業の名寄せ（companies）テーブル（要件 §6 / §7.2 / #32）。
--
-- 設計の要点（なぜこの形か）:
-- - 求人ごとに揺れる企業表記を 1 企業へ寄せ、評判を企業単位でキャッシュできるようにする。
--   後続 #33（reputation_snapshots / reputation_sources）は companies.id を企業キーに紐付ける。
-- - company_key は決定的な名寄せキー（src/server/companies/normalize.ts#companyKey の出力）。
--   表記揺れ（前株/後株/(株)/㈱/全角/大小/空白/中黒）を吸収した一意化キーで UNIQUE 制約を張る。
-- - houjin_bangou（国税庁 法人番号・13桁）は取得できた場合のみ持つ最強の一意化シグナル。任意（NULL 可）。
-- - jobs.company_id は 0001 で予約済み。本マイグレーションで企業ルックアップ用インデックスを足す
--   （評判は企業単位で同一企業の全求人に再利用するため company_id 引きが要る・§7.2）。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- companies: 名寄せ済みの企業 1 件（表示名・名寄せキー・任意の法人番号）。
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  -- 表示用の企業名（最初に観測した生表記を NFKC 正規化したもの。UI 表示用）。
  name TEXT NOT NULL,
  -- 名寄せキー（決定的）。同一企業の表記揺れを一意化する。#33 がこのキー由来の企業へ評判を張る。
  company_key TEXT NOT NULL,
  -- 国税庁 法人番号（13桁・任意）。取得できた場合のみ。名寄せの最強シグナル。
  houjin_bangou TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 一意化は法人番号を最強シグナルとする（同名別法人＝同一 company_key でも法人番号が違えば別企業）。
-- - 法人番号が判明していればそれで一意化（同名別法人を確実に分離する）。NULL 行は対象外。
CREATE UNIQUE INDEX idx_companies_houjin
  ON companies (houjin_bangou) WHERE houjin_bangou IS NOT NULL;
-- - 法人番号が未判明の企業は名寄せキーで一意化する（partial: 判明済み行は houjin 側で分かれるため除外）。
CREATE UNIQUE INDEX idx_companies_key_unidentified
  ON companies (company_key) WHERE houjin_bangou IS NULL;

-- 名寄せキーからの一般検索用（非ユニーク。法人番号判明済み行も含めて引く）。
CREATE INDEX idx_companies_key ON companies (company_key);

-- 企業単位で所属求人を引くためのインデックス（評判の企業単位キャッシュ再利用・§7.2 / #33）。
CREATE INDEX idx_jobs_company ON jobs (company_id);
