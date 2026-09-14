ALTER TABLE owner_simulation_wallets
  ADD COLUMN auto_timeframe TEXT NOT NULL DEFAULT '4h'
  CHECK (auto_timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d'));

ALTER TABLE owner_simulation_wallets
  ADD COLUMN last_executor_run_id TEXT;

ALTER TABLE owner_simulation_wallets
  ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'ok'
  CHECK (integrity_status IN ('ok', 'gap', 'error'));

ALTER TABLE owner_simulation_wallets
  ADD COLUMN integrity_error TEXT;

ALTER TABLE simulation_executor_state
  ADD COLUMN lease_id TEXT;

ALTER TABLE simulation_executor_state
  ADD COLUMN lease_until INTEGER;

CREATE INDEX idx_simulation_trade_events_trade
  ON simulation_trade_events(owner_id, client_id, platform, trade_id, occurred_at DESC);
