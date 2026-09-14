ALTER TABLE owner_simulation_wallets RENAME TO owner_simulation_wallets_legacy;

CREATE TABLE owner_simulation_wallets (
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('hyperliquid', 'binance', 'okx')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  balance REAL NOT NULL DEFAULT 1000 CHECK (ABS(balance) <= 1000000000),
  active_trade TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, client_id, platform)
);

INSERT INTO owner_simulation_wallets (
  owner_id, client_id, platform, enabled, balance, active_trade, history, updated_at, revision
)
SELECT owner_id, client_id, platform, enabled, balance, active_trade, history, updated_at, 0
FROM owner_simulation_wallets_legacy;

DROP TABLE owner_simulation_wallets_legacy;

CREATE INDEX idx_owner_simulation_wallets_updated_at
  ON owner_simulation_wallets(updated_at);

CREATE TABLE simulation_executor_state (
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('hyperliquid', 'binance', 'okx')),
  last_run_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, client_id, platform)
);

CREATE TABLE simulation_trade_events (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('hyperliquid', 'binance', 'okx')),
  trade_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'first_target', 'closed')),
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_simulation_trade_events_scope
  ON simulation_trade_events(owner_id, client_id, platform, occurred_at DESC);
