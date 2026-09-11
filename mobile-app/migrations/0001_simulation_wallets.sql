CREATE TABLE IF NOT EXISTS simulation_wallets (
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('hyperliquid', 'binance', 'okx')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  balance REAL NOT NULL DEFAULT 1000 CHECK (balance >= 0),
  active_trade TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_simulation_wallets_updated_at
  ON simulation_wallets(updated_at);
