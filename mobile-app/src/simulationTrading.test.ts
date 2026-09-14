import { describe, expect, it } from "vitest";

import type { AnalysisResponse } from "./alphaApi";
import {
  DEFAULT_SIMULATION_BALANCE,
  SIMULATION_FIRST_TARGET_CLOSE_RATE,
  SIMULATION_FUNDING_PERIOD_MS,
  SIMULATION_SLIPPAGE_RATE,
  buildSimulationSignalKey,
  createDefaultSimulationWallet,
  restoreSimulationWalletBook,
  restoreSimulationWallet,
  openSimulatedTrade,
  processSimulatedCandles,
  processSimulatedTrade,
  updateSimulatedTrade,
} from "./simulationTrading";

function analysis(direction: "LONG" | "SHORT", fundingRate = 0): AnalysisResponse {
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
    funding_rate: fundingRate,
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

  it("恢复旧仓位时补齐成交成本与分批止盈状态", () => {
    const legacyTrade = openSimulatedTrade(analysis("LONG"), "4h", 1_000, 1) as unknown as Record<string, unknown>;
    for (const key of [
      "initialSize", "entryFee", "realizedGrossPnl", "realizedExitFee", "firstTargetHit",
      "effectiveStopLoss", "fundingRatePercent", "fundingAccrued", "lastFundingAt",
    ]) delete legacyTrade[key];

    const wallet = restoreSimulationWallet(JSON.stringify({
      enabled: true,
      balance: 1_000,
      activeTrades: [legacyTrade],
      history: [],
    }));

    expect(wallet.activeTrades[0]).toMatchObject({
      entryFee: 0,
      realizedGrossPnl: 0,
      realizedExitFee: 0,
      firstTargetHit: false,
      effectiveStopLoss: 90,
      fundingAccrued: 0,
      lastFundingAt: 1,
      lastProcessedCandleCloseTime: 1,
    });
    expect(wallet.activeTrades[0].initialSize).toBe(wallet.activeTrades[0].size);
  });

  it("模拟开仓不受钱包余额限制，并计入不利滑点与手续费", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "1h", 100, 1);
    expect(trade.allocatedAmount).toBe(200);
    expect(trade.entryPrice).toBeCloseTo(100 * (1 + SIMULATION_SLIPPAGE_RATE));
    expect(trade.entryPrice * trade.size).toBeCloseTo(400);
    expect(trade.entryFee).toBeCloseTo(0.2);
    expect(trade.unrealizedPnl).toBeCloseTo(-0.2);
  });

  it("使用入场区间内的实际触发价成交，区间外拒绝开仓", () => {
    const executable = {
      ...analysis("LONG"),
      entry_range: [100, 104],
      current_price: 103,
    };
    const trade = openSimulatedTrade(executable, "1h", 1_000, 1);

    expect(trade.plannedEntryPrice).toBe(102);
    expect(trade.triggerPrice).toBe(103);
    expect(trade.entryPrice).toBeCloseTo(103 * (1 + SIMULATION_SLIPPAGE_RATE));
    expect(() => openSimulatedTrade({ ...executable, current_price: 105 }, "1h", 1_000, 2))
      .toThrow("当前价格尚未进入决策入场区间");
  });

  it("按计划和修订版本生成稳定信号键", () => {
    const original = { ...analysis("LONG"), plan_id: "plan-1", decision_revision: 1 };
    const revised = { ...original, decision_revision: 2 };

    expect(buildSimulationSignalKey(original, "4h"))
      .toBe(buildSimulationSignalKey({ ...original }, "4h"));
    expect(buildSimulationSignalKey(revised, "4h"))
      .not.toBe(buildSimulationSignalKey(original, "4h"));
    expect(buildSimulationSignalKey(original, "1h"))
      .not.toBe(buildSimulationSignalKey(original, "4h"));
  });

  it("累计亏损后的负净值可以恢复用于复盘", () => {
    const wallet = restoreSimulationWallet(JSON.stringify({
      enabled: true,
      balance: -125.5,
      activeTrades: [],
      history: [],
    }));

    expect(wallet.balance).toBe(-125.5);
  });

  it("TP1 仅平一半，TP2 才完成交易", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "1h", 1_000, 1);
    const firstTarget = processSimulatedTrade(trade, 121, 2);

    expect(firstTarget.completedTrade).toBeNull();
    expect(firstTarget.activeTrade?.firstTargetHit).toBe(true);
    expect(firstTarget.activeTrade?.size).toBeCloseTo(
      trade.size * (1 - SIMULATION_FIRST_TARGET_CLOSE_RATE),
    );
    expect(firstTarget.activeTrade?.effectiveStopLoss).toBe(trade.entryPrice);

    const secondTarget = processSimulatedTrade(firstTarget.activeTrade!, 131, 3);
    expect(secondTarget.activeTrade).toBeNull();
    expect(secondTarget.completedTrade).toMatchObject({
      exit_reason: "take_profit",
      first_target_hit: true,
      slippage_rate: SIMULATION_SLIPPAGE_RATE,
    });
    expect(secondTarget.completedTrade!.exit_price).toBeLessThan(130);
    expect(secondTarget.completedTrade!.fee).toBeGreaterThan(0);
    expect(secondTarget.completedTrade!.net_pnl).toBeLessThan(secondTarget.completedTrade!.gross_pnl);
  });

  it("TP1 后回撤按保本止损结束剩余仓位", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "1h", 1_000, 1);
    const firstTarget = processSimulatedTrade(trade, 121, 2).activeTrade!;
    const completed = processSimulatedTrade(firstTarget, firstTarget.entryPrice, 3).completedTrade!;

    expect(completed.exit_reason).toBe("stop_loss");
    expect(completed.first_target_hit).toBe(true);
    expect(completed.net_pnl).toBeGreaterThan(0);
  });

  it("空单止损包含不利滑点和双边手续费", () => {
    const trade = openSimulatedTrade(analysis("SHORT"), "1h", 1_000, 1);
    const completed = processSimulatedTrade(trade, 111, 2).completedTrade!;

    expect(completed.exit_reason).toBe("stop_loss");
    expect(completed.exit_price).toBeGreaterThan(110);
    expect(completed.fee).toBeGreaterThan(0);
    expect(completed.net_pnl).toBeLessThan(completed.gross_pnl);
  });

  it("用完整 1 分钟 K 线补偿轮询期间遗漏的 TP1", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "4h", 1_000, 60_000);
    const result = processSimulatedCandles(trade, [{
      open_time: 60_000,
      close_time: 120_000,
      open: 100,
      high: 121,
      low: 99,
      close: 110,
      volume: 1,
    }], 110, 120_001);

    expect(result.completedTrade).toBeNull();
    expect(result.activeTrade?.firstTargetHit).toBe(true);
    expect(result.activeTrade?.lastProcessedCandleCloseTime).toBe(120_000);
  });

  it("同一根 K 线同时触及止盈止损时按止损优先", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "4h", 1_000, 60_000);
    const result = processSimulatedCandles(trade, [{
      open_time: 60_000,
      close_time: 120_000,
      open: 100,
      high: 121,
      low: 89,
      close: 110,
      volume: 1,
    }], 110, 120_001);

    expect(result.completedTrade?.exit_reason).toBe("stop_loss");
    expect(result.completedTrade?.first_target_hit).toBe(false);
  });

  it("不会重复处理已经回放过的 K 线", () => {
    const trade = openSimulatedTrade(analysis("LONG"), "4h", 1_000, 60_000);
    const quietCandle = {
      open_time: 60_000,
      close_time: 120_000,
      open: 100,
      high: 115,
      low: 99,
      close: 110,
      volume: 1,
    };
    const first = processSimulatedCandles(trade, [quietCandle], 110, 120_001).activeTrade!;
    const repeated = processSimulatedCandles(first, [{ ...quietCandle, high: 121 }], 110, 120_002);

    expect(repeated.activeTrade?.firstTargetHit).toBe(false);
    expect(repeated.activeTrade?.lastProcessedCandleCloseTime).toBe(120_000);
  });

  it("按八小时标准周期累计资金费，并区分多空支付方向", () => {
    const longTrade = openSimulatedTrade(analysis("LONG", 0.08), "1h", 1_000, 1);
    const shortTrade = openSimulatedTrade(analysis("SHORT", 0.08), "1h", 1_000, 1);
    const now = SIMULATION_FUNDING_PERIOD_MS + 1;

    const longUpdated = updateSimulatedTrade(longTrade, 100, now);
    const shortUpdated = updateSimulatedTrade(shortTrade, 100, now);
    expect(longUpdated.fundingAccrued).toBeCloseTo(0.32);
    expect(shortUpdated.fundingAccrued).toBeCloseTo(-0.32);
  });

  it("异常资金费率回退为零，不污染模拟盈亏", () => {
    const invalidAnalysis = { ...analysis("LONG"), funding_rate: Number.NaN };
    const trade = openSimulatedTrade(invalidAnalysis, "1h", 1_000, 1);
    const updated = updateSimulatedTrade(trade, 100, SIMULATION_FUNDING_PERIOD_MS + 1);

    expect(updated.fundingAccrued).toBe(0);
    expect(Number.isFinite(updated.unrealizedPnl)).toBe(true);
  });

  it("未触发止盈止损时更新净浮盈和最大有利/不利波动", () => {
    const trade = openSimulatedTrade(analysis("SHORT"), "1h", 1_000, 1);
    const favorable = updateSimulatedTrade(trade, 95, 2);
    const adverse = updateSimulatedTrade(favorable, 105, 3);

    expect(favorable.unrealizedPnl).toBeGreaterThan(0);
    expect(adverse.unrealizedPnl).toBeLessThan(0);
    expect(adverse.maxFavorableExcursionPercent).toBeGreaterThan(0);
    expect(adverse.maxAdverseExcursionPercent).toBeLessThan(0);
  });
});
