import type { AnalysisResponse, CompletedTradeRecord, MarketInterval, MarketPlatform } from "./alphaApi";

export const DEFAULT_SIMULATION_BALANCE = 1_000;
export const MAX_ACTIVE_DECISIONS = 3;
export const SIMULATION_CLIENT_ID_KEY = "alpha-simulation-client-id";
export const SIMULATION_WALLETS_KEY = "alpha-simulation-wallets";
export const simulationPlatforms: MarketPlatform[] = ["hyperliquid", "binance", "okx"];

export type SimulatedExitReason = "take_profit" | "stop_loss";

export interface SimulatedTrade {
  id: number;
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  entryPrice: number;
  size: number;
  allocatedAmount: number;
  latestPrice: number;
  unrealizedPnl: number;
  startedAt: number;
}

export interface SimulatedCompletedTrade extends CompletedTradeRecord {
  is_simulated: true;
  exit_reason: SimulatedExitReason;
}

export interface SimulationWalletState {
  enabled: boolean;
  balance: number;
  activeTrades: SimulatedTrade[];
  history: SimulatedCompletedTrade[];
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
      balance: Number.isFinite(stored.balance) && Number(stored.balance) >= 0
        ? Number(stored.balance)
        : DEFAULT_SIMULATION_BALANCE,
      activeTrades,
      history,
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

export function openSimulatedTrade(
  analysis: AnalysisResponse,
  timeframe: MarketInterval,
  balance: number,
  now = Date.now(),
): SimulatedTrade {
  if (analysis.direction === "WAIT") throw new Error("等待信号不能开启模拟交易");
  const validEntries = analysis.entry_range.filter((price) => Number.isFinite(price) && price > 0);
  if (validEntries.length === 0) throw new Error("决策缺少有效入场价格");
  const entryPrice = validEntries.reduce((sum, price) => sum + price, 0) / validEntries.length;
  const requestedMargin = analysis.position_sizing?.margin_amount || balance * 0.1;
  const allocatedAmount = Math.min(Math.max(requestedMargin, 0), Math.max(balance, 0));
  if (allocatedAmount <= 0) throw new Error("模拟钱包余额不足");
  const size = allocatedAmount * Math.max(analysis.leverage, 1) / entryPrice;

  return {
    id: -Math.max(1, now),
    analysis,
    timeframe,
    entryPrice,
    size,
    allocatedAmount,
    latestPrice: entryPrice,
    unrealizedPnl: 0,
    startedAt: now,
  };
}

export function updateSimulatedTrade(trade: SimulatedTrade, currentPrice: number): SimulatedTrade {
  return {
    ...trade,
    latestPrice: currentPrice,
    unrealizedPnl: calculateSimulatedPnl(trade, currentPrice),
  };
}

export function closeSimulatedTradeIfTriggered(
  trade: SimulatedTrade,
  currentPrice: number,
  now = Date.now(),
): SimulatedCompletedTrade | null {
  const direction = trade.analysis.direction;
  if (direction === "WAIT") return null;
  const target = trade.analysis.take_profit[0];
  const stop = trade.analysis.stop_loss;
  const isLong = direction === "LONG";
  const exitReason: SimulatedExitReason | null = isLong
    ? currentPrice <= stop ? "stop_loss" : currentPrice >= target ? "take_profit" : null
    : currentPrice >= stop ? "stop_loss" : currentPrice <= target ? "take_profit" : null;
  if (!exitReason) return null;

  // 触发后按计划价结算，避免轮询间隔造成不确定滑点。
  const exitPrice = exitReason === "stop_loss" ? stop : target;
  const grossPnl = calculateSimulatedPnl(trade, exitPrice);
  return {
    id: trade.id,
    decision_id: trade.id,
    position_id: trade.id,
    wallet_address: "SIMULATED",
    symbol: trade.analysis.symbol,
    direction,
    entry_price: trade.entryPrice,
    exit_price: exitPrice,
    size: trade.size,
    fee: 0,
    gross_pnl: grossPnl,
    net_pnl: grossPnl,
    pnl_percent: grossPnl / trade.allocatedAmount * 100,
    entry_source: "plan",
    exit_source: trade.analysis.platform,
    closed_at: new Date(now).toISOString(),
    analysis: trade.analysis,
    timeframe: trade.timeframe,
    started_at: new Date(trade.startedAt).toISOString(),
    allocated_amount: trade.allocatedAmount,
    platform: trade.analysis.platform,
    is_simulated: true,
    exit_reason: exitReason,
  };
}
