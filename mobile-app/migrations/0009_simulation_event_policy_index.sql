-- 历史策略按所有客户端的关闭事件聚合，补充对应索引以控制长期查询成本。
CREATE INDEX IF NOT EXISTS idx_simulation_trade_events_policy
  ON simulation_trade_events(owner_id, event_type, occurred_at DESC);
