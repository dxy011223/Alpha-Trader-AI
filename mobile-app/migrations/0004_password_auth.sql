CREATE TABLE IF NOT EXISTS owner_password_credentials (
  owner_id TEXT PRIMARY KEY,
  username_normalized TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  failed_window_started_at INTEGER,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_password_credentials_username
  ON owner_password_credentials(username_normalized);

CREATE TABLE IF NOT EXISTS auth_login_rate_limits (
  client_hash TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  failed_window_started_at INTEGER,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_login_rate_limits_updated_at
  ON auth_login_rate_limits(updated_at);
