CREATE TABLE scheduled_job_leases (
  job_key TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_scheduled_job_leases_until
  ON scheduled_job_leases(lease_until);
