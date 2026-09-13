CREATE TABLE IF NOT EXISTS owner_decision_plan_scans (
  owner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  scan_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, platform, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_owner_decision_plan_scans_updated_at
  ON owner_decision_plan_scans(updated_at);
