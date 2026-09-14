export const SIMULATION_TAKER_FEE_RATE = 0.0005;
export const SIMULATION_SLIPPAGE_RATE = 0.0002;
export const SIMULATION_FUNDING_PERIOD_MS = 8 * 60 * 60 * 1_000;
export const SIMULATION_FIRST_TARGET_CLOSE_RATE = 0.5;

function normalizeFundingRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : 0;
}

function applyEntrySlippage(price, direction) {
  return price * (direction === "SHORT" ? 1 - SIMULATION_SLIPPAGE_RATE : 1 + SIMULATION_SLIPPAGE_RATE);
}

function applyExitSlippage(price, direction) {
  return price * (direction === "SHORT" ? 1 + SIMULATION_SLIPPAGE_RATE : 1 - SIMULATION_SLIPPAGE_RATE);
}

function calculatePnl(trade, price) {
  const multiplier = trade.analysis.direction === "SHORT" ? -1 : 1;
  return (price - trade.entryPrice) * trade.size * multiplier;
}

function fundingPaymentAt(trade, now) {
  const elapsed = Math.max(0, now - (trade.lastFundingAt ?? trade.startedAt));
  const rate = normalizeFundingRate(trade.fundingRatePercent ?? trade.analysis.funding_rate) / 100;
  const directionSign = trade.analysis.direction === "SHORT" ? -1 : 1;
  const increment = trade.entryPrice * trade.size * rate
    * (elapsed / SIMULATION_FUNDING_PERIOD_MS) * directionSign;
  return (trade.fundingAccrued ?? 0) + increment;
}

function updateTrade(trade, currentPrice, now) {
  const fundingAccrued = fundingPaymentAt(trade, now);
  const unrealizedPnl = (trade.realizedGrossPnl ?? 0)
    + calculatePnl(trade, currentPrice)
    - (trade.entryFee ?? 0)
    - (trade.realizedExitFee ?? 0)
    - fundingAccrued;
  const excursionPercent = trade.allocatedAmount > 0
    ? unrealizedPnl / trade.allocatedAmount * 100
    : 0;
  return {
    ...trade,
    latestPrice: currentPrice,
    unrealizedPnl,
    fundingAccrued,
    lastFundingAt: now,
    maxFavorableExcursionPercent: Math.max(trade.maxFavorableExcursionPercent ?? 0, excursionPercent),
    maxAdverseExcursionPercent: Math.min(trade.maxAdverseExcursionPercent ?? 0, excursionPercent),
  };
}

function completeTrade(trade, plannedExitPrice, exitReason, now) {
  const direction = trade.analysis.direction;
  const exitPrice = applyExitSlippage(plannedExitPrice, direction);
  const grossPnl = (trade.realizedGrossPnl ?? 0) + calculatePnl(trade, exitPrice);
  const exitFee = exitPrice * trade.size * SIMULATION_TAKER_FEE_RATE;
  const fee = (trade.entryFee ?? 0) + (trade.realizedExitFee ?? 0) + exitFee;
  const fundingFee = fundingPaymentAt(trade, now);
  const netPnl = grossPnl - fee - fundingFee;
  const pnlPercent = trade.allocatedAmount > 0 ? netPnl / trade.allocatedAmount * 100 : 0;
  return {
    id: trade.id,
    decision_id: trade.id,
    position_id: trade.id,
    wallet_address: "SIMULATED",
    symbol: trade.analysis.symbol,
    direction,
    entry_price: trade.entryPrice,
    planned_entry_price: trade.plannedEntryPrice,
    trigger_price: trade.triggerPrice,
    exit_price: exitPrice,
    size: trade.initialSize ?? trade.size,
    fee,
    gross_pnl: grossPnl,
    net_pnl: netPnl,
    pnl_percent: pnlPercent,
    entry_source: trade.analysis.platform,
    exit_source: trade.analysis.platform,
    closed_at: new Date(now).toISOString(),
    analysis: trade.analysis,
    timeframe: trade.timeframe,
    started_at: new Date(trade.startedAt).toISOString(),
    allocated_amount: trade.allocatedAmount,
    platform: trade.analysis.platform,
    is_simulated: true,
    exit_reason: exitReason,
    funding_fee: fundingFee,
    slippage_rate: SIMULATION_SLIPPAGE_RATE,
    first_target_hit: trade.firstTargetHit === true,
    max_favorable_excursion_percent: Math.max(trade.maxFavorableExcursionPercent ?? 0, pnlPercent),
    max_adverse_excursion_percent: Math.min(trade.maxAdverseExcursionPercent ?? 0, pnlPercent),
  };
}

export function openServerSimulatedTrade(analysis, timeframe, referenceBalance, now = Date.now()) {
  if (analysis?.is_executable !== true || !["LONG", "SHORT"].includes(analysis?.direction)) {
    throw new Error("当前决策不可执行");
  }
  const validEntries = Array.isArray(analysis.entry_range)
    ? analysis.entry_range.map(Number).filter((price) => Number.isFinite(price) && price > 0)
    : [];
  if (validEntries.length === 0) throw new Error("决策缺少有效入场价格");
  const plannedEntryPrice = validEntries.reduce((sum, price) => sum + price, 0) / validEntries.length;
  const triggerPrice = Number(analysis.current_price);
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0
    || triggerPrice < Math.min(...validEntries) || triggerPrice > Math.max(...validEntries)) {
    throw new Error("当前价格尚未进入决策入场区间");
  }
  const entryPrice = applyEntrySlippage(triggerPrice, analysis.direction);
  const requestedMargin = Number(analysis.position_sizing?.margin_amount)
    || Math.max(Number(referenceBalance) || 0, 1_000) * 0.1;
  const allocatedAmount = Math.max(requestedMargin, 0);
  if (allocatedAmount <= 0) throw new Error("决策缺少有效模拟保证金");
  const leverage = Math.max(Number(analysis.leverage) || 1, 1);
  const size = allocatedAmount * leverage / entryPrice;
  const entryFee = entryPrice * size * SIMULATION_TAKER_FEE_RATE;
  return {
    id: -Math.max(1, now),
    analysis,
    timeframe,
    entryPrice,
    plannedEntryPrice,
    triggerPrice,
    size,
    initialSize: size,
    allocatedAmount,
    latestPrice: entryPrice,
    unrealizedPnl: -entryFee,
    entryFee,
    realizedGrossPnl: 0,
    realizedExitFee: 0,
    firstTargetHit: false,
    effectiveStopLoss: analysis.stop_loss,
    fundingRatePercent: normalizeFundingRate(analysis.funding_rate),
    fundingAccrued: 0,
    lastFundingAt: now,
    lastProcessedCandleCloseTime: now,
    maxFavorableExcursionPercent: 0,
    maxAdverseExcursionPercent: 0,
    startedAt: now,
  };
}

export function findSimulationCandleGap(trade, candles, now = Date.now()) {
  const lastProcessed = Number(trade?.lastProcessedCandleCloseTime ?? trade?.startedAt);
  if (!Number.isFinite(lastProcessed) || now - lastProcessed <= 2 * 60_000) return null;
  const completed = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(candle?.close_time)
      && candle.close_time > lastProcessed
      && candle.close_time <= now)
    .sort((left, right) => left.close_time - right.close_time);
  const earliestClose = Number(completed[0]?.close_time);
  const latestClose = Number(completed.at(-1)?.close_time);
  const maximumAllowedGap = 2 * 60_000;
  if (!Number.isFinite(earliestClose) || earliestClose - lastProcessed > maximumAllowedGap) {
    return {
      from: lastProcessed,
      to: Number.isFinite(earliestClose) ? earliestClose : now,
      reason: "历史 K 线不足，无法可靠还原止盈止损触发顺序",
    };
  }
  if (!Number.isFinite(latestClose) || now - latestClose > maximumAllowedGap) {
    return {
      from: latestClose || lastProcessed,
      to: now,
      reason: "最新 K 线尚未完整返回，模拟持仓已暂停结算",
    };
  }
  return null;
}

export function processServerSimulatedPriceRange(trade, lowPrice, highPrice, closePrice, now = Date.now()) {
  const direction = trade?.analysis?.direction;
  if (!["LONG", "SHORT"].includes(direction)) return { activeTrade: trade, completedTrade: null };
  const firstTarget = Number(trade.analysis.take_profit?.[0]);
  const secondTarget = Number(trade.analysis.take_profit?.[1] ?? firstTarget);
  const effectiveStop = Number(trade.effectiveStopLoss ?? trade.analysis.stop_loss);
  if (![lowPrice, highPrice, closePrice, firstTarget, secondTarget, effectiveStop]
    .every((price) => Number.isFinite(price) && price > 0)) {
    return { activeTrade: trade, completedTrade: null };
  }
  const isLong = direction === "LONG";
  // 无法从一根 K 线还原触价先后，止损和止盈同时命中时按更保守的止损结算。
  if (isLong ? lowPrice <= effectiveStop : highPrice >= effectiveStop) {
    return { activeTrade: null, completedTrade: completeTrade(trade, effectiveStop, "stop_loss", now) };
  }

  let activeTrade = trade;
  const firstTargetReached = isLong ? highPrice >= firstTarget : lowPrice <= firstTarget;
  if (!trade.firstTargetHit && firstTargetReached) {
    const closedSize = trade.size * SIMULATION_FIRST_TARGET_CLOSE_RATE;
    const firstExitPrice = applyExitSlippage(firstTarget, direction);
    const partialGrossPnl = calculatePnl({ ...trade, size: closedSize }, firstExitPrice);
    const partialExitFee = firstExitPrice * closedSize * SIMULATION_TAKER_FEE_RATE;
    activeTrade = {
      ...trade,
      size: trade.size - closedSize,
      realizedGrossPnl: (trade.realizedGrossPnl ?? 0) + partialGrossPnl,
      realizedExitFee: (trade.realizedExitFee ?? 0) + partialExitFee,
      firstTargetHit: true,
      effectiveStopLoss: trade.entryPrice,
      fundingAccrued: fundingPaymentAt(trade, now),
      lastFundingAt: now,
    };
  }
  const secondTargetReached = activeTrade.firstTargetHit
    && (isLong ? highPrice >= secondTarget : lowPrice <= secondTarget);
  if (secondTargetReached) {
    return { activeTrade: null, completedTrade: completeTrade(activeTrade, secondTarget, "take_profit", now) };
  }
  return { activeTrade: updateTrade(activeTrade, closePrice, now), completedTrade: null };
}

export function processServerSimulatedCandles(trade, candles, currentPrice, now = Date.now()) {
  let activeTrade = trade;
  const lastProcessed = trade.lastProcessedCandleCloseTime ?? trade.startedAt;
  const completedCandles = (Array.isArray(candles) ? candles : [])
    .filter((candle) => candle.open_time >= trade.startedAt
      && candle.close_time > lastProcessed
      && candle.close_time <= now
      && [candle.low, candle.high, candle.close].every((price) => Number.isFinite(price) && price > 0))
    .sort((left, right) => left.close_time - right.close_time);
  for (const candle of completedCandles) {
    const result = processServerSimulatedPriceRange(
      activeTrade, candle.low, candle.high, candle.close, candle.close_time,
    );
    if (result.completedTrade) return result;
    activeTrade = { ...result.activeTrade, lastProcessedCandleCloseTime: candle.close_time };
  }
  return processServerSimulatedPriceRange(activeTrade, currentPrice, currentPrice, currentPrice, now);
}
