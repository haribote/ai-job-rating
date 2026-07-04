-- 企業軸（企業規模・資本金）を既定スコア項目として seed する。
-- 0004 は companySize/capital を意図的に除外していたため、企業軸はスコア項目ゼロで常に
-- unknown（—）に落ちていた。抽出済みの companySize/capital を採点へ接続する。
--
-- 設計の要点（なぜこの形か・0004 と同方針）:
-- - 既存 migration（0004）は書き換えず、新 migration で追加する。0004 は ON CONFLICT DO NOTHING で
--   一度適用済みの D1（既存フォーク先）へは再適用されないため、企業項目は別 migration でしか届かない。
-- - DEFAULT_SCORING_CONFIG（score.ts）の companySize/capital と値を厳密同期させること。ずれると
--   seed-default-criteria.test.ts（全 migration 適用後に buildScoringConfig と一致）が落ちる。
-- - direction（higherBetter）は NORMALIZED_KEY_KINDS（criteria-config.ts）が持つため desired_value は
--   希望値と floor のみ。方向・値は「大きいほど良い」を既定にした暫定で、設定UIから調整できる。
-- - ON CONFLICT(criterion) DO NOTHING で冪等にし、ユーザーが保存済みの行は上書きしない。

INSERT INTO criteria_config (criterion, desired_value, weight, hard_filter) VALUES
  ('companySize', '{"desired":1000,"floor":50}',      2, 'none'),
  ('capital',     '{"desired":10000,"floor":1000}',   2, 'none')
ON CONFLICT(criterion) DO NOTHING;
