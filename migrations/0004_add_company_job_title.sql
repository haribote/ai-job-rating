-- 会社名・職種タイトルは表示専用（スコアリング非依存）。NormalizedJob/NormalizedKey には含めない
-- （抽出とスコアリングの分離・§5.3）。抽出できなければ NULL のまま（UI は sourceUrl へフォールバック）。
ALTER TABLE extractions ADD COLUMN company_name TEXT;
ALTER TABLE extractions ADD COLUMN job_title TEXT;
