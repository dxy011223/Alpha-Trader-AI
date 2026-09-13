CREATE TABLE IF NOT EXISTS auth_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_pairing_codes_expires_at
  ON auth_pairing_codes (expires_at);
