-- One-time production repair for torudake-reel-db.
-- Preconditions:
--   1. d1_migrations exists and contains zero rows.
--   2. A clean database built from drizzle/0000..0019 has exactly the same
--      application table columns and index definitions as production.
--   3. A fresh Time Travel bookmark and full D1 export have been recorded.
-- Do not add this directory to migrations_dir. This statement only records
-- migrations whose schema effects were already applied to production.
INSERT INTO d1_migrations (name) VALUES
  ('0000_video_transfers.sql'),
  ('0001_billing_accounts.sql'),
  ('0002_caption_profiles.sql'),
  ('0003_ai_disclosure_confirmations.sql'),
  ('0004_operator_devices.sql'),
  ('0005_trial_sessions.sql'),
  ('0006_trial_issuance.sql'),
  ('0007_observed_usage_duration.sql'),
  ('0008_usage_operation_leases.sql'),
  ('0009_operation_success.sql'),
  ('0010_passkey_accounts.sql'),
  ('0011_refund_credit_revocation.sql'),
  ('0012_one_time_purchase_assignment.sql'),
  ('0013_windy_namorita.sql'),
  ('0014_known_multiple_man.sql'),
  ('0015_shocking_agent_zero.sql'),
  ('0016_elite_sphinx.sql'),
  ('0017_zippy_vermin.sql'),
  ('0018_steady_legion.sql'),
  ('0019_slim_alice.sql');
