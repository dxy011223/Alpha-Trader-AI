import { describe, expect, it } from "vitest";

import type { AnalysisResponse } from "./alphaApi";
import {
  DEFAULT_SIMULATION_BALANCE,
  closeSimulatedTradeIfTriggered,
  createDefaultSimulationWallet,
  restoreSimulationWalletBook,
  openSimulatedTrade,
  updateSimulatedTrade,
} from "./simulationTrading";

function analysis(direction: "LONG" | "SHORT"): AnalysisResponse {
  return {
    symbol: "BTC",
    instrument: "BTC-PERP",
    direction,
    confidence: 80,
    score: 82,
    score_breakdown: { trend: 20, structure: 20, capital: 16, macro: 14, news: 12 },
    entry_range: [100, 100],
    stop_loss: direction === "LONG" ? 90 : 110,
    take_profit: direction === "LONG" ? [120, 130] : [80, 70],
    leverage: 2,
    risk: "medium",
    position_sizing: {
      risk_budget_rate: 0.01,
      risk_budget_amount: 10,
      stop_distance_rate: 0.1,
      margin_amount: 200,
      position_value: 400,
      max_loss_amount: 40,
      margin_cap_rate: 0.3,
      capped: false,
    },
    reasons: ["测试决策"],
    disclaimer: "测试",
    source: "live",
    analysis_engine: "rules",
    analysis_model: null,
    platform: "hyperliquid",
  };
}

describe("模拟交易", () => {
  it("默认创建 1000 USDC 钱包", () => {
    expect(createDefaultSimulationWallet()).toMatchObject({
      enabled: false,
      balance: DEFAULT_SIMULATION_BALANCE,
      activeTrades: [],
      history: [],
    });
  });

  it("按平台恢复独立钱包并兼容旧版单钱包", () => {
    const legacyTrade = openSimulatedTrade({
      ...analysis("LONG"),
      platform: "binance",
    }, "1h", 875, 1);
    const legacy = JSON.stringify({ enabled: true, balance: 875, activeTrade: legacyTrade, history: [] });
    const wallets = restoreSimulationWalletBook(null, legacy, "binance");

    expect(wallets.binance).toMatchObject({ enabled: true, balance: 875 });
    expect(wallets.binance.activeTrades).toHaveLength(1);
    expect(wallets.binance.activeTrades[0].analysis.platform).toBe("binance");
    expect(wallets.hyperliquid).toMatchObject({ enabled: false, balance: DEFAULT_SIMULATION_BALANCE });
    expect(wallets.okx).toMatchObject({ enabled: false, balance: DEFAULT_SIMULATION_BALANCE });
  });

  it("开仓保证金不超过钱包余额", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "1h", 100, 1);
    expect(trade.allocatedAmount).toBe(100);
    expect(trade.size).toBe(2);
  });

  it("多单触发止盈并计算盈利", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "1h", 1_000, 1);
    const completed = closeSimulatedTradeIfTriggered(trade, 121, 2);
    expect(completed).toMatchObject({ exit_reason: "take_profit", exit_price: 120, net_pnl: 80 });
  });

  it("空单触发止损并计算亏损", () => {
    const trade = openSimulatedTrade(analysis("SHORT"), "1h", 1_000, 1);
    const completed = closeSimulatedTradeIfTriggered(trade, 111, 2);
    expect(completed).toMatchObject({ exit_reason: "stop_loss", exit_price: 110, net_pnl: -40 });
  });

  it("未触发止盈止损时只更新浮动盈亏", () => {
    const trade = openSimulatedTrade(analysis("SHORT"), "1h", 1_000, 1);
    expect(closeSimulatedTradeIfTriggered(trade, 95, 2)).toBeNull();
    expect(updateSimulatedTrade(trade, 95).unrealizedPnl).toBe(20);
  });
});
