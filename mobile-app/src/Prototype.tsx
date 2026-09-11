import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityLogIcon,
  BarChartIcon,
  BellIcon,
  BookmarkIcon,
  ChevronRightIcon,
  FileTextIcon,
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
  loadAnalysis,
  loadCandles,
  loadCapitalSettings,
  loadMarket,
  loadNews,
  loadOpportunities,
  saveCapitalSettings,
  type AnalysisResponse,
  type AssetSymbol,
  type Candle,
  type MarketInterval,
  type MarketSnapshot,
  type NewsItem,
} from "./alphaApi";
import { BottomSheet, KeyboardInput, MobileScroll, useKeyboard } from "./mobile";
import "./prototype.css";

type TabId = "market" | "decision" | "news" | "positions" | "review";
type DataState = "loading" | "live" | "demo" | "offline";
type RemoteState = "idle" | "loading" | "ready" | "offline";
type MarketMode = "free" | "decision";
type MarketSelection = { symbol: AssetSymbol; timeframe: MarketInterval };
type DecisionMarketSelection = MarketSelection & {
  score: number;
  direction: AnalysisResponse["direction"];
};
type LockedDecision = {
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  startedAt: number;
  totalAmount: number;
  allocatedAmount: number;
};
type CompletedTrade = LockedDecision & {
  completedAt: number;
};

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
  offline: "后端未连接",
};

function AppHeader({ dataState }: { dataState: DataState }) {
  return (
    <header className="brand-header">
      <div>
        <strong><span>Alpha</span> Trader AI</strong>
        <p>用数据，看更远的市场</p>
      </div>
      <div className="header-meta">
        <time dateTime="2026-09-11">2026-09-11</time>
        <span>专注 · 理性 · 长期</span>
      </div>
      <div className="readonly-banner">
        <span><LockClosedIcon /> 只读模式 · 不会自动下单</span>
        <em className={`source-status ${dataState}`}>{dataStateLabel[dataState]}</em>
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

function DecisionMarketChartCard({ selection }: { selection: DecisionMarketSelection }) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "offline">("loading");

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setCandles([]);

    const refresh = () => {
      loadCandles(selection.symbol, selection.timeframe, 80, controller.signal)
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
  }, [selection.symbol, selection.timeframe]);

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
        {state === "loading" ? "正在同步 K 线" : state === "offline" ? "后端未连接 · 展示演示走势" : "决策行情已同步"}
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
}: {
  openDetails: (analysis: AnalysisResponse | null, symbol: AssetSymbol, timeframe: MarketInterval) => void;
  mode: MarketMode;
  onModeChange: (mode: MarketMode) => void;
  freeSymbol: AssetSymbol;
  onFreeSymbolChange: (symbol: AssetSymbol) => void;
  decisionSelections: DecisionMarketSelection[];
}) {
  const keyboard = useKeyboard();
  const [symbolDraft, setSymbolDraft] = useState(freeSymbol);
  const [timeframe, setTimeframe] = useState<MarketInterval>("1h");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataState, setDataState] = useState<DataState>("loading");
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const symbol = freeSymbol;
  const selected = assets[symbol] ?? {
    pair: `${symbol}/USDT`,
    price: "0",
    delta: "0%",
    regime: "等待行情",
  };
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
      Promise.all([
        loadMarket(symbol, controller.signal),
        loadCandles(symbol, timeframe, 80, controller.signal),
      ]).then(([nextSnapshot, nextCandles]) => {
        setSnapshot(nextSnapshot);
        setCandles(nextCandles);
        setDataState(nextSnapshot.source);
      }).catch(() => {
        if (controller.signal.aborted) return;
        setDataState("offline");
      });
    };
    refreshMarket();
    // 后端恢复后自动重新连接，避免用户停留在降级状态。
    const intervalId = window.setInterval(refreshMarket, 30_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [mode, symbol, timeframe]);

  useEffect(() => {
    if (mode !== "free") return;
    const controller = new AbortController();
    setAnalysis(null);

    const refreshAnalysis = () => {
      loadAnalysis(symbol, timeframe, controller.signal)
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
  }, [mode, symbol, timeframe]);

  const direction = analysis?.direction ?? "WAIT";
  const confidence = analysis?.confidence ?? 68;
  const entryRange = analysis?.entry_range.map(formatPrice).join("–") ?? "111,800–113,200";
  const stopLoss = analysis ? formatPrice(analysis.stop_loss) : "109,000";
  const takeProfit = analysis?.take_profit.map(formatPrice).join(" / ") ?? "118,000 / 122,000";

  const selectFreeSymbol = (nextSymbol: string) => {
    // 币种只允许字母和数字，保持与后端接口的校验规则一致。
    const normalized = nextSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) return;
    setSymbolDraft(normalized);
    onFreeSymbolChange(normalized);
  };

  return (
    <>
      <AppHeader dataState={dataState} />
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
            <DecisionMarketChartCard selection={selection} key={`${selection.symbol}-${selection.timeframe}`} />
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
          <h2 id="decision-title">AI 决策 <small>{analysis ? "已更新" : "演示"}</small></h2>
          <div className="confidence"><span>置信度</span><strong>{confidence}%</strong><i><b style={{ width: `${confidence}%` }} /></i></div>
        </div>
        <div className="decision-summary">
          <div className={`wait-state ${direction.toLowerCase()}`}><strong>{directionLabels[direction]}</strong><span>{direction}</span></div>
          <p>{analysis?.reasons[0] ?? "价格接近前高阻力区，短期或震荡整理，等待更好的入场机会。"}</p>
        </div>
        <div className="decision-metrics">
          <div><span>入场区间</span><strong>{entryRange}</strong></div>
          <div><span>止损</span><strong className="loss">{stopLoss}</strong></div>
          <div><span>止盈目标</span><strong>{takeProfit}</strong></div>
          <div><span>建议杠杆</span><strong>{analysis?.leverage ?? 3}×</strong></div>
          <div><span>风险等级</span><strong className="risk">{analysis ? riskLabels[analysis.risk] : "中等"}</strong></div>
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
  onLockedDecisionChange,
  onMarketSelectionsChange,
}: {
  openDetails: (analysis: AnalysisResponse | null, symbol: AssetSymbol, timeframe: MarketInterval) => void;
  lockedDecision: LockedDecision | null;
  onLockedDecisionChange: (decision: LockedDecision | null) => void;
  onMarketSelectionsChange: (selections: DecisionMarketSelection[]) => void;
}) {
  const [symbol, setSymbol] = useState<AssetSymbol | null>(lockedDecision?.analysis.symbol ?? null);
  const [timeframe, setTimeframe] = useState<MarketInterval>(lockedDecision?.timeframe ?? "4h");
  const [candidates, setCandidates] = useState<AnalysisResponse[]>([]);
  const [scanStats, setScanStats] = useState({ scanned: 0, eligible: 0 });
  const [selectionMode, setSelectionMode] = useState<"auto" | "manual">("auto");
  const [remoteState, setRemoteState] = useState<RemoteState>("loading");
  const [totalAmount, setTotalAmount] = useState(10_000);
  const [amountDraft, setAmountDraft] = useState("10000");
  const [capitalState, setCapitalState] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [executionConfirmationOpen, setExecutionConfirmationOpen] = useState(false);
  const isExecuting = lockedDecision !== null;

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRemoteState("loading");

    const refresh = () => {
      loadOpportunities(timeframe, controller.signal)
        .then((scan) => {
          const results = scan.opportunities;
          setScanStats({ scanned: scan.scanned_markets, eligible: scan.eligible_markets });
          if (results.length === 0) {
            setRemoteState("offline");
            return;
          }
          setCandidates(results);
          setSymbol((current) => isExecuting
            ? lockedDecision.analysis.symbol
            : selectionMode === "auto" || current === null ? results[0].symbol : current);
          setRemoteState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setRemoteState("offline");
        });
    };
    refresh();
    const intervalId = window.setInterval(refresh, 30_000);

    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [isExecuting, lockedDecision, selectionMode, timeframe, totalAmount]);

  const activeSymbol = lockedDecision?.analysis.symbol ?? symbol ?? candidates[0]?.symbol ?? "BTC";
  const analysis = lockedDecision?.analysis ?? candidates.find((item) => item.symbol === activeSymbol) ?? null;
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

  const fallbackBreakdown = { trend: 18, structure: 16, capital: 14, macro: 9, news: 7 };
  const breakdown = analysis?.score_breakdown ?? fallbackBreakdown;
  const score = analysis?.score ?? Object.values(fallbackBreakdown).reduce((sum, value) => sum + value, 0);
  const confidence = analysis?.confidence ?? 64;
  const direction = analysis?.direction ?? "WAIT";
  const opportunity = getOpportunity(score);
  const fallbackPrice = Number(assets[activeSymbol]?.price.replace(/,/g, "") ?? 0);
  const entryRange = analysis?.entry_range ?? [fallbackPrice * 0.992, fallbackPrice * 0.997];
  const stopLoss = analysis?.stop_loss ?? fallbackPrice * 0.974;
  const takeProfit = analysis?.take_profit ?? [fallbackPrice * 1.035, fallbackPrice * 1.072];
  const leverage = analysis?.leverage ?? 3;
  const positionSizing = analysis?.position_sizing;
  const currentAllocation = lockedDecision?.allocatedAmount
    ?? positionSizing?.margin_amount
    ?? 0;
  const nominalExposure = positionSizing?.position_value ?? currentAllocation * leverage;
  const maxLossAmount = positionSizing?.max_loss_amount ?? 0;
  const stopDistancePercent = (positionSizing?.stop_distance_rate ?? 0) * 100;
  const riskBudgetPercent = (positionSizing?.risk_budget_rate ?? 0) * 100;
  const risk = analysis ? riskLabels[analysis.risk] : "中等";
  const entryMid = (entryRange[0] + entryRange[1]) / 2;
  const riskDistance = Math.abs(entryMid - stopLoss);
  const rewardDistance = Math.abs(takeProfit[0] - entryMid);
  const rewardRisk = riskDistance > 0 ? (rewardDistance / riskDistance).toFixed(1) : "--";
  const scoreItems: Array<[keyof typeof breakdown, string, number]> = [
    ["trend", "趋势", 30],
    ["structure", "技术结构", 25],
    ["capital", "资金", 20],
    ["macro", "宏观", 15],
    ["news", "新闻", 10],
  ];
  const reasons = analysis?.reasons ?? [
    "趋势方向尚未获得足够确认，继续观察关键结构。",
    "资金费率处于温和区间，暂未出现明显拥挤。",
    "重大新闻与宏观事件发生时需要重新评估。",
  ];
  const sourceLabel = isExecuting
    ? "执行快照"
    : remoteState === "loading"
      ? "正在分析"
      : remoteState === "offline"
        ? "后端未连接"
        : analysis?.source === "live" ? "实时行情" : "演示分析";
  const sourceTone = remoteState === "offline" ? "offline" : analysis?.source === "live" ? "live" : "demo";
  const parsedAmount = Number(amountDraft.replace(/,/g, ""));
  const amountIsValid = Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount <= 1_000_000_000;

  const persistTotalAmount = async () => {
    if (!amountIsValid || capitalState === "saving") return;
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

  const confirmExecution = () => {
    if (!analysis || direction === "WAIT") return;
    onLockedDecisionChange({
      analysis,
      timeframe,
      startedAt: Date.now(),
      totalAmount,
      allocatedAmount: currentAllocation,
    });
    setSymbol(analysis.symbol);
    setExecutionConfirmationOpen(false);
  };

  return (
    <>
      <div className="subscreen-header decision-page-header">
        <span>AI 决策引擎</span>
        <h1>开仓前决策</h1>
        <p>先判断机会质量，再确认执行与风险边界</p>
      </div>

      <section className="opportunity-radar" aria-labelledby="opportunity-radar-title">
        <div className="opportunity-radar-heading">
          <div>
            <strong id="opportunity-radar-title">全市场机会雷达</strong>
            <span>{scanStats.scanned > 0 ? `已扫描 ${scanStats.scanned} 个市场 · ${scanStats.eligible} 个通过流动性筛选` : "正在读取全部永续合约市场"}</span>
          </div>
          <button
            type="button"
            aria-pressed={selectionMode === "auto"}
            className={isExecuting ? "locked" : selectionMode === "auto" ? "active" : ""}
            disabled={isExecuting}
            onClick={() => {
              setSelectionMode("auto");
              setSymbol(candidates[0]?.symbol ?? null);
            }}
          >
            {isExecuting ? "执行锁定" : selectionMode === "auto" ? "自动跟随" : "恢复智能优选"}
          </button>
        </div>
        <div className="opportunity-switcher" role="tablist" aria-label="AI 机会排名">
          {visibleCandidates.length > 0 ? visibleCandidates.map((candidate, index) => (
              <button
                type="button"
                role="tab"
                aria-selected={symbol === candidate.symbol}
                className={symbol === candidate.symbol ? "active" : ""}
                disabled={isExecuting}
                onClick={() => {
                  setSymbol(candidate.symbol);
                  setSelectionMode("manual");
                }}
                key={candidate.symbol}
              >
                <span><small>#{index + 1}</small><strong>{candidate.symbol}</strong></span>
                <em>{candidate.score} · {candidate.direction} </em>
              </button>
            )) : <div className="opportunity-loading">正在扫描并计算机会评分…</div>}
        </div>
      </section>

      <section className="capital-settings-card" aria-labelledby="capital-settings-title">
        <div className="capital-settings-heading">
          <div><strong id="capital-settings-title">三向资金预算</strong><span>最多同时配置 3 个有效币种方向</span></div>
          <em>至少保留 10%</em>
        </div>
        <div className="capital-editor">
          <label htmlFor="total-capital">
            <span>总金额</span>
            <div><KeyboardInput
              id="total-capital"
              aria-label="总金额（USDT）"
              inputMode="decimal"
              value={amountDraft}
              onChange={(event) => setAmountDraft(event.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter") void persistTotalAmount();
              }}
            /><b>USDT</b></div>
          </label>
          <button type="button" disabled={!amountIsValid || capitalState === "saving"} onClick={() => void persistTotalAmount()}>
            {capitalState === "saving" ? "保存中" : "保存"}
          </button>
        </div>
        <small className={capitalState === "error" ? "error" : ""}>
          {capitalState === "loading" ? "正在读取资金设置" : capitalState === "saved" ? "总金额已保存，正在重新计算仓位" : capitalState === "error" ? "保存失败，请检查后端连接" : "按风险预算与止损距离反推投入资金"}
        </small>
        <div className="capital-budget-summary" aria-label="资金预算规则">
          <div><span>高风险预算<small>总资金 0.5%</small></span><strong>{formatMoney(totalAmount * 0.005)}</strong></div>
          <div><span>中风险预算<small>总资金 0.75%</small></span><strong>{formatMoney(totalAmount * 0.0075)}</strong></div>
          <div><span>低风险预算<small>总资金 1%</small></span><strong>{formatMoney(totalAmount * 0.01)}</strong></div>
          <div><span>保证金上限<small>单笔最多 30%</small></span><strong>{formatMoney(totalAmount * 0.3)}</strong></div>
        </div>
      </section>

      <div className="decision-filter-row">
        <div><strong>{activeSymbol}-PERP</strong><span>{isExecuting ? "决策执行中" : selectionMode === "auto" ? "AI 当前优选" : "手动查看"}</span></div>
        <div className="timeframes" aria-label="选择分析周期">
          {(["1m", "5m", "1h", "4h", "1d"] as MarketInterval[]).map((item) => (
            <button
              type="button"
              aria-pressed={timeframe === item}
              className={timeframe === item ? "active" : ""}
              disabled={isExecuting}
              onClick={() => {
                setTimeframe(item);
                setSelectionMode("auto");
                setSymbol(null);
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
          <div className="wide"><span>建议入场区间</span><strong>{entryRange.map(formatPrice).join(" – ")}</strong></div>
          <div><span>结构止损</span><strong className="loss">{formatPrice(stopLoss)}</strong></div>
          <div><span>建议杠杆</span><strong>{leverage}×</strong></div>
          <div><span>止盈目标 1</span><strong>{formatPrice(takeProfit[0])}</strong></div>
          <div><span>止盈目标 2</span><strong>{formatPrice(takeProfit[1])}</strong></div>
          <div><span>目标盈亏比</span><strong>1 : {rewardRisk}</strong></div>
          <div><span>风险等级</span><strong className="risk">{risk}</strong></div>
          <div className="capital-result">
            <span>本次投入资金<small>{isExecuting ? "执行快照已锁定" : direction === "WAIT" ? "等待信号，不投入" : `开仓价值 ÷ ${leverage} 倍杠杆`}</small></span>
            <strong>{formatMoney(currentAllocation)}</strong>
          </div>
          <div className="capital-result">
            <span>开仓总价值<small>{direction === "WAIT" ? "等待信号，不开仓" : `${riskBudgetPercent.toFixed(2)}% 风险预算 ÷ ${stopDistancePercent.toFixed(2)}% 止损`}</small></span>
            <strong>{formatMoney(nominalExposure)}</strong>
          </div>
          <div className="wide capital-risk-note">
            <span>最大计划亏损</span><strong>{formatMoney(maxLossAmount)}</strong>
          </div>
        </div>
        <div className={`decision-execution-control ${isExecuting ? "executing" : ""}`}>
          <div>
            <strong>{isExecuting ? `${activeSymbol} 决策执行中` : `执行 ${activeSymbol} 决策`}</strong>
            <span>{isExecuting ? "已固定当前币种、周期与决策快照，行情扫描不会将其替换" : "开始后固定本次决策；仅用于执行跟踪，不会自动下单"}</span>
          </div>
          <button
            type="button"
            aria-pressed={isExecuting}
            disabled={!analysis || (!isExecuting && direction === "WAIT")}
            onClick={() => {
              if (isExecuting) {
                onLockedDecisionChange(null);
                setSelectionMode("auto");
                setSymbol(candidates[0]?.symbol ?? null);
                return;
              }
              setExecutionConfirmationOpen(true);
            }}
          >
            <LockClosedIcon />
            {isExecuting ? "结束执行并恢复智能优选" : `开始执行 ${activeSymbol}`}
          </button>
        </div>
      </section>

      <BottomSheet
        open={executionConfirmationOpen}
        onOpenChange={setExecutionConfirmationOpen}
        title="确认开始执行"
        description={`${activeSymbol}-PERP · ${directionLabels[direction]} · ${timeframe}`}
      >
        <div className="execution-confirm-summary">
          <div><span>本次投入资金</span><strong>{formatMoney(currentAllocation)}</strong></div>
          <div><span>开仓总价值</span><strong>{formatMoney(nominalExposure)}</strong></div>
          <div><span>建议杠杆</span><strong>{leverage}×</strong></div>
          <div><span>最大计划亏损</span><strong className="loss">{formatMoney(maxLossAmount)}</strong></div>
        </div>
        <div className="execution-confirm-risk">
          <strong>请确认风险边界</strong>
          <span>计划入场 {entryRange.map(formatPrice).join(" – ")} · 结构止损 {formatPrice(stopLoss)}</span>
          <small>确认后将固定当前决策并同步到持仓页，仅用于执行跟踪，不会向交易所下单。</small>
        </div>
        <div className="execution-confirm-actions">
          <button type="button" onClick={() => setExecutionConfirmationOpen(false)}>取消</button>
          <button type="button" onClick={confirmExecution}>确认开始执行</button>
        </div>
      </BottomSheet>

      <section className="decision-detail-card" aria-labelledby="score-breakdown-title">
        <div className="decision-section-title"><div><span>02</span><h2 id="score-breakdown-title">五维评分</h2></div><em>宏观 / 新闻为当前基线</em></div>
        <div className="score-breakdown">
          {scoreItems.map(([key, label, max]) => (
            <div className="score-row" key={key}>
              <span>{label}</span><i><b style={{ width: `${(breakdown[key] / max) * 100}%` }} /></i><strong>{breakdown[key]}<small>/{max}</small></strong>
            </div>
          ))}
        </div>
      </section>

      <section className="decision-detail-card" aria-labelledby="evidence-title">
        <div className="decision-section-title"><div><span>03</span><h2 id="evidence-title">判断依据</h2></div><em>可解释决策</em></div>
        <div className="decision-reasons">
          {reasons.map((reason, index) => <p key={reason}><span>{index + 1}</span>{reason}</p>)}
        </div>
        <button type="button" className="primary-button decision-evidence-button" onClick={() => openDetails(analysis, activeSymbol, timeframe)}>
          <ActivityLogIcon />查看完整依据<ChevronRightIcon />
        </button>
      </section>

      <section className="decision-detail-card invalidation-card" aria-labelledby="invalidation-title">
        <div className="decision-section-title"><div><span>04</span><h2 id="invalidation-title">失效与重评条件</h2></div><em>先定义退出</em></div>
        <div className="invalidation-list">
          <p>价格触及结构止损 {formatPrice(stopLoss)}，当前计划立即失效</p>
          <p>综合评分跌破 50 分，禁止新增交易</p>
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
  completedTrades,
  onOpenDecision,
  onCompletePosition,
}: {
  tab: Exclude<TabId, "market" | "decision">;
  lockedDecision: LockedDecision | null;
  completedTrades: CompletedTrade[];
  onOpenDecision: () => void;
  onCompletePosition: () => void;
}) {
  const info = tabLabels[tab];
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsDate, setNewsDate] = useState(() => formatLocalDate(new Date()));
  const [newsTotal, setNewsTotal] = useState(0);
  const [remoteState, setRemoteState] = useState<RemoteState>("idle");

  useEffect(() => {
    if (tab !== "news") {
      setRemoteState("idle");
      return;
    }

    const controller = new AbortController();
    setRemoteState("loading");
    loadNews(newsDate, controller.signal)
      .then((archive) => {
        setNewsItems(archive.items);
        setNewsTotal(archive.total);
        setRemoteState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setRemoteState("offline");
      });

    return () => controller.abort();
  }, [newsDate, tab]);

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
  const remoteLabel = { idle: "本地摘要", loading: "正在更新", ready: "后端已更新", offline: "后端未连接" }[remoteState];
  const activePosition = lockedDecision?.analysis;
  const positionSizing = activePosition?.position_sizing;
  const startedAt = lockedDecision ? formatDecisionTime(lockedDecision.startedAt) : "";

  return (
    <>
      <div className="subscreen-header"><span>{info.eyebrow}</span><h1>{info.title}</h1><p>{info.summary}</p></div>
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
          <strong>{tab === "positions" ? lockedDecision ? "1 个执行中" : "暂无执行" : tab === "review" ? `${completedTrades.length} 笔已完成` : `${newsTotal} 条`}</strong>
        </div>
        {tab === "news" && remoteState === "ready" && content.length === 0 && <div className="news-empty">当天暂无归档新闻</div>}
        {tab === "positions" && !lockedDecision && (
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
              <em>执行跟踪中</em>
            </div>
            <p className="position-started-at">{startedAt} 开始 · {lockedDecision.timeframe} 周期 · 非交易所订单</p>
            <div className="position-value-grid">
              <div><span>本次投入资金</span><strong>{formatMoney(lockedDecision.allocatedAmount)}</strong></div>
              <div><span>开仓总价值</span><strong>{formatMoney(positionSizing?.position_value ?? lockedDecision.allocatedAmount * activePosition.leverage)}</strong></div>
              <div><span>建议杠杆</span><strong>{activePosition.leverage}×</strong></div>
              <div><span>最大计划亏损</span><strong className="loss">{formatMoney(positionSizing?.max_loss_amount ?? 0)}</strong></div>
            </div>
            <div className="position-levels">
              <div><span>计划入场</span><strong>{activePosition.entry_range.map(formatPrice).join(" – ")}</strong></div>
              <div><span>结构止损</span><strong className="loss">{formatPrice(activePosition.stop_loss)}</strong></div>
              <div><span>止盈目标</span><strong>{activePosition.take_profit.map(formatPrice).join(" / ")}</strong></div>
            </div>
            <div className="position-actions">
              <button type="button" className="position-complete-button" onClick={onCompletePosition}>标记交易完成</button>
              <button type="button" className="position-decision-link" onClick={onOpenDecision}>查看对应决策<ChevronRightIcon /></button>
            </div>
          </article>
        )}
        {tab === "review" && completedTrades.length === 0 && (
          <div className="position-empty review-empty">
            <ActivityLogIcon />
            <strong>暂无可复盘交易</strong>
            <span>只有在持仓页标记完成的交易，才会进入复盘记录。</span>
          </div>
        )}
        {tab === "review" && completedTrades.map((trade) => {
          const decision = trade.analysis;
          return (
            <article className="review-trade-card" aria-label={`${decision.instrument} 交易复盘`} key={`${decision.symbol}-${trade.completedAt}`}>
              <div className="position-card-heading">
                <div><span>{decision.instrument}</span><strong>{directionLabels[decision.direction]} · {decision.direction}</strong></div>
                <em>已完成</em>
              </div>
              <p className="review-trade-time">{formatDecisionTime(trade.startedAt)} 开始 · {formatDecisionTime(trade.completedAt)} 完成</p>
              <div className="review-score-grid">
                <div><span>决策评分</span><strong>{decision.score}/100</strong></div>
                <div><span>置信度</span><strong>{decision.confidence}%</strong></div>
                <div><span>投入资金</span><strong>{formatMoney(trade.allocatedAmount)}</strong></div>
                <div><span>计划最大亏损</span><strong className="loss">{formatMoney(decision.position_sizing.max_loss_amount)}</strong></div>
              </div>
              <div className="review-plan-summary">
                <span>原决策计划</span>
                <p>入场 {decision.entry_range.map(formatPrice).join(" – ")} · 止损 {formatPrice(decision.stop_loss)} · {decision.leverage}×</p>
                <small>{decision.reasons[0]}</small>
              </div>
              <div className="review-data-note"><strong>已进入复盘</strong><span>当前记录决策与风控快照；真实退出价和盈亏需由交易账户数据补全。</span></div>
            </article>
          );
        })}
        {tab === "news" && content.map(([label, value, detail]) => (
          <button className="info-row" type="button" key={`${label}-${value}`}>
            <span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div><ChevronRightIcon />
          </button>
        ))}
      </section>
      <div className="readonly-footer"><LockClosedIcon /> 只读分析 · 不会自动下单</div>
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

export default function Prototype() {
  const [activeTab, setActiveTab] = useState<TabId>("market");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lockedDecision, setLockedDecision] = useState<LockedDecision | null>(null);
  const [completedTrades, setCompletedTrades] = useState<CompletedTrade[]>([]);
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
              openDetails={(analysis, symbol, timeframe) => {
                setSheetContext({ analysis, symbol, timeframe });
                setDetailsOpen(true);
              }}
            />
          ) : activeTab === "decision" ? (
            <DecisionScreen
              lockedDecision={lockedDecision}
              onLockedDecisionChange={setLockedDecision}
              onMarketSelectionsChange={setDecisionMarketSelections}
              openDetails={(analysis, symbol, timeframe) => {
                setSheetContext({ analysis, symbol, timeframe });
                setDetailsOpen(true);
              }}
            />
          ) : <SecondaryScreen
            tab={activeTab}
            lockedDecision={lockedDecision}
            completedTrades={completedTrades}
            onOpenDecision={() => setActiveTab("decision")}
            onCompletePosition={() => {
              if (!lockedDecision) return;
              setCompletedTrades((current) => [{ ...lockedDecision, completedAt: Date.now() }, ...current]);
              setLockedDecision(null);
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
