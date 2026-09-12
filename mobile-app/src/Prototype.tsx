import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityLogIcon,
  BarChartIcon,
  BellIcon,
  BookmarkIcon,
  ChevronRightIcon,
  FileTextIcon,
  GearIcon,
  LockClosedIcon,
  MagicWandIcon,
  PieChartIcon,
  ReaderIcon,
} from "@radix-ui/react-icons";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  cancelExecution,
  completePosition,
  createExecution,
  getApiAccessToken,
  loadAnalysis,
  loadActiveExecutions,
  loadApiAccessToken,
  loadCandles,
  loadCapitalSettings,
  loadCompletedTrades,
  loadMarket,
  loadNews,
  loadOpportunities,
  loadPlatformAccount,
  loadPlatformCredentialStatus,
  loadPositionMonitors,
  loadReviews,
  loadSimulationWallet,
  loadWallet,
  loadWalletSettings,
  saveCapitalSettings,
  savePlatformCredentials,
  saveSimulationWallet,
  saveWalletSettings,
  setApiAccessToken,
  type AnalysisResponse,
  type AssetSymbol,
  type Candle,
  type CompletedTradeRecord,
  type MarketInterval,
  type MarketPlatform,
  type MarketSnapshot,
  type NewsItem,
  type PositionMonitor,
  type ReviewRecord,
  type WalletSnapshot,
} from "./alphaApi";
import { BottomSheet, KeyboardInput, MobileScroll, useKeyboard } from "./mobile";
import DownloadLanding from "./DownloadLanding";
import {
  DEFAULT_SIMULATION_BALANCE,
  MAX_ACTIVE_DECISIONS,
  SIMULATION_WALLETS_KEY,
  closeSimulatedTradeIfTriggered,
  createDefaultSimulationWallet,
  getSimulationClientId,
  hasSimulationData,
  openSimulatedTrade,
  restoreSimulationWallet,
  restoreSimulationWalletBook,
  simulationPlatforms,
  updateSimulatedTrade,
  type SimulatedCompletedTrade,
  type SimulatedTrade,
  type SimulationWalletBook,
  type SimulationWalletState,
} from "./simulationTrading";
import "./prototype.css";

type TabId = "market" | "decision" | "news" | "positions" | "review";
type DataState = "loading" | "live" | "demo" | "offline";
type RemoteState = "idle" | "loading" | "ready" | "offline";
type SimulationSyncState = "loading" | "saving" | "synced" | "offline";
type MarketMode = "free" | "decision";
const marketPlatformLabels: Record<MarketPlatform, string> = {
  hyperliquid: "Hyperliquid",
  binance: "Binance 永续",
  okx: "OKX 永续",
};
type BrowserWalletProvider = {
  request: (payload: { method: string; params?: unknown[] }) => Promise<unknown>;
};
type MarketSelection = { symbol: AssetSymbol; timeframe: MarketInterval };
type DecisionMarketSelection = MarketSelection & {
  score: number;
  direction: AnalysisResponse["direction"];
};
type LockedDecision = {
  decisionId: number;
  positionId: number;
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  startedAt: number;
  totalAmount: number;
  allocatedAmount: number;
};
type StrategyOptimizationSummary = {
  status?: string;
  version_before?: string;
  version_after?: string;
  sample_total?: number;
  sample_limit?: number;
  win_rate?: number;
  net_pnl?: number;
  changes?: string[];
};

async function connectWithWalletConnect(projectId: string): Promise<string> {
  const [{ createAppKit }, { arbitrum }] = await Promise.all([
    import("@reown/appkit"),
    import("@reown/appkit/networks"),
  ]);
  const modal = createAppKit({
    projectId,
    networks: [arbitrum],
    defaultNetwork: arbitrum,
    metadata: {
      name: "Alpha Trader AI",
      description: "只读市场分析与交易复盘",
      url: window.location.origin,
      icons: [`${window.location.origin}/icons/icon-192.png`],
    },
    themeMode: "dark",
    enableWalletConnect: true,
    features: { analytics: false, email: false, socials: false },
  });
  const connectedAddress = modal.getAddress("eip155");
  if (connectedAddress) return connectedAddress;

  return new Promise<string>((resolve, reject) => {
    let opened = false;
    let unsubscribeAccount: () => void = () => undefined;
    let unsubscribeState: () => void = () => undefined;
    const finish = (address?: string) => {
      unsubscribeAccount();
      unsubscribeState();
      if (address) resolve(address);
      else reject(new Error("钱包连接已取消"));
    };
    unsubscribeAccount = modal.subscribeAccount((account) => {
      if (account.isConnected && account.address) finish(account.address);
    }, "eip155");
    unsubscribeState = modal.subscribeState((state) => {
      if (state.open) opened = true;
      else if (opened && !modal.getAddress("eip155")) finish();
    });
    void modal.open({ view: "Connect", namespace: "eip155" }).catch(() => finish());
  });
}

function executionToLockedDecision(state: import("./alphaApi").ExecutionState): LockedDecision {
  return {
    decisionId: state.decision.id,
    positionId: state.position.id,
    analysis: state.decision.analysis,
    timeframe: state.decision.timeframe,
    startedAt: new Date(state.decision.started_at).getTime(),
    totalAmount: state.decision.total_amount,
    allocatedAmount: state.decision.allocated_amount,
  };
}

function simulatedTradeToLockedDecision(trade: SimulatedTrade): LockedDecision {
  return {
    decisionId: trade.id,
    positionId: trade.id,
    analysis: trade.analysis,
    timeframe: trade.timeframe,
    startedAt: trade.startedAt,
    totalAmount: trade.allocatedAmount,
    allocatedAmount: trade.allocatedAmount,
  };
}

const assets: Record<AssetSymbol, { pair: string; price: string; delta: string; regime: string }> = {
  BTC: { pair: "BTC/USDT", price: "114,320.5", delta: "+2.13%", regime: "温和上涨" },
  ETH: { pair: "ETH/USDT", price: "4,357.8", delta: "+1.28%", regime: "偏多震荡" },
  SOL: { pair: "SOL/USDT", price: "228.4", delta: "-0.62%", regime: "高位整理" },
  HYPE: { pair: "HYPE/USDT", price: "48.17", delta: "+3.11%", regime: "动能增强" },
};

const navItems = [
  { id: "market" as const, label: "市场", icon: BarChartIcon },
  { id: "decision" as const, label: "决策", icon: MagicWandIcon },
  { id: "news" as const, label: "新闻", icon: ReaderIcon },
  { id: "positions" as const, label: "持仓", icon: PieChartIcon },
  { id: "review" as const, label: "复盘", icon: FileTextIcon },
];

const tabLabels: Record<TabId, { eyebrow: string; title: string; summary: string }> = {
  market: { eyebrow: "实时市场", title: "市场总览", summary: "行情、结构与风险信号" },
  decision: { eyebrow: "AI 决策", title: "今日判断", summary: "把复杂信息收敛为可执行计划" },
  news: { eyebrow: "新闻雷达", title: "影响市场的事", summary: "按相关性与可信度排序" },
  positions: { eyebrow: "只读账户", title: "持仓监控", summary: "先看风险，再看收益" },
  review: { eyebrow: "交易复盘", title: "今天做对了什么", summary: "用记录改进下一次判断" },
};

function movingAverage(candles: CandlestickData<UTCTimestamp>[], window: number): LineData<UTCTimestamp>[] {
  return candles.slice(window - 1).map((candle, index) => ({
    time: candle.time,
    value: candles.slice(index, index + window).reduce((sum, item) => sum + item.close, 0) / window,
  }));
}

function buildChartData(symbol: AssetSymbol, apiCandles: Candle[] = []) {
  if (apiCandles.length > 0) {
    const candles = apiCandles.map<CandlestickData<UTCTimestamp>>((candle) => ({
      time: Math.floor(candle.open_time / 1000) as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    const volumes = apiCandles.map<HistogramData<UTCTimestamp>>((candle) => ({
      time: Math.floor(candle.open_time / 1000) as UTCTimestamp,
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(52, 211, 153, .45)" : "rgba(255, 104, 91, .42)",
    }));

    return { candles, volumes, ma12: movingAverage(candles, 12), ma24: movingAverage(candles, 24) };
  }

  const base = { BTC: 108200, ETH: 4100, SOL: 221, HYPE: 43.2 }[symbol] ?? 100;
  const factor = { BTC: 720, ETH: 42, SOL: 2.3, HYPE: 0.62 }[symbol] ?? 1;
  let previous = base;
  const candles: CandlestickData<UTCTimestamp>[] = [];
  const volumes: HistogramData<UTCTimestamp>[] = [];

  for (let index = 0; index < 42; index += 1) {
    const time = (Date.UTC(2026, 8, 9, 1 + index) / 1000) as UTCTimestamp;
    const drift = factor * (0.15 + Math.sin(index * 0.72) * 0.42 + (index % 7 === 0 ? -0.5 : 0.12));
    const open = previous;
    const close = Math.max(base * 0.94, open + drift);
    const high = Math.max(open, close) + factor * (0.3 + (index % 3) * 0.12);
    const low = Math.min(open, close) - factor * (0.22 + (index % 4) * 0.09);
    candles.push({ time, open, high, low, close });
    volumes.push({
      time,
      value: 1200 + ((index * 173) % 2100),
      color: close >= open ? "rgba(52, 211, 153, .45)" : "rgba(255, 104, 91, .42)",
    });
    previous = close;
  }

  const target = { BTC: 114320.5, ETH: 4357.8, SOL: 228.4, HYPE: 48.17 }[symbol] ?? base;
  const offset = target - candles[candles.length - 1].close;
  const normalizedCandles = candles.map((candle) => ({
    ...candle,
    open: candle.open + offset,
    high: candle.high + offset,
    low: candle.low + offset,
    close: candle.close + offset,
  }));
  return {
    candles: normalizedCandles,
    volumes,
    ma12: movingAverage(normalizedCandles, 12),
    ma24: movingAverage(normalizedCandles, 24),
  };
}

function MarketChart({ symbol, interval, candles }: { symbol: AssetSymbol; interval: MarketInterval; candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartData = useMemo(() => buildChartData(symbol, candles), [candles, symbol]);

  useEffect(() => {
    if (!containerRef.current) return;

    // 使用成熟图表库绘制真实 K 线，避免将行情图做成不可交互的装饰图片。
    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 164,
      layout: {
        background: { type: ColorType.Solid, color: "#0b1217" },
        textColor: "#71808c",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(149, 163, 184, .08)" },
        horzLines: { color: "rgba(149, 163, 184, .08)" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "rgba(247, 190, 67, .35)", labelBackgroundColor: "#f7be43" },
        horzLine: { color: "rgba(247, 190, 67, .35)", labelBackgroundColor: "#f7be43" },
      },
      handleScale: false,
      handleScroll: false,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#ff685b",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#ff685b",
      priceLineColor: "#f7be43",
      priceLineWidth: 1,
    });
    candleSeries.setData(chartData.candles);

    const fastAverage = chart.addSeries(LineSeries, {
      color: "#f7be43",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    fastAverage.setData(chartData.ma12);

    const slowAverage = chart.addSeries(LineSeries, {
      color: "#5b9cf6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    slowAverage.setData(chartData.ma24);

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeries.setData(chartData.volumes);
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [chartData]);

  return <div className="market-chart" ref={containerRef} aria-label={`${symbol} ${interval} K 线图`} />;
}

const dataStateLabel: Record<DataState, string> = {
  loading: "正在同步行情",
  live: "实时数据",
  demo: "演示数据",
  offline: "行情暂不可用",
};

function AppHeader({
  dataState,
  platform,
  simulationEnabled,
  onOpenSettings,
}: {
  dataState: DataState;
  platform: MarketPlatform;
  simulationEnabled: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <header className="brand-header">
      <button className="platform-settings-trigger" type="button" aria-label="行情平台设置" onClick={onOpenSettings}>
        <GearIcon />
      </button>
      <div className="brand-copy">
        <strong><span>Alpha</span> Trader AI</strong>
        <p>用数据，看更远的市场</p>
      </div>
      <div className="header-meta">
        <time dateTime="2026-09-11">2026-09-11</time>
        <span>专注 · 理性 · 长期</span>
      </div>
      <div className="readonly-banner">
        <span><LockClosedIcon /> {simulationEnabled ? "模拟交易 · 不会真实下单" : "只读模式 · 不会自动下单"}</span>
        <em className={`source-status ${dataState}`}>{marketPlatformLabels[platform]} · {dataStateLabel[dataState]}</em>
      </div>
    </header>
  );
}

function formatPrice(value: number) {
  const absolute = Math.abs(value);
  const fractionDigits = absolute >= 1000 ? 1 : absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function formatLocalDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMoney(value: number) {
  return `${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USDT`;
}

function formatUsdc(value: number) {
  return `${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USDC`;
}

function formatDecisionTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shiftArchiveDate(value: string, offset: number) {
  const [year, month, day] = value.split("-").map(Number);
  return formatLocalDate(new Date(year, month - 1, day + offset));
}

function formatCompact(value?: number) {
  if (value === undefined) return "--";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function isSimulatedTrade(trade: CompletedTradeRecord): trade is SimulatedCompletedTrade {
  return "is_simulated" in trade && trade.is_simulated === true;
}

function readStrategyOptimization(review: ReviewRecord): StrategyOptimizationSummary | null {
  const value = review.metrics.strategy_optimization;
  return value && typeof value === "object" ? value as StrategyOptimizationSummary : null;
}

function readMetricNumber(review: ReviewRecord, key: string) {
  const value = review.metrics[key];
  return typeof value === "number" ? value : 0;
}

function getMarketRegime(snapshot: MarketSnapshot | null, fallback: string) {
  if (!snapshot) return fallback;
  if (snapshot.volatility >= 6) return "高波动";
  if (snapshot.change_24h >= 3) return "动能增强";
  if (snapshot.change_24h >= 0) return "温和上涨";
  return "高位整理";
}

const directionLabels: Record<AnalysisResponse["direction"], string> = {
  LONG: "偏多",
  SHORT: "偏空",
  WAIT: "等待",
};

const riskLabels: Record<AnalysisResponse["risk"], string> = {
  low: "低",
  medium: "中等",
  high: "高",
};

function DecisionMarketChartCard({ selection, platform }: { selection: DecisionMarketSelection; platform: MarketPlatform }) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "offline">("loading");

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setCandles([]);

    const refresh = () => {
      loadCandles(selection.symbol, selection.timeframe, 80, controller.signal, platform)
        .then((nextCandles) => {
          setCandles(nextCandles);
          setState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setState("offline");
        });
    };
    refresh();
    const intervalId = window.setInterval(refresh, 30_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [platform, selection.symbol, selection.timeframe]);

  return (
    <article className="decision-market-chart-card">
      <div className="decision-market-chart-heading">
        <div>
          <strong>{selection.symbol}/USDT</strong>
          <span>{selection.timeframe} · 决策 #{selection.score || "--"}</span>
        </div>
        <em className={selection.direction.toLowerCase()}>{directionLabels[selection.direction]}</em>
      </div>
      <MarketChart symbol={selection.symbol} interval={selection.timeframe} candles={candles} />
      <div className={`decision-chart-source ${state}`}>
        {state === "loading" ? "正在同步 K 线" : state === "offline" ? "K 线暂不可用 · 展示演示走势" : "决策行情已同步"}
      </div>
    </article>
  );
}

function MarketScreen({
  openDetails,
  mode,
  onModeChange,
  freeSymbol,
  onFreeSymbolChange,
  decisionSelections,
  platform,
  onPlatformChange,
  simulationWallet,
  simulationSyncState,
  onSimulationEnabledChange,
  onResetSimulationWallet,
  apiAccessToken,
  onApiAccessTokenChange,
}: {
  openDetails: (analysis: AnalysisResponse | null, symbol: AssetSymbol, timeframe: MarketInterval) => void;
  mode: MarketMode;
  onModeChange: (mode: MarketMode) => void;
  freeSymbol: AssetSymbol;
  onFreeSymbolChange: (symbol: AssetSymbol) => void;
  decisionSelections: DecisionMarketSelection[];
  platform: MarketPlatform;
  onPlatformChange: (platform: MarketPlatform) => void;
  simulationWallet: SimulationWalletState;
  simulationSyncState: SimulationSyncState;
  onSimulationEnabledChange: (enabled: boolean) => void;
  onResetSimulationWallet: () => void;
  apiAccessToken: string;
  onApiAccessTokenChange: (token: string) => void;
}) {
  const keyboard = useKeyboard();
  const [symbolDraft, setSymbolDraft] = useState(freeSymbol);
  const [timeframe, setTimeframe] = useState<MarketInterval>("1h");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataState, setDataState] = useState<DataState>("loading");
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(apiAccessToken);
  const [tokenSaveState, setTokenSaveState] = useState<"idle" | "saving" | "error">("idle");
  const symbol = freeSymbol;
  const selected = assets[symbol] ?? {
    pair: `${symbol}/USDT`,
    price: "0",
    delta: "0%",
    regime: "等待行情",
  };

  useEffect(() => {
    setTokenDraft(apiAccessToken);
  }, [apiAccessToken]);
  const hasFallbackQuote = Boolean(assets[symbol]);
  const fallbackChange = Number(selected.delta.replace("%", ""));
  const price = snapshot?.price ?? Number(selected.price.replace(/,/g, ""));
  const change = snapshot?.change_24h ?? fallbackChange;
  const absoluteChange = price * change / 100;

  useEffect(() => {
    if (mode !== "free") return;
    const controller = new AbortController();
    setDataState("loading");
    setSnapshot(null);
    setCandles([]);

    const refreshMarket = () => {
      // 行情快照与 K 线独立容错，避免单个慢请求把整个后端误报为离线。
      loadMarket(symbol, controller.signal, platform)
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
          setDataState(nextSnapshot.source);
        })
        .catch(() => {
          if (!controller.signal.aborted) setDataState("offline");
        });
      loadCandles(symbol, timeframe, 80, controller.signal, platform)
        .then(setCandles)
        .catch(() => undefined);
    };
    refreshMarket();
    // 后端恢复后自动重新连接，避免用户停留在降级状态。
    const intervalId = window.setInterval(refreshMarket, 30_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [mode, platform, symbol, timeframe]);

  useEffect(() => {
    if (mode !== "free") return;
    const controller = new AbortController();
    setAnalysis(null);

    const refreshAnalysis = () => {
      loadAnalysis(symbol, timeframe, controller.signal, platform)
        .then(setAnalysis)
        .catch(() => {
          if (controller.signal.aborted) return;
          setAnalysis(null);
        });
    };
    refreshAnalysis();
    const intervalId = window.setInterval(refreshAnalysis, 60_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [mode, platform, symbol, timeframe]);

  const direction = analysis?.direction ?? "WAIT";
  const confidence = analysis?.confidence ?? 0;
  const entryRange = analysis?.entry_range.map(formatPrice).join("–") ?? "--";
  const stopLoss = analysis ? formatPrice(analysis.stop_loss) : "--";
  const takeProfit = analysis?.take_profit.map(formatPrice).join(" / ") ?? "--";

  const selectFreeSymbol = (nextSymbol: string) => {
    // 币种只允许字母和数字，保持与后端接口的校验规则一致。
    const normalized = nextSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) return;
    setSymbolDraft(normalized);
    onFreeSymbolChange(normalized);
  };

  return (
    <>
      <AppHeader
        dataState={dataState}
        platform={platform}
        simulationEnabled={simulationWallet.enabled}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <BottomSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="设置"
        description="管理行情来源与自动模拟交易；模拟数据同步到数据库，不读取真实钱包交易历史"
      >
        <div className="settings-section-title"><strong>后端访问</strong><span>{apiAccessToken ? "已授权" : "未授权"}</span></div>
        <div className="api-token-settings-card">
          <KeyboardInput
            aria-label="个人后端访问令牌"
            type="password"
            value={tokenDraft}
            placeholder="输入 OWNER_API_TOKEN"
            onChange={(event) => setTokenDraft(event.target.value)}
          />
          <button
            type="button"
            disabled={tokenSaveState === "saving"}
            onClick={() => void (async () => {
              const nextToken = tokenDraft.trim();
              setTokenSaveState("saving");
              try {
                await setApiAccessToken(nextToken);
                onApiAccessTokenChange(nextToken);
                setTokenSaveState("idle");
              } catch {
                setTokenSaveState("error");
              }
            })()}
          >
            {tokenSaveState === "saving" ? "保存中…" : tokenDraft.trim() ? "安全保存令牌" : "清除令牌"}
          </button>
          <small className={tokenSaveState === "error" ? "error" : ""}>
            {tokenSaveState === "error" ? "安全存储操作失败，请重试" : "Android 使用系统 Keystore 加密持久化；网页端仅保存当前会话。"}
          </small>
        </div>
        <div className="settings-section-title"><strong>模拟交易</strong><span>{simulationSyncState === "synced" ? "数据库已同步" : simulationSyncState === "offline" ? "离线缓存" : simulationSyncState === "saving" ? "正在保存" : "正在读取"}</span></div>
        <div className={`simulation-settings-card ${simulationWallet.enabled ? "active" : ""}`}>
          <div>
            <strong>自动模拟交易</strong>
            <span>发现可执行机会后自动入场，最多并行三笔，按止盈止损结算</span>
          </div>
          <button
            className="simulation-toggle"
            type="button"
            role="switch"
            aria-checked={simulationWallet.enabled}
            disabled={simulationWallet.activeTrades.length > 0}
            onClick={() => onSimulationEnabledChange(!simulationWallet.enabled)}
          >
            <i />
            {simulationWallet.enabled ? "已开启" : "已关闭"}
          </button>
          <div className="simulation-wallet-summary">
            <span>模拟钱包余额</span>
            <strong>{formatUsdc(simulationWallet.balance)}</strong>
            <small>{simulationWallet.activeTrades.length > 0 ? `当前平台有模拟交易执行中（${simulationWallet.activeTrades.length} 笔），可切换平台，暂不可关闭或重置` : `默认 ${DEFAULT_SIMULATION_BALANCE} USDC · 仅统计盈亏，不限制开仓资金`}</small>
          </div>
          <button
            className="simulation-reset-button"
            type="button"
            disabled={simulationWallet.activeTrades.length > 0}
            onClick={onResetSimulationWallet}
          >
            重置为 1000 USDC
          </button>
        </div>
        <div className="settings-section-title"><strong>行情平台</strong><span>公开永续合约行情</span></div>
        <div className="platform-option-list" role="radiogroup" aria-label="选择行情平台">
          {(Object.keys(marketPlatformLabels) as MarketPlatform[]).map((item) => (
            <button
              className={platform === item ? "active" : ""}
              type="button"
              role="radio"
              aria-checked={platform === item}
              onClick={() => {
                onPlatformChange(item);
                setSettingsOpen(false);
              }}
              key={item}
            >
              <span><strong>{marketPlatformLabels[item]}</strong><small>公开永续合约行情 · 无需 API Key</small></span>
              <i>{platform === item ? "使用中" : "切换"}</i>
            </button>
          ))}
        </div>
      </BottomSheet>
      <section className="market-mode-panel" aria-label="K 线查看模式">
        <div className="market-mode-switcher">
          <button
            type="button"
            aria-pressed={mode === "free"}
            className={mode === "free" ? "active" : ""}
            onClick={() => onModeChange("free")}
          >
            自由
          </button>
          <button
            type="button"
            aria-pressed={mode === "decision"}
            className={mode === "decision" ? "active" : ""}
            onClick={() => onModeChange("decision")}
          >
            决策
          </button>
        </div>
        {mode === "free" ? (
          <form
            className="market-symbol-search"
            onSubmit={(event) => {
              event.preventDefault();
              selectFreeSymbol(symbolDraft);
              keyboard.hide();
            }}
          >
            <KeyboardInput
              aria-label="搜索币种"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={32}
              placeholder="搜索币种，如 DOGE"
              value={symbolDraft}
              onChange={(event) => setSymbolDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            />
            <button type="submit">查看</button>
          </form>
        ) : (
          <div className="decision-market-sync">
            <span>跟随决策页</span>
            <strong>{decisionSelections.slice(0, 4).length} 项决策</strong>
            <em>分别展示对应币种 K 线</em>
          </div>
        )}
      </section>
      {mode === "decision" ? (
        <section className="decision-market-list" aria-label="四项决策币种 K 线">
          <div className="decision-market-list-header">
            <div><strong>决策币种 K 线</strong><span>同步决策页当前前四项机会</span></div>
            <em>{decisionSelections.slice(0, 4).length}/4</em>
          </div>
          {decisionSelections.slice(0, 4).map((selection) => (
            <DecisionMarketChartCard selection={selection} platform={platform} key={`${selection.symbol}-${selection.timeframe}`} />
          ))}
        </section>
      ) : (
        <>
        <div className="asset-switcher" role="tablist" aria-label="快捷切换币种">
          {(Object.keys(assets) as AssetSymbol[]).map((asset) => (
            <button
              type="button"
              role="tab"
              aria-selected={symbol === asset}
              className={symbol === asset ? "active" : ""}
              onClick={() => selectFreeSymbol(asset)}
              key={asset}
            >
              {asset}
            </button>
          ))}
        </div>
      <section className="quote-section" aria-labelledby="quote-title">
        <div className="quote-copy">
          <div className="quote-pair" id="quote-title">{selected.pair}<span>{symbol === "BTC" ? "比特币" : "永续合约"}</span></div>
          <div className="quote-price">{snapshot || hasFallbackQuote ? formatPrice(price) : "--"}</div>
          <div className={`quote-delta ${change < 0 ? "negative" : ""}`}>
            {absoluteChange >= 0 ? "+" : ""}{formatPrice(absoluteChange)} <strong>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</strong><span>24h 变化</span>
          </div>
        </div>
        <div className="regime-block">
          <span>市场状态</span>
          <strong>{getMarketRegime(snapshot, selected.regime)}</strong>
          <p>{change >= 0 ? "趋势延续 · 多头占优" : "动能回落 · 注意风险"}</p>
        </div>
      </section>
      <section className="market-facts" aria-label="市场关键指标">
        <div><span>24h 成交额</span><strong>{formatCompact(snapshot?.volume)}</strong></div>
        <div><span>资金费率</span><strong>{snapshot ? `${snapshot.funding_rate.toFixed(4)}%` : "--"}</strong></div>
        <div><span>未平仓量</span><strong>{formatCompact(snapshot?.open_interest)}</strong></div>
      </section>
      <section className="chart-section" aria-label="行情图表">
        <div className="chart-toolbar">
          <div className="timeframes" aria-label="K 线周期">
            {(["1m", "5m", "1h", "4h", "1d"] as MarketInterval[]).map((item) => (
              <button type="button" className={timeframe === item ? "active" : ""} onClick={() => setTimeframe(item)} key={item}>{item}</button>
            ))}
          </div>
          <div className="indicator-labels"><span>MA(20)</span><span>MACD</span></div>
        </div>
        <MarketChart symbol={symbol} interval={timeframe} candles={candles} />
      </section>
      <section className="decision-card" aria-labelledby="decision-title">
        <div className="section-heading">
          <h2 id="decision-title">AI 决策 <small>{analysis ? "已更新" : "未生成"}</small></h2>
          <div className="confidence"><span>置信度</span><strong>{confidence}%</strong><i><b style={{ width: `${confidence}%` }} /></i></div>
        </div>
        <div className="decision-summary">
          <div className={`wait-state ${direction.toLowerCase()}`}><strong>{directionLabels[direction]}</strong><span>{direction}</span></div>
          <p>{analysis?.reasons[0] ?? "AI 决策暂不可用；系统不会使用本地规则生成替代结论。"}</p>
        </div>
        <div className="decision-metrics">
          <div><span>入场区间</span><strong>{entryRange}</strong></div>
          <div><span>止损</span><strong className="loss">{stopLoss}</strong></div>
          <div><span>止盈目标</span><strong>{takeProfit}</strong></div>
          <div><span>建议杠杆</span><strong>{analysis ? `${analysis.leverage}×` : "--"}</strong></div>
          <div><span>风险等级</span><strong className="risk">{analysis ? riskLabels[analysis.risk] : "未生成"}</strong></div>
        </div>
        <div className="decision-actions">
          <button type="button" className="primary-button" onClick={() => openDetails(analysis, symbol, timeframe)}><ActivityLogIcon />查看完整依据<ChevronRightIcon /></button>
          <button type="button" className="icon-button" aria-label="加入自选"><BookmarkIcon /></button>
        </div>
      </section>
      <section className="catalyst-section" aria-labelledby="catalyst-title">
        <div className="section-heading compact"><h2 id="catalyst-title">下一个重要催化</h2><button type="button">查看全部<ChevronRightIcon /></button></div>
        <div className="catalyst-row">
          <time>20:30</time><i /><div><strong>美国 CPI 数据公布</strong><span>预期 2.7% · 高影响</span></div><BellIcon />
        </div>
      </section>
        </>
      )}
    </>
  );
}

function getOpportunity(score: number) {
  if (score >= 90) return { label: "强交易机会", tone: "strong", hint: "信号完整，仍需按计划控制风险" };
  if (score >= 70) return { label: "可交易", tone: "tradable", hint: "条件基本成立，等待进入计划区间" };
  if (score >= 50) return { label: "观察", tone: "watch", hint: "证据不足，暂不执行" };
  return { label: "禁止交易", tone: "blocked", hint: "风险或结构不满足开仓要求" };
}

function DecisionScreen({
  openDetails,
  lockedDecision,
  activeDecisions,
  onMarketSelectionsChange,
  platform,
  simulationEnabled,
  simulationBalance,
  onStartExecution,
  onCancelExecution,
  onContinueScanning,
}: {
  openDetails: (analysis: AnalysisResponse | null, symbol: AssetSymbol, timeframe: MarketInterval) => void;
  lockedDecision: LockedDecision | null;
  activeDecisions: LockedDecision[];
  onMarketSelectionsChange: (selections: DecisionMarketSelection[]) => void;
  platform: MarketPlatform;
  simulationEnabled: boolean;
  simulationBalance: number;
  onStartExecution: (analysis: AnalysisResponse, timeframe: MarketInterval, totalAmount: number) => Promise<LockedDecision>;
  onCancelExecution: (decision: LockedDecision) => Promise<void>;
  onContinueScanning: () => void;
}) {
  const [symbol, setSymbol] = useState<AssetSymbol | null>(lockedDecision?.analysis.symbol ?? null);
  const [timeframe, setTimeframe] = useState<MarketInterval>(lockedDecision?.timeframe ?? "4h");
  const [candidates, setCandidates] = useState<AnalysisResponse[]>([]);
  const [scanStats, setScanStats] = useState({ scanned: 0, eligible: 0 });
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanRetry, setScanRetry] = useState(0);
  const [selectionMode, setSelectionMode] = useState<"auto" | "manual">("auto");
  const [remoteState, setRemoteState] = useState<RemoteState>("loading");
  const [totalAmount, setTotalAmount] = useState(10_000);
  const [amountDraft, setAmountDraft] = useState("10000");
  const [capitalState, setCapitalState] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [executionConfirmationOpen, setExecutionConfirmationOpen] = useState(false);
  const [executionMutationState, setExecutionMutationState] = useState<"idle" | "saving" | "error">("idle");
  const activeSymbol = symbol ?? lockedDecision?.analysis.symbol ?? candidates[0]?.symbol ?? "BTC";
  const activeDecision = activeDecisions.find((item) => item.analysis.symbol === activeSymbol) ?? null;
  const isExecuting = activeDecision !== null;
  const selectedTimeframe = activeDecision?.timeframe ?? timeframe;
  const executionLimitReached = !isExecuting && activeDecisions.length >= MAX_ACTIVE_DECISIONS;
  const activeDecisionKey = activeDecisions.map((item) => item.decisionId).join("|");
  const formatCapital = simulationEnabled ? formatUsdc : formatMoney;

  useEffect(() => {
    if (simulationEnabled) {
      setTotalAmount(simulationBalance);
      setAmountDraft(String(simulationBalance));
      setCapitalState("ready");
      return;
    }
    const controller = new AbortController();
    loadCapitalSettings(controller.signal)
      .then((settings) => {
        setTotalAmount(settings.total_amount);
        setAmountDraft(String(settings.total_amount));
        setCapitalState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setCapitalState("error");
      });
    return () => controller.abort();
  }, [simulationBalance, simulationEnabled]);

  useEffect(() => {
    const controller = new AbortController();
    setRemoteState("loading");
    setScanError(null);

    const refresh = () => {
      loadOpportunities(timeframe, controller.signal, platform)
        .then((scan) => {
          const results = scan.opportunities;
          setScanStats({ scanned: scan.scanned_markets, eligible: scan.eligible_markets });
          if (results.length === 0) {
            setCandidates([]);
            setScanError("当前没有通过流动性筛选的市场");
            setRemoteState("offline");
            return;
          }
          setScanError(null);
          setCandidates(results);
          setSymbol((current) => {
            const currentSymbol = current ?? lockedDecision?.analysis.symbol;
            if (currentSymbol && activeDecisions.some((item) => item.analysis.symbol === currentSymbol)) {
              return currentSymbol;
            }
            return selectionMode === "auto" || currentSymbol == null ? results[0].symbol : currentSymbol;
          });
          setRemoteState("ready");
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setCandidates([]);
            setScanStats({ scanned: 0, eligible: 0 });
            setScanError(error instanceof Error ? error.message : "机会扫描暂时不可用");
            setRemoteState("offline");
          }
        });
    };
    refresh();
    const intervalId = window.setInterval(refresh, 30_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [activeDecisionKey, lockedDecision, platform, scanRetry, selectionMode, timeframe, totalAmount]);

  const analysis = activeDecision?.analysis ?? candidates.find((item) => item.symbol === activeSymbol) ?? null;
  const visibleCandidates = candidates.slice(0, 4);

  useEffect(() => {
    if (candidates.length === 0) return;
    onMarketSelectionsChange(candidates.slice(0, 4).map((candidate) => ({
      symbol: candidate.symbol,
      timeframe,
      score: candidate.score,
      direction: candidate.direction,
    })));
  }, [candidates, onMarketSelectionsChange, timeframe]);

  const fallbackBreakdown = { trend: 0, structure: 0, capital: 0, macro: 0, news: 0 };
  const breakdown = analysis?.score_breakdown ?? fallbackBreakdown;
  const score = analysis?.score ?? Object.values(fallbackBreakdown).reduce((sum, value) => sum + value, 0);
  const confidence = analysis?.confidence ?? 0;
  const direction = analysis?.direction ?? "WAIT";
  const opportunity = getOpportunity(score);
  const entryRange = analysis?.entry_range ?? [0, 0];
  const stopLoss = analysis?.stop_loss ?? 0;
  const takeProfit = analysis?.take_profit ?? [0, 0];
  const leverage = analysis?.leverage ?? 0;
  const positionSizing = analysis?.position_sizing;
  const plannedAllocation = positionSizing?.margin_amount ?? 0;
  const currentAllocation = activeDecision?.allocatedAmount
    ?? (simulationEnabled ? plannedAllocation || DEFAULT_SIMULATION_BALANCE * 0.1 : plannedAllocation);
  const nominalExposure = simulationEnabled || activeDecision
    ? currentAllocation * leverage
    : positionSizing?.position_value ?? currentAllocation * leverage;
  const maxLossAmount = positionSizing?.max_loss_amount ?? 0;
  const stopDistancePercent = (positionSizing?.stop_distance_rate ?? 0) * 100;
  const riskBudgetPercent = (positionSizing?.risk_budget_rate ?? 0) * 100;
  const risk = analysis ? riskLabels[analysis.risk] : "未生成";
  const entryMid = (entryRange[0] + entryRange[1]) / 2;
  const riskDistance = Math.abs(entryMid - stopLoss);
  const rewardDistance = Math.abs(takeProfit[0] - entryMid);
  const rewardRisk = riskDistance > 0 ? (rewardDistance / riskDistance).toFixed(1) : "--";
  const entryRangeLabel = analysis ? entryRange.map(formatPrice).join(" – ") : "--";
  const stopLossLabel = analysis ? formatPrice(stopLoss) : "--";
  const takeProfitLabels = analysis ? takeProfit.map(formatPrice) : ["--", "--"];
  const strategyParameters = analysis?.strategy_parameters;
  const scoreItems: Array<[keyof typeof breakdown, string, number]> = [
    ["trend", "趋势", strategyParameters?.trend_weight ?? 30],
    ["structure", "技术结构", strategyParameters?.structure_weight ?? 25],
    ["capital", "资金", strategyParameters?.capital_weight ?? 20],
    ["macro", "宏观", strategyParameters?.macro_weight ?? 15],
    ["news", "新闻", strategyParameters?.news_weight ?? 10],
  ];
  const reasons = analysis?.reasons ?? ["AI 决策尚未生成；系统不会使用本地规则替代。"];
  const sourceLabel = isExecuting
    ? "执行快照"
    : remoteState === "loading"
      ? "正在分析"
      : remoteState === "offline"
        ? "分析暂不可用"
        : analysis?.analysis_engine === "openai"
          ? `${analysis.source === "live" ? "实时行情" : "演示行情"} · OpenAI ${analysis.analysis_model ?? "AI"}`
          : "非 AI 决策已拒绝";
  const sourceTone = remoteState === "offline" ? "offline" : analysis?.source === "live" ? "live" : "demo";
  const parsedAmount = Number(amountDraft.replace(/,/g, ""));
  const amountIsValid = Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount <= 1_000_000_000;

  const persistTotalAmount = async () => {
    if (simulationEnabled || !amountIsValid || capitalState === "saving") return;
    setCapitalState("saving");
    try {
      const settings = await saveCapitalSettings(parsedAmount);
      setTotalAmount(settings.total_amount);
      setAmountDraft(String(settings.total_amount));
      setCapitalState("saved");
    } catch {
      setCapitalState("error");
    }
  };

  const confirmExecution = async () => {
    if (!analysis || direction === "WAIT" || executionLimitReached) return;
    setExecutionMutationState("saving");
    try {
      await onStartExecution(analysis, timeframe, totalAmount);
      setSymbol(analysis.symbol);
      setSelectionMode("manual");
      setExecutionConfirmationOpen(false);
      setExecutionMutationState("idle");
    } catch {
      setExecutionMutationState("error");
    }
  };

  return (
    <>
      <div className="subscreen-header decision-page-header">
        <span>{marketPlatformLabels[platform]} · AI 决策引擎</span>
        <h1>开仓前决策</h1>
        <p>先判断机会质量，再确认执行与风险边界</p>
      </div>

      <section className="opportunity-radar" aria-labelledby="opportunity-radar-title">
        <div className="opportunity-radar-heading">
          <div>
            <strong id="opportunity-radar-title">全市场机会雷达</strong>
            <span>{remoteState === "offline" ? "扫描未完成 · 可手动重试" : scanStats.scanned > 0 ? `已扫描 ${scanStats.scanned} 个市场 · ${scanStats.eligible} 个通过流动性筛选` : "正在读取全部永续合约市场"}</span>
          </div>
          <button
            type="button"
            aria-pressed={selectionMode === "auto"}
            className={selectionMode === "auto" ? "active" : ""}
            onClick={() => {
              setSelectionMode("auto");
              setSymbol(candidates[0]?.symbol ?? null);
            }}
          >
            {selectionMode === "auto" ? "自动跟随" : "恢复智能优选"}
          </button>
        </div>
        <div className="opportunity-switcher" role="tablist" aria-label="AI 机会排名">
          {visibleCandidates.length > 0 ? visibleCandidates.map((candidate, index) => {
            const candidateIsExecuting = activeDecisions.some((item) => item.analysis.symbol === candidate.symbol);
            return (
              <button
                type="button"
                role="tab"
                aria-selected={activeSymbol === candidate.symbol}
                className={[activeSymbol === candidate.symbol ? "active" : "", candidateIsExecuting ? "executing" : ""].filter(Boolean).join(" ")}
                onClick={() => {
                  setSymbol(candidate.symbol);
                  setSelectionMode("manual");
                }}
                key={candidate.symbol}
              >
                <span><small>#{index + 1}</small><strong>{candidate.symbol}</strong></span>
                <em>{candidateIsExecuting ? "执行中 · 快照已锁定" : `${candidate.score} · ${candidate.direction}`} </em>
              </button>
            );
          }) : remoteState === "offline" ? (
            <div className="opportunity-loading error" role="alert">
              <span>{scanError ?? "机会扫描暂时不可用"}</span>
              <button type="button" onClick={() => setScanRetry((current) => current + 1)}>重新扫描</button>
            </div>
          ) : <div className="opportunity-loading">正在等待 AI 扫描并计算完整决策…</div>}
        </div>
      </section>

      <section className="capital-settings-card" aria-labelledby="capital-settings-title">
        <div className="capital-settings-heading">
          <div><strong id="capital-settings-title">三向资金预算</strong><span>{simulationEnabled ? "自动记录最多 3 个有效币种方向" : "最多同时配置 3 个有效币种方向"}</span></div>
          <em>{simulationEnabled ? "模拟资金不限额" : "至少保留 10%"}</em>
        </div>
        <div className="capital-editor">
          <label htmlFor="total-capital">
            <span>{simulationEnabled ? "账户净值" : "总金额"}</span>
            <div><KeyboardInput
              id="total-capital"
              aria-label="总金额（USDT）"
              inputMode="decimal"
              disabled={simulationEnabled}
              value={amountDraft}
              onChange={(event) => setAmountDraft(event.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter") void persistTotalAmount();
              }}
            /><b>USDT</b></div>
          </label>
          <button type="button" disabled={simulationEnabled || !amountIsValid || capitalState === "saving"} onClick={() => void persistTotalAmount()}>
            {simulationEnabled ? "模拟钱包" : capitalState === "saving" ? "保存中" : "保存"}
          </button>
        </div>
        <small className={capitalState === "error" ? "error" : ""}>
          {simulationEnabled ? "模拟净值仅用于累计盈亏与复盘，不限制单笔或总开仓资金" : capitalState === "loading" ? "正在读取资金设置" : capitalState === "saved" ? "总金额已保存，正在重新计算仓位" : capitalState === "error" ? "保存失败，请检查后端连接" : "按风险预算与止损距离反推投入资金"}
        </small>
        <div className="capital-budget-summary" aria-label="资金预算规则">
          {simulationEnabled ? (
            <>
              <div><span>执行方式<small>发现机会自动开仓</small></span><strong>自动</strong></div>
              <div><span>机会门槛<small>评分与方向有效</small></span><strong>≥ 70</strong></div>
              <div><span>并行上限<small>独立止盈止损</small></span><strong>{MAX_ACTIVE_DECISIONS} 笔</strong></div>
              <div><span>资金限制<small>仅记录计划金额</small></span><strong>无限制</strong></div>
            </>
          ) : (
            <>
              <div><span>高风险预算<small>总资金 0.5%</small></span><strong>{formatCapital(totalAmount * 0.005)}</strong></div>
              <div><span>中风险预算<small>总资金 0.75%</small></span><strong>{formatCapital(totalAmount * 0.0075)}</strong></div>
              <div><span>低风险预算<small>总资金 1%</small></span><strong>{formatCapital(totalAmount * 0.01)}</strong></div>
              <div><span>保证金上限<small>单笔最多 30%</small></span><strong>{formatCapital(totalAmount * 0.3)}</strong></div>
            </>
          )}
        </div>
      </section>

      <div className="decision-filter-row">
        <div><strong>{activeSymbol}-PERP</strong><span>{isExecuting ? "决策执行中" : selectionMode === "auto" ? "AI 当前优选" : "手动查看"}</span></div>
        <div className="timeframes" aria-label="选择分析周期">
          {(["1m", "5m", "1h", "4h", "1d"] as MarketInterval[]).map((item) => (
            <button
              type="button"
              aria-pressed={selectedTimeframe === item}
              className={selectedTimeframe === item ? "active" : ""}
              disabled={isExecuting}
              onClick={() => {
                setTimeframe(item);
                // 手动切换周期时保留当前币种，避免回退到另一条已锁定决策。
                setSelectionMode("manual");
              }}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <section className="decision-overview" aria-labelledby="decision-overview-title">
        <div className="decision-overview-top">
          <div><span id="decision-overview-title">本次判断</span><em className={`source-status ${sourceTone}`}>{sourceLabel}</em></div>
          <strong className={`opportunity-badge ${opportunity.tone}`}>{opportunity.label}</strong>
        </div>
        <div className="decision-hero-grid">
          <div className={`decision-direction ${direction.toLowerCase()}`}>
            <span>方向</span><strong>{directionLabels[direction]}</strong><small>{direction}</small>
          </div>
          <div className="decision-score">
            <span>机会评分</span><strong>{score}<small>/100</small></strong><p>{opportunity.hint}</p>
          </div>
        </div>
        <div className="decision-confidence-row">
          <span>模型置信度</span><i><b style={{ width: `${confidence}%` }} /></i><strong>{confidence}%</strong>
        </div>
      </section>

      <section className="decision-detail-card" aria-labelledby="execution-plan-title">
        <div className="decision-section-title"><div><span>01</span><h2 id="execution-plan-title">执行计划</h2></div><em>手动确认后执行</em></div>
        <div className="execution-grid">
          <div className="wide"><span>建议入场区间</span><strong>{entryRangeLabel}</strong></div>
          <div><span>结构止损</span><strong className="loss">{stopLossLabel}</strong></div>
          <div><span>建议杠杆</span><strong>{leverage}×</strong></div>
          <div><span>止盈目标 1</span><strong>{takeProfitLabels[0]}</strong></div>
          <div><span>止盈目标 2</span><strong>{takeProfitLabels[1]}</strong></div>
          <div><span>目标盈亏比</span><strong>1 : {rewardRisk}</strong></div>
          <div><span>风险等级</span><strong className="risk">{risk}</strong></div>
          <div className="capital-result">
            <span>本次投入资金<small>{isExecuting ? "执行快照已锁定" : direction === "WAIT" ? "等待信号，不投入" : `开仓价值 ÷ ${leverage} 倍杠杆`}</small></span>
            <strong>{formatCapital(currentAllocation)}</strong>
          </div>
          <div className="capital-result">
            <span>开仓总价值<small>{direction === "WAIT" ? "等待信号，不开仓" : `${riskBudgetPercent.toFixed(2)}% 风险预算 ÷ ${stopDistancePercent.toFixed(2)}% 止损`}</small></span>
            <strong>{formatCapital(nominalExposure)}</strong>
          </div>
          <div className="wide capital-risk-note">
            <span>最大计划亏损</span><strong>{formatCapital(maxLossAmount)}</strong>
          </div>
        </div>
        <div className={`decision-execution-control ${isExecuting ? "executing" : ""}`}>
          <div>
            <strong>{isExecuting ? `${activeSymbol} 决策执行中` : `执行 ${activeSymbol} 决策`}</strong>
            <span>{isExecuting
              ? `仅当前币种、周期与决策快照已锁定；当前 ${activeDecisions.length}/${MAX_ACTIVE_DECISIONS} 个执行中`
              : executionLimitReached
                ? `已达到最多 ${MAX_ACTIVE_DECISIONS} 个同时执行的上限，请先结束一个决策`
                : simulationEnabled ? "可执行机会会自动模拟开仓，不限制总资金，并按止盈止损独立结算" : "开始后固定本次决策；仅用于执行跟踪，不会自动下单"}</span>
          </div>
          <button
            type="button"
            aria-pressed={isExecuting}
            disabled={!analysis || executionLimitReached || (!isExecuting && direction === "WAIT")}
            onClick={() => void (async () => {
              if (activeDecision) {
                setExecutionMutationState("saving");
                try {
                  await onCancelExecution(activeDecision);
                  setSelectionMode("auto");
                  setSymbol(candidates[0]?.symbol ?? null);
                  setExecutionMutationState("idle");
                } catch {
                  setExecutionMutationState("error");
                }
                return;
              }
              setExecutionConfirmationOpen(true);
            })()}
          >
            <LockClosedIcon />
            {isExecuting ? "结束当前决策" : executionLimitReached ? `已达 ${MAX_ACTIVE_DECISIONS} 个执行上限` : `开始执行 ${activeSymbol}`}
          </button>
          {isExecuting && !simulationEnabled && (
            <button
              type="button"
              className="continue-scanning-button"
              onClick={() => {
                onContinueScanning();
                setSelectionMode("auto");
                setSymbol(candidates[0]?.symbol ?? null);
              }}
            >继续添加其他币种</button>
          )}
        </div>
      </section>

      <BottomSheet
        open={executionConfirmationOpen}
        onOpenChange={setExecutionConfirmationOpen}
        title="确认开始执行"
        description={`${activeSymbol}-PERP · ${directionLabels[direction]} · ${selectedTimeframe}`}
      >
        <div className="execution-confirm-summary">
          <div><span>本次投入资金</span><strong>{formatCapital(currentAllocation)}</strong></div>
          <div><span>开仓总价值</span><strong>{formatCapital(nominalExposure)}</strong></div>
          <div><span>建议杠杆</span><strong>{leverage}×</strong></div>
          <div><span>最大计划亏损</span><strong className="loss">{formatCapital(maxLossAmount)}</strong></div>
        </div>
        <div className="execution-confirm-risk">
          <strong>请确认风险边界</strong>
          <span>计划入场 {entryRangeLabel} · 结构止损 {stopLossLabel}</span>
          <small>{simulationEnabled ? "确认后按计划中间价模拟开仓，触发首个止盈或止损时自动结算盈亏。" : "确认后将固定当前决策并同步到持仓页，仅用于执行跟踪，不会向交易所下单。"}</small>
        </div>
        <div className="execution-confirm-actions">
          <button type="button" onClick={() => setExecutionConfirmationOpen(false)}>取消</button>
          <button type="button" disabled={executionMutationState === "saving" || executionLimitReached} onClick={() => void confirmExecution()}>
            {executionMutationState === "saving" ? "保存中…" : "确认开始执行"}
          </button>
        </div>
        {executionMutationState === "error" && <small className="execution-save-error">保存失败，请检查后端连接、资金余额或并行执行数量。</small>}
      </BottomSheet>

      <section className="decision-detail-card" aria-labelledby="score-breakdown-title">
        <div className="decision-section-title"><div><span>02</span><h2 id="score-breakdown-title">五维评分</h2></div><em>策略 {analysis?.strategy_version ?? "v1"}</em></div>
        <div className="score-breakdown">
          {scoreItems.map(([key, label, max]) => (
            <div className="score-row" key={key}>
              <span>{label}</span><i><b style={{ width: `${(breakdown[key] / max) * 100}%` }} /></i><strong>{breakdown[key]}<small>/{max}</small></strong>
            </div>
          ))}
        </div>
        {analysis?.indicators && (
          <div className="technical-indicator-grid" aria-label="实时技术指标">
            <div><span>EMA 20 / 50 / 200</span><strong>{[analysis.indicators.ema20, analysis.indicators.ema50, analysis.indicators.ema200].map((value) => value === null ? "--" : formatPrice(value)).join(" / ")}</strong></div>
            <div><span>RSI 14</span><strong>{analysis.indicators.rsi14?.toFixed(2) ?? "--"}</strong></div>
            <div><span>MACD 柱</span><strong>{analysis.indicators.macd_histogram === null ? "--" : formatPrice(analysis.indicators.macd_histogram)}</strong></div>
            <div><span>ATR 14</span><strong>{analysis.indicators.atr_percent?.toFixed(2) ?? "--"}%</strong></div>
          </div>
        )}
      </section>

      <section className="decision-detail-card" aria-labelledby="evidence-title">
        <div className="decision-section-title"><div><span>03</span><h2 id="evidence-title">判断依据</h2></div><em>可解释决策</em></div>
        <div className="decision-reasons">
          {reasons.map((reason, index) => <p key={reason}><span>{index + 1}</span>{reason}</p>)}
        </div>
        <button type="button" className="primary-button decision-evidence-button" onClick={() => openDetails(analysis, activeSymbol, selectedTimeframe)}>
          <ActivityLogIcon />查看完整依据<ChevronRightIcon />
        </button>
      </section>

      <section className="decision-detail-card invalidation-card" aria-labelledby="invalidation-title">
        <div className="decision-section-title"><div><span>04</span><h2 id="invalidation-title">失效与重评条件</h2></div><em>先定义退出</em></div>
        <div className="invalidation-list">
          <p>价格触及结构止损 {stopLossLabel}，当前计划立即失效</p>
          <p>综合评分低于 70 分，进入观察区并禁止新增交易</p>
          <p>政策、央行或黑天鹅事件出现时，重新生成决策</p>
        </div>
      </section>

      <div className="readonly-footer"><LockClosedIcon /> {analysis?.disclaimer ?? "仅供研究与辅助决策 · 不会自动下单"}</div>
    </>
  );
}

function SecondaryScreen({
  tab,
  lockedDecision,
  activeDecisions,
  completedTrades,
  reviews,
  onOpenDecision,
  onCompletePosition,
  onSelectDecision,
  platform,
  simulationWallet,
  simulationSyncState,
}: {
  tab: Exclude<TabId, "market" | "decision">;
  lockedDecision: LockedDecision | null;
  activeDecisions: LockedDecision[];
  completedTrades: CompletedTradeRecord[];
  reviews: ReviewRecord[];
  onOpenDecision: () => void;
  onCompletePosition: (decision: LockedDecision) => Promise<void>;
  onSelectDecision: (decision: LockedDecision) => void;
  platform: MarketPlatform;
  simulationWallet: SimulationWalletState;
  simulationSyncState: SimulationSyncState;
}) {
  const info = tabLabels[tab];
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsDate, setNewsDate] = useState(() => formatLocalDate(new Date()));
  const [newsTotal, setNewsTotal] = useState(0);
  const [remoteState, setRemoteState] = useState<RemoteState>("idle");
  const [walletDraft, setWalletDraft] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletSnapshot, setWalletSnapshot] = useState<WalletSnapshot | null>(null);
  const [walletState, setWalletState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [walletError, setWalletError] = useState("");
  const [credentialApiKey, setCredentialApiKey] = useState("");
  const [credentialSecret, setCredentialSecret] = useState("");
  const [credentialPassphrase, setCredentialPassphrase] = useState("");
  const [completionState, setCompletionState] = useState<"idle" | "loading" | "error">("idle");
  const [positionMonitors, setPositionMonitors] = useState<PositionMonitor[]>([]);

  useEffect(() => {
    if (tab !== "positions" || simulationWallet.enabled) {
      setPositionMonitors([]);
      return;
    }
    const controller = new AbortController();
    const refresh = () => loadPositionMonitors(controller.signal, platform)
      .then(setPositionMonitors)
      .catch(() => undefined);
    refresh();
    const intervalId = window.setInterval(refresh, 30_000);
    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [platform, simulationWallet.enabled, tab]);

  useEffect(() => {
    if (tab !== "news") {
      setRemoteState("idle");
      return;
    }

    const controller = new AbortController();
    setRemoteState("loading");
    setNewsItems([]);
    loadNews(newsDate, controller.signal, platform)
      .then((archive) => {
        setNewsItems(archive.items);
        setNewsTotal(archive.total);
        setRemoteState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setRemoteState("offline");
      });

    return () => controller.abort();
  }, [newsDate, platform, tab]);

  useEffect(() => {
    if (tab !== "positions" || simulationWallet.enabled) {
      if (simulationWallet.enabled) {
        setWalletState("idle");
        setWalletSnapshot(null);
        setWalletAddress("");
        setWalletError("");
      }
      return;
    }
    const controller = new AbortController();
    setWalletState("loading");
    setWalletSnapshot(null);
    setWalletAddress("");
    setWalletError("");
    if (platform !== "hyperliquid") {
      const privatePlatform = platform;
      loadPlatformCredentialStatus(privatePlatform, controller.signal)
        .then((status) => {
          if (!status.configured) {
            setWalletState("idle");
            return;
          }
          setWalletAddress(status.api_key_hint ?? "已配置");
          return loadPlatformAccount(
            privatePlatform,
            lockedDecision?.analysis.symbol,
            controller.signal,
          ).then((snapshot) => {
            setWalletSnapshot(snapshot);
            setWalletState(snapshot.source === "live" ? "ready" : "error");
            if (snapshot.error) setWalletError(snapshot.error);
          });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setWalletState("error");
            setWalletError(error instanceof Error ? error.message : "只读账户同步失败。");
          }
        });
      return () => controller.abort();
    }
    loadWalletSettings(controller.signal)
      .then((settings) => {
        if (!settings) {
          setWalletState("idle");
          return;
        }
        setWalletAddress(settings.address);
        setWalletDraft(settings.address);
        return loadWallet(settings.address, controller.signal).then((snapshot) => {
          setWalletSnapshot(snapshot);
          setWalletState(snapshot.source === "live" ? "ready" : "error");
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setWalletState("error");
      });
    return () => controller.abort();
  }, [lockedDecision?.analysis.symbol, platform, simulationWallet.enabled, tab]);

  const persistWallet = async (address = walletDraft) => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setWalletState("error");
      setWalletError("钱包地址格式不正确，请检查后重试。");
      return;
    }
    setWalletState("loading");
    setWalletError("");
    try {
      const settings = await saveWalletSettings(address);
      const snapshot = await loadWallet(settings.address);
      setWalletAddress(settings.address);
      setWalletDraft(settings.address);
      setWalletSnapshot(snapshot);
      setWalletState(snapshot.source === "live" ? "ready" : "error");
      if (snapshot.source !== "live") {
        setWalletError(snapshot.error ?? "Hyperliquid 数据暂时不可用。");
      }
    } catch {
      setWalletState("error");
      setWalletError("钱包地址保存失败，或 Hyperliquid 数据暂时不可用。");
    }
  };

  const connectBrowserWallet = async () => {
    const provider = (window as Window & { ethereum?: BrowserWalletProvider }).ethereum;
    setWalletState("loading");
    setWalletError("");
    try {
      let address = "";
      if (provider) {
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        address = Array.isArray(accounts) ? String(accounts[0] ?? "") : "";
      } else {
        const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
        if (!projectId) {
          throw new Error("WALLETCONNECT_NOT_CONFIGURED");
        }
        address = await connectWithWalletConnect(projectId);
      }
      await persistWallet(address);
    } catch (error) {
      const rejected = typeof error === "object" && error !== null && "code" in error
        && Number((error as { code?: unknown }).code) === 4001;
      const notConfigured = error instanceof Error && error.message === "WALLETCONNECT_NOT_CONFIGURED";
      setWalletState("error");
      setWalletError(notConfigured
        ? "App 钱包连接尚未配置 Project ID，请暂时填写公开地址。"
        : rejected ? "已取消钱包连接授权。" : "钱包连接失败，请重试或手动填写公开地址。");
    }
  };

  const persistPlatformCredential = async () => {
    if (platform === "hyperliquid") return;
    if (credentialApiKey.trim().length < 4 || credentialSecret.trim().length < 8) {
      setWalletState("error");
      setWalletError("请完整填写 API Key 和 Secret Key。");
      return;
    }
    if (platform === "okx" && !credentialPassphrase.trim()) {
      setWalletState("error");
      setWalletError("OKX 还需要填写 Passphrase。");
      return;
    }
    setWalletState("loading");
    setWalletError("");
    try {
      const status = await savePlatformCredentials(platform, {
        apiKey: credentialApiKey.trim(),
        secretKey: credentialSecret.trim(),
        passphrase: credentialPassphrase.trim(),
      });
      setCredentialApiKey("");
      setCredentialSecret("");
      setCredentialPassphrase("");
      setWalletAddress(status.api_key_hint ?? "已配置");
      const snapshot = await loadPlatformAccount(platform, lockedDecision?.analysis.symbol);
      setWalletSnapshot(snapshot);
      setWalletState(snapshot.source === "live" ? "ready" : "error");
      if (snapshot.error) setWalletError(snapshot.error);
    } catch (error) {
      setCredentialSecret("");
      setCredentialPassphrase("");
      setWalletState("error");
      setWalletError(error instanceof Error ? error.message : "只读凭证保存失败。");
    }
  };

  const completeTrackedPosition = async (decision: LockedDecision) => {
    setCompletionState("loading");
    try {
      await onCompletePosition(decision);
      setCompletionState("idle");
    } catch {
      setCompletionState("error");
    }
  };

  const fallbackContent: Record<Exclude<TabId, "market" | "decision">, string[][]> = {
    news: [["10:12 · 宏观", "美国通胀数据受关注", "短线波动可能放大，关注重要宏观事件"], ["09:46 · 链上", "大额链上资金发生转移", "交易所净流入上升，注意短线供给"], ["08:31 · ETF", "现货 ETF 延续净流入", "机构需求保持韧性"]],
    positions: [],
    review: [],
  };
  let content = fallbackContent[tab];
  if (tab === "news") {
    content = newsItems.map((item) => [
      `${item.published_at} · ${item.source}`,
      item.title,
      `${item.analysis} · 影响 ${item.impact}/5`,
    ]);
  }
  const remoteLabel = { idle: "本地摘要", loading: "正在更新", ready: "后端已更新", offline: "数据暂不可用" }[remoteState];
  const activePosition = lockedDecision?.analysis;
  const positionSizing = activePosition?.position_sizing;
  const startedAt = lockedDecision ? formatDecisionTime(lockedDecision.startedAt) : "";
  const simulatedTrade = lockedDecision
    ? simulationWallet.activeTrades.find((trade) => trade.id === lockedDecision.decisionId) ?? null
    : null;
  const simulatedUnrealizedPnl = simulationWallet.activeTrades.reduce((sum, trade) => sum + trade.unrealizedPnl, 0);
  const simulatedTotalPnl = simulationWallet.history.reduce((sum, trade) => sum + trade.net_pnl, 0);
  const selectedMonitor = lockedDecision
    ? positionMonitors.find((item) => item.position_id === lockedDecision.positionId)
    : undefined;
  const dailyReviews = simulationWallet.enabled
    ? []
    : reviews.filter((review) => review.review_type === "daily");

  return (
    <>
      <div className="subscreen-header"><span>{marketPlatformLabels[platform]} · {info.eyebrow}</span><h1>{info.title}</h1><p>{info.summary}</p></div>
      {tab === "news" && (
        <div className="news-archive-toolbar" aria-label="新闻归档日期">
          <button type="button" onClick={() => setNewsDate((current) => shiftArchiveDate(current, -1))}>‹ 前一天</button>
          <time dateTime={newsDate}>{newsDate}</time>
          <button type="button" disabled={newsDate >= formatLocalDate(new Date())} onClick={() => setNewsDate((current) => shiftArchiveDate(current, 1))}>后一天 ›</button>
        </div>
      )}
      <section className="focus-panel">
        <div className="focus-status">
          <span>{tab === "news" ? newsDate : new Date().toLocaleDateString("zh-CN")} · {tab === "positions" ? "决策同步" : tab === "review" ? "完成交易复盘" : remoteLabel}</span>
          <strong>{tab === "positions" ? activeDecisions.length > 0 ? `${activeDecisions.length} 个执行中` : "暂无执行" : tab === "review" ? `${completedTrades.length} 笔交易 · ${dailyReviews.length} 份日报` : `${newsTotal} 条`}</strong>
        </div>
        {tab === "positions" && (simulationWallet.enabled ? (
          <div className="wallet-live-panel simulation-wallet-panel">
            <div className="wallet-live-heading">
              <div><strong>模拟交易钱包</strong><span>数据库同步 · 不读取真实钱包地址与交易历史</span></div>
              <em className={simulationSyncState === "offline" ? "error" : "live"}>{simulationSyncState === "synced" ? "已同步" : simulationSyncState === "offline" ? "离线缓存" : "同步中"}</em>
            </div>
            <div className="wallet-balance-grid">
              <div><span>钱包余额</span><strong>{formatUsdc(simulationWallet.balance)}</strong></div>
              <div><span>浮动盈亏</span><strong className={simulatedUnrealizedPnl < 0 ? "loss" : "profit"}>{formatUsdc(simulatedUnrealizedPnl)}</strong></div>
              <div><span>累计已结算</span><strong className={simulatedTotalPnl < 0 ? "loss" : "profit"}>{formatUsdc(simulatedTotalPnl)}</strong></div>
            </div>
            <small className="wallet-connected-address">已完成 {simulationWallet.history.length} 笔模拟交易 · 当前平台数据独立保存</small>
          </div>
        ) : (
          <div className="wallet-live-panel">
            <div className="wallet-live-heading">
              <div>
                <strong>{platform === "hyperliquid" ? "Hyperliquid 只读钱包" : `${marketPlatformLabels[platform]} 只读 API`}</strong>
                <span>{platform === "hyperliquid" ? "公开地址查询，不需要私钥或签名" : "仅调用账户、持仓和成交历史接口"}</span>
              </div>
              <em className={walletState === "ready" ? "live" : walletState === "error" ? "error" : ""}>
                {walletState === "loading" ? "同步中" : walletState === "ready" ? "实时" : walletState === "error" ? "不可用" : "未连接"}
              </em>
            </div>
            {platform === "hyperliquid" ? (
              <>
                <button className="wallet-connect-button" type="button" disabled={walletState === "loading"} onClick={() => void connectBrowserWallet()}>
                  {walletState === "loading" ? "正在连接…" : walletAddress ? "切换钱包" : "连接钱包"}
                </button>
                <div className="wallet-divider"><span>或使用公开地址</span></div>
                <div className="wallet-address-editor">
                  <KeyboardInput
                    aria-label="Hyperliquid 钱包地址"
                    placeholder="输入 0x 开头的公开钱包地址"
                    value={walletDraft}
                    onChange={(event) => setWalletDraft(event.target.value.trim())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void persistWallet();
                    }}
                  />
                  <button type="button" disabled={walletState === "loading"} onClick={() => void persistWallet()}>保存并同步</button>
                </div>
              </>
            ) : (
              <div className="credential-editor">
                <KeyboardInput
                  aria-label={`${marketPlatformLabels[platform]} API Key`}
                  autoComplete="off"
                  placeholder="API Key"
                  value={credentialApiKey}
                  onChange={(event) => setCredentialApiKey(event.target.value)}
                />
                <KeyboardInput
                  aria-label={`${marketPlatformLabels[platform]} Secret Key`}
                  autoComplete="new-password"
                  placeholder="Secret Key"
                  type="password"
                  value={credentialSecret}
                  onChange={(event) => setCredentialSecret(event.target.value)}
                />
                {platform === "okx" && (
                  <KeyboardInput
                    aria-label="OKX Passphrase"
                    autoComplete="new-password"
                    placeholder="Passphrase"
                    type="password"
                    value={credentialPassphrase}
                    onChange={(event) => setCredentialPassphrase(event.target.value)}
                  />
                )}
                <button type="button" disabled={walletState === "loading"} onClick={() => void persistPlatformCredential()}>
                  {walletState === "loading" ? "正在验证…" : walletAddress ? "更新凭证并同步" : "保存凭证并同步"}
                </button>
                <small>请创建只读权限密钥，关闭交易与提币权限，并设置 IP 白名单。</small>
              </div>
            )}
            {walletError && <small className="wallet-error" role="alert">{walletError}</small>}
            {walletSnapshot?.source === "live" && (
              <>
                <div className="wallet-balance-grid">
                  <div><span>账户权益</span><strong>{formatMoney(walletSnapshot.equity)}</strong></div>
                  <div><span>可用余额</span><strong>{formatMoney(walletSnapshot.available_balance)}</strong></div>
                  <div><span>未实现盈亏</span><strong className={walletSnapshot.unrealized_pnl < 0 ? "loss" : "profit"}>{formatMoney(walletSnapshot.unrealized_pnl)}</strong></div>
                </div>
                <div className="exchange-data-section">
                  <strong>交易所实际持仓 · {walletSnapshot.positions.length}</strong>
                  {walletSnapshot.positions.length === 0 ? <span>当前没有永续合约持仓</span> : walletSnapshot.positions.map((position, index) => {
                    const size = Number(position.szi ?? 0);
                    return (
                      <div className="exchange-data-row" key={`${position.coin}-${index}`}>
                        <span>{position.coin}-PERP · {size >= 0 ? "多" : "空"}</span>
                        <strong>{Math.abs(size)} @ {formatPrice(Number(position.entryPx ?? 0))}</strong>
                        <small>未实现 {formatMoney(Number(position.unrealizedPnl ?? 0))}</small>
                      </div>
                    );
                  })}
                </div>
                <div className="exchange-data-section">
                  <strong>最近成交 · {walletSnapshot.history.length}</strong>
                  {walletSnapshot.history.slice(0, 5).map((fill, index) => (
                    <div className="exchange-data-row" key={fill.tid ?? fill.hash ?? index}>
                      <span>{fill.coin} · {fill.dir ?? (fill.side === "B" ? "买入" : "卖出")}</span>
                      <strong>{fill.sz} @ {formatPrice(Number(fill.px ?? 0))}</strong>
                      <small>手续费 {formatMoney(Number(fill.fee ?? 0))}</small>
                    </div>
                  ))}
                </div>
              </>
            )}
            {walletAddress && (
              <small className="wallet-connected-address">
                {platform === "hyperliquid" ? `当前地址 ${walletAddress.slice(0, 8)}…${walletAddress.slice(-6)}` : `当前凭证 ${walletAddress}`}
              </small>
            )}
          </div>
        ))}
        {tab === "news" && remoteState === "ready" && content.length === 0 && <div className="news-empty">当天暂无归档新闻</div>}
        {tab === "positions" && activeDecisions.length > 1 && (
          <div className="active-position-switcher" role="tablist" aria-label="执行中持仓">
            {activeDecisions.map((decision) => (
              <button
                type="button"
                role="tab"
                aria-selected={lockedDecision?.decisionId === decision.decisionId}
                className={lockedDecision?.decisionId === decision.decisionId ? "active" : ""}
                onClick={() => onSelectDecision(decision)}
                key={decision.decisionId}
              >
                <strong>{decision.analysis.symbol}</strong>
                <span>{directionLabels[decision.analysis.direction]} · {decision.timeframe}</span>
              </button>
            ))}
          </div>
        )}
        {tab === "positions" && activeDecisions.length === 0 && (
          <div className="position-empty">
            <PieChartIcon />
            <strong>暂无执行中的决策</strong>
            <span>在决策页确认机会并点击开始执行后，计划持仓会同步显示在这里。</span>
            <button type="button" onClick={onOpenDecision}>前往决策页</button>
          </div>
        )}
        {tab === "positions" && lockedDecision && activePosition && (
          <article className="execution-position-card" aria-label={`${activePosition.instrument} 决策持仓`}>
            <div className="position-card-heading">
              <div><span>{activePosition.instrument}</span><strong>{directionLabels[activePosition.direction]} · {activePosition.direction}</strong></div>
              <em>{simulationWallet.enabled ? "自动模拟中" : "执行跟踪中"}</em>
            </div>
            <p className="position-started-at">{startedAt} 开始 · {lockedDecision.timeframe} 周期 · {simulationWallet.enabled ? "模拟订单" : "非交易所订单"}</p>
            <div className="position-value-grid">
              <div><span>本次投入资金</span><strong>{simulationWallet.enabled ? formatUsdc(lockedDecision.allocatedAmount) : formatMoney(lockedDecision.allocatedAmount)}</strong></div>
              <div><span>开仓总价值</span><strong>{simulationWallet.enabled ? formatUsdc(lockedDecision.allocatedAmount * activePosition.leverage) : formatMoney(positionSizing?.position_value ?? lockedDecision.allocatedAmount * activePosition.leverage)}</strong></div>
              <div><span>{simulationWallet.enabled ? "模拟入场价" : "建议杠杆"}</span><strong>{simulationWallet.enabled && simulatedTrade ? formatPrice(simulatedTrade.entryPrice) : `${activePosition.leverage}×`}</strong></div>
              <div><span>{simulationWallet.enabled ? "当前标记价" : "最大计划亏损"}</span><strong className={simulationWallet.enabled && (simulatedTrade?.unrealizedPnl ?? 0) >= 0 ? "profit" : "loss"}>{simulationWallet.enabled && simulatedTrade ? formatPrice(simulatedTrade.latestPrice) : formatMoney(positionSizing?.max_loss_amount ?? 0)}</strong></div>
            </div>
            {simulationWallet.enabled && simulatedTrade && (
              <div className="simulation-pnl-strip">
                <span>当前浮动盈亏</span>
                <strong className={simulatedTrade.unrealizedPnl < 0 ? "loss" : "profit"}>{formatUsdc(simulatedTrade.unrealizedPnl)}</strong>
                <small>每 30 秒检查止盈止损</small>
              </div>
            )}
            <div className="position-levels">
              <div><span>计划入场</span><strong>{activePosition.entry_range.map(formatPrice).join(" – ")}</strong></div>
              <div><span>结构止损</span><strong className="loss">{formatPrice(activePosition.stop_loss)}</strong></div>
              <div><span>止盈目标</span><strong>{activePosition.take_profit.map(formatPrice).join(" / ")}</strong></div>
            </div>
            {!simulationWallet.enabled && selectedMonitor && (
              <div className={`position-monitor-strip ${selectedMonitor.action.toLowerCase()}`}>
                <div><span>动态管理建议</span><strong>{selectedMonitor.action}</strong></div>
                <p>{selectedMonitor.reason}</p>
                <small>评分 {selectedMonitor.opening_score}→{selectedMonitor.current_score} · 标记价 {formatPrice(selectedMonitor.current_price)} · 浮动盈亏 {formatMoney(selectedMonitor.unrealized_pnl)}</small>
              </div>
            )}
            <div className="position-actions">
              {!simulationWallet.enabled && <button type="button" className="position-complete-button" disabled={completionState === "loading"} onClick={() => void completeTrackedPosition(lockedDecision)}>
                {completionState === "loading" ? "核对真实成交…" : "按真实成交完成"}
              </button>}
              <button type="button" className="position-decision-link" onClick={onOpenDecision}>查看对应决策<ChevronRightIcon /></button>
            </div>
            {completionState === "error" && <div className="position-completion-error">未找到真实平仓成交，或交易所中仍有该币种持仓。</div>}
          </article>
        )}
        {tab === "review" && completedTrades.length === 0 && dailyReviews.length === 0 && (
          <div className="position-empty review-empty">
            <ActivityLogIcon />
            <strong>暂无可复盘交易</strong>
            <span>只有在持仓页标记完成的交易，才会进入复盘记录。</span>
          </div>
        )}
        {tab === "review" && dailyReviews.map((review) => {
          const optimization = readStrategyOptimization(review);
          const versionLabel = optimization
            ? optimization.version_before === optimization.version_after
              ? optimization.version_after ?? "保持当前版本"
              : `${optimization.version_before ?? "当前版本"} → ${optimization.version_after ?? "新版本"}`
            : "等待策略样本";
          return (
            <article className="review-trade-card" aria-label={`${review.review_date} 每日策略复盘`} key={`daily-${review.id}`}>
              <div className="position-card-heading">
                <div><span>每日策略复盘</span><strong>{review.review_date}</strong></div>
                <em>{optimization?.status === "updated" ? "已优化" : "继续观察"}</em>
              </div>
              <div className="review-score-grid">
                <div><span>样本交易</span><strong>{optimization?.sample_total ?? readMetricNumber(review, "total")}</strong></div>
                <div><span>当日胜单</span><strong>{readMetricNumber(review, "wins")}</strong></div>
                <div><span>策略胜率</span><strong>{(optimization?.win_rate ?? readMetricNumber(review, "win_rate")).toFixed(1)}%</strong></div>
                <div><span>样本净盈亏</span><strong className={(optimization?.net_pnl ?? readMetricNumber(review, "net_pnl")) < 0 ? "loss" : "profit"}>{formatUsdc(optimization?.net_pnl ?? readMetricNumber(review, "net_pnl"))}</strong></div>
              </div>
              <div className="review-data-note">
                <small className="review-engine-badge">策略版本 {versionLabel}</small>
                <strong>{review.summary}</strong>
                {review.findings.map((item) => <span key={item}>{item}</span>)}
                {review.adjustments.map((item) => <span key={item}>建议：{item}</span>)}
              </div>
            </article>
          );
        })}
        {tab === "review" && completedTrades.map((trade) => {
          const decision = trade.analysis;
          const review = reviews.find((item) => item.trade_id === trade.id);
          const simulated = isSimulatedTrade(trade);
          return (
            <article className="review-trade-card" aria-label={`${decision.instrument} 交易复盘`} key={trade.id}>
              <div className="position-card-heading">
                <div><span>{decision.instrument}</span><strong>{directionLabels[decision.direction]} · {decision.direction}</strong></div>
                <em>{simulated ? trade.exit_reason === "take_profit" ? "止盈完成" : "止损完成" : "已完成"}</em>
              </div>
              <p className="review-trade-time">{formatDecisionTime(new Date(trade.started_at).getTime())} 开始 · {formatDecisionTime(new Date(trade.closed_at).getTime())} 完成</p>
              <div className="review-score-grid">
                <div><span>{simulated ? "模拟入场价" : "真实入场均价"}</span><strong>{formatPrice(trade.entry_price)}</strong></div>
                <div><span>{simulated ? "模拟退出价" : "真实退出均价"}</span><strong>{formatPrice(trade.exit_price)}</strong></div>
                <div><span>手续费</span><strong className="loss">{simulated ? formatUsdc(trade.fee) : formatMoney(trade.fee)}</strong></div>
                <div><span>净盈亏</span><strong className={trade.net_pnl < 0 ? "loss" : "profit"}>{simulated ? formatUsdc(trade.net_pnl) : formatMoney(trade.net_pnl)}</strong></div>
              </div>
              <div className="review-plan-summary">
                <span>原决策计划</span>
                <p>入场 {decision.entry_range.map(formatPrice).join(" – ")} · 止损 {formatPrice(decision.stop_loss)} · {decision.leverage}×</p>
                <small>{decision.reasons[0]}</small>
              </div>
              <div className="review-data-note">
                <small className="review-engine-badge">
                  {simulated ? "模拟结算" : review?.metrics.analysis_engine === "openai" ? "AI 复盘" : "事实记录"}
                </small>
                <strong>{simulated ? `已按${trade.exit_reason === "take_profit" ? "首个止盈" : "止损"}计划价自动结束交易` : review?.summary ?? "已按真实成交生成复盘"}</strong>
                <span>{review?.findings.join(" ") ?? `毛盈亏 ${simulated ? formatUsdc(trade.gross_pnl) : formatMoney(trade.gross_pnl)}，净收益率 ${trade.pnl_percent.toFixed(2)}%。`}</span>
                {review?.adjustments.map((item) => <span key={item}>建议：{item}</span>)}
              </div>
            </article>
          );
        })}
        {tab === "news" && content.map(([label, value, detail]) => (
          <button className="info-row" type="button" key={`${label}-${value}`}>
            <span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div><ChevronRightIcon />
          </button>
        ))}
      </section>
      <div className="readonly-footer"><LockClosedIcon /> {simulationWallet.enabled ? "模拟交易 · 不会真实下单" : "只读分析 · 不会自动下单"}</div>
    </>
  );
}

function DecisionSheet({
  open,
  onOpenChange,
  analysis,
  symbol,
  timeframe,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysis: AnalysisResponse | null;
  symbol: AssetSymbol;
  timeframe: MarketInterval;
}) {
  const reasons = analysis?.reasons ?? [
    "趋势仍偏多，但短周期还需要更多确认。",
    "上方阻力明确，当前位置追涨的赔率有限。",
    "重要事件可能放大波动，需要控制仓位。",
  ];
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="AI 判断依据" description={`${symbol}/USDT · ${timeframe}`}>
      <div className="reason-list">
        {reasons.map((reason, index) => (
          <div key={reason}><span>{index + 1}</span><p><strong>判断依据 {index + 1}</strong>{reason}</p></div>
        ))}
      </div>
      <button type="button" className="sheet-action" onClick={() => onOpenChange(false)}>我知道了</button>
    </BottomSheet>
  );
}

function TradingPrototype() {
  const [activeTab, setActiveTab] = useState<TabId>("market");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lockedDecision, setLockedDecision] = useState<LockedDecision | null>(null);
  const [activeExecutions, setActiveExecutions] = useState<LockedDecision[]>([]);
  const [completedTrades, setCompletedTrades] = useState<CompletedTradeRecord[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [apiAccessToken, setApiAccessTokenState] = useState(getApiAccessToken);
  const [marketPlatform, setMarketPlatform] = useState<MarketPlatform>(() => {
    const stored = window.localStorage.getItem("alpha-market-platform");
    return stored === "binance" || stored === "okx" ? stored : "hyperliquid";
  });
  const [simulationWallets, setSimulationWallets] = useState<SimulationWalletBook>(() => (
    restoreSimulationWalletBook(
      window.localStorage.getItem(SIMULATION_WALLETS_KEY),
      window.localStorage.getItem("alpha-simulation-wallet"),
      marketPlatform,
    )
  ));
  const [simulationClientId] = useState(getSimulationClientId);
  const [simulationHydrated, setSimulationHydrated] = useState(false);
  const [simulationSyncStates, setSimulationSyncStates] = useState<Record<MarketPlatform, SimulationSyncState>>({
    hyperliquid: "loading",
    binance: "loading",
    okx: "loading",
  });
  const simulationWallet = simulationWallets[marketPlatform];
  const simulationSyncState = simulationSyncStates[marketPlatform];
  const simulationWalletsRef = useRef(simulationWallets);
  const lastSyncedSimulationRef = useRef<Partial<Record<MarketPlatform, string>>>({});
  const autoExecutedSignalsRef = useRef(new Set<string>());
  const activeSimulationKey = simulationPlatforms.map((platform) => (
    simulationWallets[platform].enabled
      ? simulationWallets[platform].activeTrades.map((trade) => trade.id).join(",")
      : ""
  )).join("|");
  const [marketMode, setMarketMode] = useState<MarketMode>("free");
  const [freeMarketSymbol, setFreeMarketSymbol] = useState<AssetSymbol>("BTC");
  const [decisionMarketSelections, setDecisionMarketSelections] = useState<DecisionMarketSelection[]>([
    { symbol: "BTC", timeframe: "4h", score: 0, direction: "WAIT" },
    { symbol: "ETH", timeframe: "4h", score: 0, direction: "WAIT" },
    { symbol: "SOL", timeframe: "4h", score: 0, direction: "WAIT" },
    { symbol: "HYPE", timeframe: "4h", score: 0, direction: "WAIT" },
  ]);
  const [sheetContext, setSheetContext] = useState<{
    analysis: AnalysisResponse | null;
    symbol: AssetSymbol;
    timeframe: MarketInterval;
  }>({ analysis: null, symbol: "BTC", timeframe: "1h" });

  useEffect(() => {
    let active = true;
    loadApiAccessToken().then((token) => {
      if (active) setApiAccessTokenState(token);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (simulationWallet.enabled) {
      const decisions = simulationWallet.activeTrades.map(simulatedTradeToLockedDecision);
      setLockedDecision((current) => (
        decisions.find((item) => item.decisionId === current?.decisionId) ?? decisions[0] ?? null
      ));
      return;
    }
    const controller = new AbortController();
    loadActiveExecutions(controller.signal, marketPlatform)
      .then((states) => {
        const decisions = states.map(executionToLockedDecision);
        setActiveExecutions(decisions);
        setLockedDecision((current) => (
          decisions.find((item) => item.decisionId === current?.decisionId) ?? decisions[0] ?? null
        ));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [apiAccessToken, activeSimulationKey, marketPlatform, simulationWallet.enabled]);

  useEffect(() => {
    if (simulationWallet.enabled) {
      setCompletedTrades([]);
      setReviews([]);
      return;
    }
    const controller = new AbortController();
    setCompletedTrades([]);
    setReviews([]);
    loadCompletedTrades(controller.signal, marketPlatform).then(setCompletedTrades).catch(() => undefined);
    loadReviews(controller.signal, marketPlatform).then(setReviews).catch(() => undefined);
    return () => controller.abort();
  }, [apiAccessToken, marketPlatform, simulationWallet.enabled]);

  useEffect(() => {
    window.localStorage.setItem("alpha-market-platform", marketPlatform);
  }, [marketPlatform]);

  useEffect(() => {
    window.localStorage.setItem(SIMULATION_WALLETS_KEY, JSON.stringify(simulationWallets));
    simulationWalletsRef.current = simulationWallets;
  }, [simulationWallets]);

  useEffect(() => {
    for (const platform of simulationPlatforms) {
      for (const trade of simulationWallets[platform].activeTrades) {
        autoExecutedSignalsRef.current.add(`${platform}:${trade.timeframe}:${trade.analysis.symbol}:${trade.analysis.direction}`);
      }
    }
  }, [activeSimulationKey, simulationWallets]);

  useEffect(() => {
    const controller = new AbortController();
    const localSnapshot = JSON.stringify(simulationWalletsRef.current);
    setSimulationSyncStates({ hyperliquid: "loading", binance: "loading", okx: "loading" });
    Promise.allSettled(simulationPlatforms.map(async (platform) => ({
      platform,
      stored: await loadSimulationWallet(simulationClientId, platform, controller.signal),
    })))
      .then((results) => {
        if (controller.signal.aborted) return;
        setSimulationWallets((current) => {
          if (JSON.stringify(simulationWalletsRef.current) !== localSnapshot) return current;
          let next = current;
          for (const result of results) {
            if (result.status !== "fulfilled") continue;
            const { platform, stored } = result.value;
            const remoteState = restoreSimulationWallet(JSON.stringify(stored), platform);
            lastSyncedSimulationRef.current[platform] = JSON.stringify(remoteState);
            if (hasSimulationData(remoteState) || !hasSimulationData(current[platform])) {
              if (next === current) next = { ...current };
              next[platform] = remoteState;
            }
          }
          return next;
        });
        setSimulationSyncStates((current) => {
          const next = { ...current };
          results.forEach((result, index) => {
            next[simulationPlatforms[index]] = result.status === "fulfilled" ? "synced" : "offline";
          });
          return next;
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setSimulationHydrated(true);
      });
    return () => controller.abort();
  }, [apiAccessToken, simulationClientId]);

  useEffect(() => {
    if (!simulationHydrated) return;
    const changedPlatforms = simulationPlatforms.filter((platform) => (
      lastSyncedSimulationRef.current[platform] !== JSON.stringify(simulationWallets[platform])
    ));
    if (changedPlatforms.length === 0) return;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setSimulationSyncStates((current) => {
        const next = { ...current };
        changedPlatforms.forEach((platform) => { next[platform] = "saving"; });
        return next;
      });
      Promise.allSettled(changedPlatforms.map((platform) => (
        saveSimulationWallet(simulationClientId, platform, simulationWallets[platform], controller.signal)
      ))).then((results) => {
        if (controller.signal.aborted) return;
        setSimulationSyncStates((current) => {
          const next = { ...current };
          results.forEach((result, index) => {
            const platform = changedPlatforms[index];
            next[platform] = result.status === "fulfilled" ? "synced" : "offline";
            if (result.status === "fulfilled") {
              lastSyncedSimulationRef.current[platform] = JSON.stringify(simulationWallets[platform]);
            }
          });
          return next;
        });
      });
    }, 350);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiAccessToken, simulationClientId, simulationHydrated, simulationWallets]);

  useEffect(() => {
    const activeTrades = simulationPlatforms.flatMap((platform) => {
      const wallet = simulationWallets[platform];
      return wallet.enabled ? wallet.activeTrades.map((trade) => ({ platform, trade })) : [];
    });
    if (activeTrades.length === 0) return;
    const controller = new AbortController();
    let checking = false;

    const refreshSimulation = async () => {
      if (checking) return;
      checking = true;
      try {
        const results = await Promise.allSettled(activeTrades.map(async ({ platform, trade }) => ({
          platform,
          trade,
          snapshot: await loadMarket(trade.analysis.symbol, controller.signal, platform),
        })));
        setSimulationWallets((current) => {
          let next = current;
          for (const result of results) {
            if (result.status !== "fulfilled") continue;
            const { platform, trade, snapshot } = result.value;
            const wallet = next[platform];
            const currentTrade = wallet.activeTrades.find((item) => item.id === trade.id);
            if (!currentTrade) continue;
            const completed = closeSimulatedTradeIfTriggered(trade, snapshot.price);
            const updatedWallet = completed ? {
              ...wallet,
              balance: wallet.balance + completed.net_pnl,
              activeTrades: wallet.activeTrades.filter((item) => item.id !== trade.id),
              history: [completed, ...wallet.history].slice(0, 500),
            } : {
              ...wallet,
              activeTrades: wallet.activeTrades.map((item) => (
                item.id === trade.id ? updateSimulatedTrade(currentTrade, snapshot.price) : item
              )),
            };
            if (next === current) next = { ...current };
            next[platform] = updatedWallet;
          }
          return next;
        });
      } catch {
        // 行情暂不可用时保留各平台模拟仓位，下一轮继续检查。
      } finally {
        checking = false;
      }
    };

    void refreshSimulation();
    const intervalId = window.setInterval(() => void refreshSimulation(), 30_000);
    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [activeSimulationKey]);

  const startExecution = async (analysis: AnalysisResponse, timeframe: MarketInterval, totalAmount: number) => {
    if (!simulationWallet.enabled) {
      const state = await createExecution(analysis, timeframe, totalAmount);
      const decision = executionToLockedDecision(state);
      setActiveExecutions((current) => [
        decision,
        ...current.filter((item) => item.decisionId !== decision.decisionId),
      ]);
      setLockedDecision(decision);
      return decision;
    }
    if (simulationWallet.activeTrades.length >= MAX_ACTIVE_DECISIONS) {
      throw new Error(`最多同时执行 ${MAX_ACTIVE_DECISIONS} 个决策`);
    }
    if (simulationWallet.activeTrades.some((trade) => trade.analysis.symbol === analysis.symbol)) {
      throw new Error("当前币种已有执行中的决策");
    }
    const trade = openSimulatedTrade(analysis, timeframe, simulationWallet.balance, Date.now() + simulationWallet.activeTrades.length);
    const decision = simulatedTradeToLockedDecision(trade);
    setSimulationWallets((current) => ({
      ...current,
      [marketPlatform]: {
        ...current[marketPlatform],
        activeTrades: [trade, ...current[marketPlatform].activeTrades],
      },
    }));
    setLockedDecision(decision);
    return decision;
  };

  useEffect(() => {
    if (!simulationWallet.enabled) return;
    const controller = new AbortController();
    let scanning = false;

    const executeAvailableOpportunities = async () => {
      if (scanning) return;
      scanning = true;
      try {
        const scan = await loadOpportunities("4h", controller.signal, marketPlatform);
        if (controller.signal.aborted) return;
        const walletSnapshot = simulationWalletsRef.current[marketPlatform];
        const activeSymbols = new Set(walletSnapshot.activeTrades.map((trade) => trade.analysis.symbol));
        const availableSlots = Math.max(0, MAX_ACTIVE_DECISIONS - walletSnapshot.activeTrades.length);
        const additions: SimulatedTrade[] = [];

        for (const candidate of scan.opportunities) {
          if (additions.length >= availableSlots) break;
          const signalKey = `${marketPlatform}:4h:${candidate.symbol}:${candidate.direction}`;
          if (candidate.direction === "WAIT" || candidate.score < 70 || activeSymbols.has(candidate.symbol) || autoExecutedSignalsRef.current.has(signalKey)) continue;
          try {
            const trade = openSimulatedTrade(candidate, "4h", walletSnapshot.balance, Date.now() + additions.length);
            additions.push(trade);
            activeSymbols.add(candidate.symbol);
            autoExecutedSignalsRef.current.add(signalKey);
          } catch {
            // 单个决策格式异常时跳过，继续尝试下一个可执行机会。
          }
        }

        if (additions.length === 0) return;
        setSimulationWallets((current) => {
          const wallet = current[marketPlatform];
          if (!wallet.enabled) return current;
          const currentSymbols = new Set(wallet.activeTrades.map((trade) => trade.analysis.symbol));
          const slots = Math.max(0, MAX_ACTIVE_DECISIONS - wallet.activeTrades.length);
          const accepted = additions.filter((trade) => !currentSymbols.has(trade.analysis.symbol)).slice(0, slots);
          if (accepted.length === 0) return current;
          return {
            ...current,
            [marketPlatform]: { ...wallet, activeTrades: [...accepted, ...wallet.activeTrades] },
          };
        });
      } catch {
        // 扫描暂不可用时保留当前模拟决策，下一轮自动重试。
      } finally {
        scanning = false;
      }
    };

    void executeAvailableOpportunities();
    const intervalId = window.setInterval(() => void executeAvailableOpportunities(), 30_000);
    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [apiAccessToken, marketPlatform, simulationWallet.enabled]);

  const cancelTrackedExecution = async (decision: LockedDecision) => {
    if (simulationWallet.enabled) {
      setSimulationWallets((current) => {
        const activeTrades = current[marketPlatform].activeTrades.filter((trade) => trade.id !== decision.decisionId);
        setLockedDecision(activeTrades[0] ? simulatedTradeToLockedDecision(activeTrades[0]) : null);
        return {
          ...current,
          [marketPlatform]: { ...current[marketPlatform], activeTrades },
        };
      });
      return;
    }
    await cancelExecution(decision.decisionId);
    setActiveExecutions((current) => {
      const next = current.filter((item) => item.decisionId !== decision.decisionId);
      setLockedDecision(next[0] ?? null);
      return next;
    });
  };

  return (
    <div className="alpha-app">
      <MobileScroll className="alpha-scroll">
        <main className="alpha-content" data-testid="alpha-app-content">
          {activeTab === "market" ? (
            <MarketScreen
              key="live-data-v2"
              mode={marketMode}
              onModeChange={setMarketMode}
              freeSymbol={freeMarketSymbol}
              onFreeSymbolChange={setFreeMarketSymbol}
              decisionSelections={decisionMarketSelections}
              platform={marketPlatform}
              onPlatformChange={setMarketPlatform}
              simulationWallet={simulationWallet}
              simulationSyncState={simulationSyncState}
              apiAccessToken={apiAccessToken}
              onApiAccessTokenChange={setApiAccessTokenState}
              onSimulationEnabledChange={(enabled) => {
                if (simulationWallet.activeTrades.length > 0) return;
                if (!enabled) {
                  for (const signal of autoExecutedSignalsRef.current) {
                    if (signal.startsWith(`${marketPlatform}:`)) autoExecutedSignalsRef.current.delete(signal);
                  }
                }
                setLockedDecision(null);
                setSimulationWallets((current) => ({
                  ...current,
                  [marketPlatform]: { ...current[marketPlatform], enabled },
                }));
              }}
              onResetSimulationWallet={() => {
                if (simulationWallet.activeTrades.length > 0) return;
                for (const signal of autoExecutedSignalsRef.current) {
                  if (signal.startsWith(`${marketPlatform}:`)) autoExecutedSignalsRef.current.delete(signal);
                }
                setSimulationWallets((current) => ({
                  ...current,
                  [marketPlatform]: createDefaultSimulationWallet(simulationWallet.enabled),
                }));
              }}
              openDetails={(analysis, symbol, timeframe) => {
                setSheetContext({ analysis, symbol, timeframe });
                setDetailsOpen(true);
              }}
            />
          ) : activeTab === "decision" ? (
            <DecisionScreen
              lockedDecision={lockedDecision?.analysis.platform === marketPlatform ? lockedDecision : null}
              activeDecisions={simulationWallet.enabled
                ? simulationWallet.activeTrades.map(simulatedTradeToLockedDecision)
                : activeExecutions.filter((item) => item.analysis.platform === marketPlatform)}
              onMarketSelectionsChange={setDecisionMarketSelections}
              platform={marketPlatform}
              simulationEnabled={simulationWallet.enabled}
              simulationBalance={simulationWallet.balance}
              onStartExecution={startExecution}
              onCancelExecution={cancelTrackedExecution}
              onContinueScanning={() => setLockedDecision(null)}
              openDetails={(analysis, symbol, timeframe) => {
                setSheetContext({ analysis, symbol, timeframe });
                setDetailsOpen(true);
              }}
            />
          ) : <SecondaryScreen
            key={`${activeTab}-${marketPlatform}-${apiAccessToken ? "authorized" : "anonymous"}`}
            tab={activeTab}
            lockedDecision={lockedDecision?.analysis.platform === marketPlatform
              ? lockedDecision
              : simulationWallet.enabled && simulationWallet.activeTrades[0]
                ? simulatedTradeToLockedDecision(simulationWallet.activeTrades[0])
                : activeExecutions.find((item) => item.analysis.platform === marketPlatform) ?? null}
            activeDecisions={simulationWallet.enabled
              ? simulationWallet.activeTrades.map(simulatedTradeToLockedDecision)
              : activeExecutions}
            completedTrades={simulationWallet.enabled ? simulationWallet.history : completedTrades}
            reviews={reviews}
            platform={marketPlatform}
            simulationWallet={simulationWallet}
            simulationSyncState={simulationSyncState}
            onOpenDecision={() => setActiveTab("decision")}
            onSelectDecision={setLockedDecision}
            onCompletePosition={async (decision) => {
              const result = await completePosition(decision.positionId);
              setCompletedTrades((current) => [result.trade, ...current.filter((item) => item.id !== result.trade.id)]);
              setReviews((current) => [result.review, ...current.filter((item) => item.id !== result.review.id)]);
              setActiveExecutions((current) => {
                const next = current.filter((item) => item.decisionId !== decision.decisionId);
                setLockedDecision(next[0] ?? null);
                return next;
              });
              setActiveTab("review");
            }}
          />}
        </main>
      </MobileScroll>
      <nav className="bottom-nav" aria-label="主导航">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button type="button" className={activeTab === id ? "active" : ""} aria-current={activeTab === id ? "page" : undefined} onClick={() => setActiveTab(id)} key={id}>
            <Icon /><span>{label}</span>
          </button>
        ))}
      </nav>
      <DecisionSheet open={detailsOpen} onOpenChange={setDetailsOpen} {...sheetContext} />
    </div>
  );
}

export default function Prototype() {
  const isAndroidBundle = import.meta.env.VITE_APP_TARGET === "android";

  useLayoutEffect(() => {
    if (!isAndroidBundle) return;

    // APK 直接使用系统屏幕，不显示网页原型的设备外框与模拟系统控件。
    document.documentElement.classList.add("native-android");
    return () => document.documentElement.classList.remove("native-android");
  }, [isAndroidBundle]);

  return isAndroidBundle || window.location.pathname.startsWith("/app") ? <TradingPrototype /> : <DownloadLanding />;
}
