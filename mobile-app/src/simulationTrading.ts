import type { AnalysisResponse, Candle, CompletedTradeRecord, MarketInterval, MarketPlatform } from "./alphaApi";

export const DEFAULT_SIMULATION_BALANCE = 1_000;
export const MAX_ACTIVE_DECISIONS = 3;
export const SIMULATION_CLIENT_ID_KEY = "alpha-simulation-client-id";
export const SIMULATION_WALLETS_KEY = "alpha-simulation-wallets";
export const simulationPlatforms: MarketPlatform[] = ["hyperliquid", "binance", "okx"];
// 统一使用保守模拟假设，不冒充用户在各交易所的真实费率等级。
export const SIMULATION_TAKER_FEE_RATE = 0.0005;
export const SIMULATION_SLIPPAGE_RATE = 0.0002;
export const SIMULATION_FUNDING_PERIOD_MS = 8 * 60 * 60 * 1_000;
export const SIMULATION_FIRST_TARGET_CLOSE_RATE = 0.5;

export type SimulatedExitReason = "take_profit" | "stop_loss";

export interface SimulatedTrade {
  id: number;
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  entryPrice: number;
  plannedEntryPrice?: number;
  triggerPrice?: number;
  size: number;
  initialSize?: number;
  allocatedAmount: number;
  latestPrice: number;
  unrealizedPnl: number;
  entryFee?: number;
  realizedGrossPnl?: number;
  realizedExitFee?: number;
  firstTargetHit?: boolean;
  effectiveStopLoss?: number;
  fundingRatePercent?: number;
  fundingAccrued?: number;
  lastFundingAt?: number;
  lastProcessedCandleCloseTime?: number;
  maxFavorableExcursionPercent?: number;
  maxAdverseExcursionPercent?: number;
  startedAt: number;
}

export interface SimulatedCompletedTrade extends CompletedTradeRecord {
  is_simulated: true;
  exit_reason: SimulatedExitReason;
  max_favorable_excursion_percent?: number;
  max_adverse_excursion_percent?: number;
  funding_fee?: number;
  slippage_rate?: number;
  first_target_hit?: boolean;
  planned_entry_price?: number;
  trigger_price?: number;
}

export interface SimulatedTradeProcessResult {
  activeTrade: SimulatedTrade | null;
  completedTrade: SimulatedCompletedTrade | null;
}

export interface SimulationWalletState {
  enabled: boolean;
  balance: number;
  activeTrades: SimulatedTrade[];
  history: SimulatedCompletedTrade[];
  autoTimeframe: MarketInterval;
}

type LegacySimulationWalletState = Partial<SimulationWalletState> & {
  activeTrade?: SimulatedTrade | null;
};

export type SimulationWalletBook = Record<MarketPlatform, SimulationWalletState>;

export function getSimulationClientId() {
  const stored = window.localStorage.getItem(SIMULATION_CLIENT_ID_KEY);
  if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  const clientId = `device_${crypto.randomUUID()}`;
  window.localStorage.setItem(SIMULATION_CLIENT_ID_KEY, clientId);
  return clientId;
}

export function createDefaultSimulationWallet(enabled = false): SimulationWalletState {
  return {
    enabled,
    balance: DEFAULT_SIMULATION_BALANCE,
    activeTrades: [],
    history: [],
    autoTimeframe: "4h",
  };
}

export function hasSimulationData(state: SimulationWalletState) {
  return state.enabled
    || state.balance !== DEFAULT_SIMULATION_BALANCE
    || state.activeTrades.length > 0
    || state.history.length > 0;
}

export function restoreSimulationWallet(raw: string | null, platform: MarketPlatform = "hyperliquid"): SimulationWalletState {
  if (!raw) return createDefaultSimulationWallet();
  try {
    const stored = JSON.parse(raw) as LegacySimulationWalletState | null;
    if (!stored || typeof stored !== "object") return createDefaultSimulationWallet();
    const storedActiveTrades = Array.isArray(stored.activeTrades)
      ? stored.activeTrades
      : stored.activeTrade ? [stored.activeTrade] : [];
    // 旧版本仅保存 activeTrade；恢复时自动迁移并限制为当前并发上限。
    const activeTrades = storedActiveTrades
      .filter((trade): trade is SimulatedTrade => Boolean(trade && typeof trade === "object"))
      .slice(0, MAX_ACTIVE_DECISIONS)
      .map((trade) => ({
          ...trade,
          initialSize: Number.isFinite(trade.initialSize) ? trade.initialSize : trade.size,
          entryFee: Number.isFinite(trade.entryFee) ? trade.entryFee : 0,
          realizedGrossPnl: Number.isFinite(trade.realizedGrossPnl) ? trade.realizedGrossPnl : 0,
          realizedExitFee: Number.isFinite(trade.realizedExitFee) ? trade.realizedExitFee : 0,
          firstTargetHit: trade.firstTargetHit === true,
          effectiveStopLoss: Number.isFinite(trade.effectiveStopLoss)
            ? trade.effectiveStopLoss : trade.analysis.stop_loss,
          fundingRatePercent: Number.isFinite(trade.fundingRatePercent)
            ? trade.fundingRatePercent : normalizeFundingRate(trade.analysis.funding_rate),
          fundingAccrued: Number.isFinite(trade.fundingAccrued) ? trade.fundingAccrued : 0,
          lastFundingAt: Number.isFinite(trade.lastFundingAt) ? trade.lastFundingAt : trade.startedAt,
          lastProcessedCandleCloseTime: Number.isFinite(trade.lastProcessedCandleCloseTime)
            ? trade.lastProcessedCandleCloseTime : trade.startedAt,
          analysis: {
            ...trade.analysis,
            platform,
          },
        }));
    const history = Array.isArray(stored.history)
      ? stored.history.slice(0, 500).map((trade) => ({
          ...trade,
          platform,
          analysis: {
            ...trade.analysis,
            platform,
          },
        }))
      : [];
    return {
      enabled: stored.enabled === true,
      balance: Number.isFinite(stored.balance) && Math.abs(Number(stored.balance)) <= 1_000_000_000
        ? Number(stored.balance)
        : DEFAULT_SIMULATION_BALANCE,
      activeTrades,
      history,
      autoTimeframe: typeof stored.autoTimeframe === "string"
        && ["1m", "5m", "15m", "1h", "4h", "1d"].includes(stored.autoTimeframe)
        ? stored.autoTimeframe as MarketInterval
        : "4h",
    };
  } catch {
    return createDefaultSimulationWallet();
  }
}

export function createDefaultSimulationWalletBook(): SimulationWalletBook {
  return {
    hyperliquid: createDefaultSimulationWallet(),
    binance: createDefaultSimulationWallet(),
    okx: createDefaultSimulationWallet(),
  };
}

export function restoreSimulationWalletBook(
  raw: string | null,
  legacyRaw: string | null = null,
  legacyPlatform: MarketPlatform = "hyperliquid",
): SimulationWalletBook {
  if (raw) {
    try {
      const stored = JSON.parse(raw) as Partial<Record<MarketPlatform, SimulationWalletState>>;
      return {
        hyperliquid: restoreSimulationWallet(JSON.stringify(stored.hyperliquid ?? null), "hyperliquid"),
        binance: restoreSimulationWallet(JSON.stringify(stored.binance ?? null), "binance"),
        okx: restoreSimulationWallet(JSON.stringify(stored.okx ?? null), "okx"),
      };
    } catch {
      // 新版缓存损坏时继续尝试兼容旧版单钱包缓存。
    }
  }

  const wallets = createDefaultSimulationWalletBook();
  if (!legacyRaw) return wallets;
  let inferredPlatform = legacyPlatform;
  try {
    const legacy = JSON.parse(legacyRaw) as LegacySimulationWalletState;
    const storedPlatform = legacy.activeTrades?.[0]?.analysis.platform
      ?? legacy.activeTrade?.analysis.platform
      ?? legacy.history?.[0]?.platform;
    if (simulationPlatforms.includes(storedPlatform as MarketPlatform)) {
      inferredPlatform = storedPlatform as MarketPlatform;
    }
  } catch {
    // 无法识别平台时沿用用户上次选择的平台。
  }
  wallets[inferredPlatform] = restoreSimulationWallet(legacyRaw, inferredPlatform);
  return wallets;
}

export function calculateSimulatedPnl(trade: Pick<SimulatedTrade, "analysis" | "entryPrice" | "size">, price: number) {
  const multiplier = trade.analysis.direction === "SHORT" ? -1 : 1;
  return (price - trade.entryPrice) * trade.size * multiplier;
}

function stablePrice(value: number) {
  return Number.isFinite(value) ? value.toPrecision(12) : "invalid";
}

export function buildSimulationSignalKey(
  analysis: AnalysisResponse,
  timeframe: MarketInterval,
  platform: MarketPlatform = analysis.platform,
) {
  const planIdentity = analysis.plan_id?.trim() || [
    analysis.generated_at || "legacy",
    analysis.symbol,
    analysis.direction,
    analysis.entry_range.map(stablePrice).join("-"),
    stablePrice(analysis.stop_loss),
    analysis.take_profit.map(stablePrice).join("-"),
  ].join(":");
  return `${platform}:${timeframe}:${planIdentity}:v${analysis.decision_revision ?? 1}`;
}

function applyEntrySlippage(price: number, direction: AnalysisResponse["direction"]) {
  return price * (direction === "SHORT" ? 1 - SIMULATION_SLIPPAGE_RATE : 1 + SIMULATION_SLIPPAGE_RATE);
}

function applyExitSlippage(price: number, direction: AnalysisResponse["direction"]) {
  return price * (direction === "SHORT" ? 1 + SIMULATION_SLIPPAGE_RATE : 1 - SIMULATION_SLIPPAGE_RATE);
}

function normalizeFundingRate(value: unknown) {
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : 0;
}

function fundingPaymentAt(trade: SimulatedTrade, now: number) {
  const elapsed = Math.max(0, now - (trade.lastFundingAt ?? trade.startedAt));
  const rate = normalizeFundingRate(trade.fundingRatePercent ?? trade.analysis.funding_rate) / 100;
  const directionSign = trade.analysis.direction === "SHORT" ? -1 : 1;
  const increment = trade.entryPrice * trade.size * rate
    * (elapsed / SIMULATION_FUNDING_PERIOD_MS) * directionSign;
  return (trade.fundingAccrued ?? 0) + increment;
}

export function openSimulatedTrade(
  analysis: AnalysisResponse,
  timeframe: MarketInterval,
  referenceBalance: number,
  now = Date.now(),
): SimulatedTrade {
  if (analysis.direction === "WAIT") throw new Error("等待信号不能开启模拟交易");
  const validEntries = analysis.entry_range.filter((price) => Number.isFinite(price) && price > 0);
  if (validEntries.length === 0) throw new Error("决策缺少有效入场价格");
  const plannedEntry = validEntries.reduce((sum, price) => sum + price, 0) / validEntries.length;
  const entryLow = Math.min(...validEntries);
  const entryHigh = Math.max(...validEntries);
  const currentPrice = Number(analysis.current_price);
  const hasCurrentPrice = Number.isFinite(currentPrice) && currentPrice > 0;
  if (hasCurrentPrice && (currentPrice < entryLow || currentPrice > entryHigh)) {
    throw new Error("当前价格尚未进入决策入场区间");
  }
  const triggerPrice = hasCurrentPrice ? currentPrice : plannedEntry;
  const entryPrice = applyEntrySlippage(triggerPrice, analysis.direction);
  // 模拟账户仅统计盈亏，不用余额限制决策样本的计划保证金。
  const requestedMargin = analysis.position_sizing?.margin_amount || Math.max(referenceBalance, DEFAULT_SIMULATION_BALANCE) * 0.1;
  const allocatedAmount = Math.max(requestedMargin, 0);
  if (allocatedAmount <= 0) throw new Error("决策缺少有效模拟保证金");
  const size = allocatedAmount * Math.max(analysis.leverage, 1) / entryPrice;
  const entryFee = entryPrice * size * SIMULATION_TAKER_FEE_RATE;

  return {
    id: -Math.max(1, now),
    analysis,
    timeframe,
    entryPrice,
    plannedEntryPrice: plannedEntry,
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

export function updateSimulatedTrade(trade: SimulatedTrade, currentPrice: number, now = Date.now()): SimulatedTrade {
  const unrealizedPnl = (trade.realizedGrossPnl ?? 0)
    + calculateSimulatedPnl(trade, currentPrice)
    - (trade.entryFee ?? 0)
    - (trade.realizedExitFee ?? 0)
    - fundingPaymentAt(trade, now);
  const excursionPercent = trade.allocatedAmount > 0
    ? unrealizedPnl / trade.allocatedAmount * 100
    : 0;
  return {
    ...trade,
    latestPrice: currentPrice,
    unrealizedPnl,
    fundingAccrued: fundingPaymentAt(trade, now),
    lastFundingAt: now,
    maxFavorableExcursionPercent: Math.max(
      trade.maxFavorableExcursionPercent ?? 0,
      excursionPercent,
    ),
    maxAdverseExcursionPercent: Math.min(
      trade.maxAdverseExcursionPercent ?? 0,
      excursionPercent,
    ),
  };
}

function completeSimulatedTrade(
  trade: SimulatedTrade,
  plannedExitPrice: number,
  exitReason: SimulatedExitReason,
  now: number,
): SimulatedCompletedTrade {
  const direction = trade.analysis.direction;
  if (direction === "WAIT") throw new Error("等待信号不能完成模拟交易");
  const exitPrice = applyExitSlippage(plannedExitPrice, direction);
  const remainingGrossPnl = calculateSimulatedPnl(trade, exitPrice);
  const grossPnl = (trade.realizedGrossPnl ?? 0) + remainingGrossPnl;
  const exitFee = exitPrice * trade.size * SIMULATION_TAKER_FEE_RATE;
  const fee = (trade.entryFee ?? 0) + (trade.realizedExitFee ?? 0) + exitFee;
  const fundingFee = fundingPaymentAt(trade, now);
  const netPnl = grossPnl - fee - fundingFee;
  const exitPnlPercent = netPnl / trade.allocatedAmount * 100;
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
    pnl_percent: exitPnlPercent,
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
    max_favorable_excursion_percent: Math.max(
      trade.maxFavorableExcursionPercent ?? 0,
      exitPnlPercent,
    ),
    max_adverse_excursion_percent: Math.min(
      trade.maxAdverseExcursionPercent ?? 0,
      exitPnlPercent,
    ),
  };
}

export function processSimulatedPriceRange(
  trade: SimulatedTrade,
  lowPrice: number,
  highPrice: number,
  closePrice: number,
  now = Date.now(),
): SimulatedTradeProcessResult {
  const direction = trade.analysis.direction;
  if (direction === "WAIT") return { activeTrade: trade, completedTrade: null };
  const isLong = direction === "LONG";
  const firstTarget = trade.analysis.take_profit[0];
  const secondTarget = trade.analysis.take_profit[1] ?? firstTarget;
  const effectiveStop = trade.effectiveStopLoss ?? trade.analysis.stop_loss;
  // 轮询无法还原两个价位在间隔内的先后顺序，同时越界时按保守止损结算。
  const stopReached = isLong ? lowPrice <= effectiveStop : highPrice >= effectiveStop;
  if (stopReached) {
    return {
      activeTrade: null,
      completedTrade: completeSimulatedTrade(trade, effectiveStop, "stop_loss", now),
    };
  }

  let activeTrade = trade;
  const firstTargetReached = isLong ? highPrice >= firstTarget : lowPrice <= firstTarget;
  if (!trade.firstTargetHit && firstTargetReached) {
    const closedSize = trade.size * SIMULATION_FIRST_TARGET_CLOSE_RATE;
    const firstExitPrice = applyExitSlippage(firstTarget, direction);
    const partialTrade = { ...trade, size: closedSize };
    const partialGrossPnl = calculateSimulatedPnl(partialTrade, firstExitPrice);
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
    return {
      activeTrade: null,
      completedTrade: completeSimulatedTrade(activeTrade, secondTarget, "take_profit", now),
    };
  }
  return {
    activeTrade: updateSimulatedTrade(activeTrade, closePrice, now),
    completedTrade: null,
  };
}

export function processSimulatedTrade(
  trade: SimulatedTrade,
  currentPrice: number,
  now = Date.now(),
): SimulatedTradeProcessResult {
  return processSimulatedPriceRange(trade, currentPrice, currentPrice, currentPrice, now);
}

export function processSimulatedCandles(
  trade: SimulatedTrade,
  candles: Candle[],
  currentPrice: number,
  now = Date.now(),
): SimulatedTradeProcessResult {
  let activeTrade = trade;
  const lastProcessed = trade.lastProcessedCandleCloseTime ?? trade.startedAt;
  const completedCandles = candles
    .filter((candle) => (
      candle.open_time >= trade.startedAt
      && candle.close_time > lastProcessed
      && candle.close_time <= now
      && [candle.low, candle.high, candle.close].every((price) => Number.isFinite(price) && price > 0)
    ))
    .sort((left, right) => left.close_time - right.close_time);

  for (const candle of completedCandles) {
    const result = processSimulatedPriceRange(
      activeTrade, candle.low, candle.high, candle.close, candle.close_time,
    );
    if (result.completedTrade) return result;
    activeTrade = {
      ...result.activeTrade!,
      lastProcessedCandleCloseTime: candle.close_time,
    };
  }

  return processSimulatedTrade(activeTrade, currentPrice, now);
}

export function closeSimulatedTradeIfTriggered(
  trade: SimulatedTrade,
  currentPrice: number,
  now = Date.now(),
): SimulatedCompletedTrade | null {
  return processSimulatedTrade(trade, currentPrice, now).completedTrade;
}
