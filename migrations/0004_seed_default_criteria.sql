-- フォーク直後・設定未保存でも総合スコアが出るよう、既定スコアリング設定を criteria_config へ seed する（#198）。
--
-- 設計の要点（なぜこの形か）:
-- - buildScoringConfig は criteria_config が空なら {items:{}} を返し、scoreJob は weightTotal===0 で
--   必ず total=null を返す。DEFAULT_SCORING_CONFIG（score.ts）は既に存在するが実行時パスに接続されて
--   おらず、飾りになっていた。
-- - ON CONFLICT(criterion) DO NOTHING で冪等にする。既にユーザーが保存した行は上書きしない。
-- - DEFAULT_SCORING_CONFIG（score.ts）と値を同期させること。ずれると seed-default-criteria.test.ts が落ちる。
-- - benefitsCoverage/companySize/capital は DEFAULT_SCORING_CONFIG に含まれないため seed しない。

INSERT INTO criteria_config (criterion, desired_value, weight, hard_filter) VALUES
  ('annualSalary',   '{"desired":700,"floor":300}',        5, 'none'),
  ('bonus',          '{"desired":4,"floor":0}',             2, 'none'),
  ('overtime',       '{"desired":10,"ceil":45}',            3, 'none'),
  ('annualHolidays', '{"desired":125,"floor":105}',         2, 'none'),
  ('remoteWork',     '{"preferred":["full","partial"]}',    3, 'none'),
  ('flexWork',       '{"preferred":["flex"]}',              1, 'none'),
  ('skillMatch',     NULL,                                  4, 'none')
ON CONFLICT(criterion) DO NOTHING;
