CREATE TABLE IF NOT EXISTS owner_capital_settings (
  owner_id TEXT PRIMARY KEY,
  total_amount REAL NOT NULL CHECK (total_amount > 0 AND total_amount <= 1000000000),
  currency TEXT NOT NULL DEFAULT 'USDT' CHECK (currency = 'USDT'),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_simulation_wallets (
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('hyperliquid', 'binance', 'okx')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  balance REAL NOT NULL DEFAULT 1000 CHECK (balance >= 0),
  active_trade TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, client_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_owner_simulation_wallets_updated_at
  ON owner_simulation_wallets(updated_at);

CREATE TABLE IF NOT EXISTS archived_news (
  fingerprint TEXT PRIMARY KEY,
  archive_date TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TEXT NOT NULL,
  impact INTEGER NOT NULL,
  assets TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL,
  analysis TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_news_date
  ON archived_news(archive_date, published_at DESC);
