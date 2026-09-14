const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const BINANCE_FUTURES_URL = "https://fapi.binance.com";
const OKX_API_URL = "https://www.okx.com";
const CORE_SYMBOLS = ["BTC", "ETH", "SOL", "HYPE"];
const STRATEGY_PARAMETERS = {
  min_trade_score: 70,
  trend_weight: 30,
  structure_weight: 25,
  capital_weight: 20,
  macro_weight: 15,
  news_weight: 10,
};
const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const DECISION_VALIDITY_MS = { ...INTERVAL_MS, "1m": 300_000, "5m": 900_000, "15m": 1_800_000 };
const MIN_REMAINING_REWARD_RISK = 1.5;
const DECISION_SCORE_HYSTERESIS = 2;
const SOFT_FAILURE_CONFIRMATIONS = 2;
const MISSED_ENTRY_CONFIRMATIONS = 2;
const MAX_DECISION_REVISIONS = 3;
const MAX_MISSED_ENTRY_ATR = 0.5;
const MAX_TARGET_PROGRESS = 0.5;
const TECHNICAL_RULES = {
  minimumEmaSpreadPercent: 0.1,
  maximumEmaSpreadAtrFactor: 0.25,
  maximumEmaSpreadThreshold: 0.5,
  maximumEntryStretchAtr: 1.5,
  longRsiExhaustion: 75,
  shortRsiExhaustion: 25,
  emaSlopeLookback: 3,
  minimumVolumeRatio: 0.5,
  maximumCrowdedFundingRate: 0.05,
};
const FALLBACK_MARKETS = [
  { symbol: "BTC", price: 82437.2, change_24h: 2.84, volume: 28460000000, volatility: 3.12, funding_rate: 0.0102, open_interest: 18720000000, source: "demo" },
  { symbol: "ETH", price: 3548.76, change_24h: 1.92, volume: 14820000000, volatility: 3.86, funding_rate: 0.0084, open_interest: 9640000000, source: "demo" },
  { symbol: "SOL", price: 179.42, change_24h: -0.74, volume: 3960000000, volatility: 5.14, funding_rate: -0.0021, open_interest: 2180000000, source: "demo" },
  { symbol: "HYPE", price: 39.28, change_24h: 4.63, volume: 642000000, volatility: 6.42, funding_rate: 0.0148, open_interest: 782000000, source: "demo" },
];
function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function fingerprint(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join("");
}

async function fetchLiveNews() {
  try {
    const response = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
    if (!response.ok) throw new Error(`新闻源请求失败：${response.status}`);
    const body = await response.json();
    const items = Array.isArray(body.Data) ? body.Data : [];
    return items.map((item, index) => {
      const categories = String(item.categories || "").split("|").filter(Boolean).slice(0, 8);
      return {
        id: Number(item.id || index + 1),
        title: String(item.title || "未命名新闻"),
        source: String(item.source_info?.name || item.source || "CryptoCompare"),
        published_at: new Date(Number(item.published_on || 0) * 1000).toISOString(),
        impact: 3,
        assets: categories,
        direction: "neutral",
        analysis: "实时新闻已归档；请结合价格结构、成交量与资金数据判断影响。",
      };
    });
  } catch (error) {
    console.error("实时新闻获取失败", error);
    return [];
  }
}

async function archiveNews(env, date, items) {
  if (!env.DB || items.length === 0) return;
  const statements = await Promise.all(items.map(async (item) => env.DB.prepare(`
    INSERT OR IGNORE INTO archived_news
      (fingerprint, archive_date, source_id, title, source, published_at, impact, assets, direction, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    await fingerprint(`${item.source}|${item.title}|${item.published_at}`),
    date,
    item.id,
    item.title,
    item.source,
    item.published_at,
    item.impact,
    JSON.stringify(item.assets),
    item.direction,
    item.analysis,
  )));
  await env.DB.batch(statements);
}

async function readNewsArchive(env, date) {
  if (!env.DB) return date === shanghaiDate() ? fetchLiveNews() : [];
  if (date === shanghaiDate()) await archiveNews(env, date, await fetchLiveNews());
  const result = await env.DB.prepare(`
    SELECT source_id, title, source, published_at, impact, assets, direction, analysis
    FROM archived_news WHERE archive_date = ? ORDER BY published_at DESC
  `).bind(date).all();
  return (result.results || []).map((item) => ({
    id: Number(item.source_id),
    title: item.title,
    source: item.source,
    published_at: item.published_at,
    impact: Number(item.impact),
    assets: JSON.parse(item.assets || "[]"),
    direction: item.direction,
    analysis: item.analysis,
  }));
}

async function requestHyperliquid(payload) {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Hyperliquid 请求失败：${response.status}`);
  return response.json();
}

async function getHyperliquidMarkets() {
  try {
    const [metadata, contexts] = await requestHyperliquid({ type: "metaAndAssetCtxs" });
    return metadata.universe.flatMap((item, index) => {
      if (item.isDelisted) return [];
      const context = contexts[index] ?? {};
      const price = Number(context.markPx);
      if (!Number.isFinite(price) || price <= 0) return [];
      const previous = Number(context.prevDayPx || price);
      const change = previous ? ((price - previous) / previous) * 100 : 0;
      return [{
        symbol: String(item.name).toUpperCase(), price,
        change_24h: Number(change.toFixed(4)),
        volume: Number(context.dayNtlVlm || 0),
        volatility: Number(Math.abs(change).toFixed(4)),
        funding_rate: Number(context.funding || 0) * 100,
        open_interest: Number(context.openInterest || 0) * price,
        source: "live",
      }];
    });
  } catch {
    // 公共行情临时不可用时保留可操作的演示数据。
    return FALLBACK_MARKETS;
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`公开行情请求失败：${response.status}`);
  return response.json();
}

async function getPlatformMarket(symbol, platform) {
  const normalized = symbol.toUpperCase();
  if (platform === "hyperliquid") {
    return (await getHyperliquidMarkets()).find((item) => item.symbol === normalized) ?? null;
  }
  if (platform === "binance") {
    const instrument = `${normalized}USDT`;
    const [ticker, funding, interest] = await Promise.all([
      requestJson(`${BINANCE_FUTURES_URL}/fapi/v1/ticker/24hr?symbol=${instrument}`),
      requestJson(`${BINANCE_FUTURES_URL}/fapi/v1/premiumIndex?symbol=${instrument}`),
      requestJson(`${BINANCE_FUTURES_URL}/fapi/v1/openInterest?symbol=${instrument}`),
    ]);
    const price = Number(ticker.lastPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      symbol: normalized,
      price,
      change_24h: Number(ticker.priceChangePercent || 0),
      volatility: Math.abs(Number(ticker.priceChangePercent || 0)),
      volume: Number(ticker.quoteVolume || 0),
      funding_rate: Number(funding.lastFundingRate || 0) * 100,
      open_interest: Number(interest.openInterest || 0) * price,
      source: "live",
      platform,
    };
  }
  const instrument = `${normalized}-USDT-SWAP`;
  const [tickerPayload, fundingPayload, interestPayload] = await Promise.all([
    requestJson(`${OKX_API_URL}/api/v5/market/ticker?instId=${instrument}`),
    requestJson(`${OKX_API_URL}/api/v5/public/funding-rate?instId=${instrument}`),
    requestJson(`${OKX_API_URL}/api/v5/public/open-interest?instId=${instrument}`),
  ]);
  const ticker = tickerPayload.data?.[0];
  const funding = fundingPayload.data?.[0];
  const interest = interestPayload.data?.[0];
  const price = Number(ticker?.last);
  const open = Number(ticker?.open24h || price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const change = open > 0 ? (price - open) / open * 100 : 0;
  return {
    symbol: normalized,
    price,
    change_24h: Number(change.toFixed(4)),
    volatility: Number(Math.abs(change).toFixed(4)),
    volume: Number(ticker?.volCcy24h || 0) * price,
    funding_rate: Number(funding?.fundingRate || 0) * 100,
    open_interest: Number(interest?.oiCcy || 0) * price,
    source: "live",
    platform,
  };
}

async function getMarkets(platform = "hyperliquid") {
  if (platform === "hyperliquid") return getHyperliquidMarkets();
  const results = await Promise.allSettled(CORE_SYMBOLS.map((symbol) => getPlatformMarket(symbol, platform)));
  const liveBySymbol = new Map(results.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [[result.value.symbol, result.value]] : []
  )));
  return CORE_SYMBOLS.map((symbol) => liveBySymbol.get(symbol) || {
    ...FALLBACK_MARKETS.find((item) => item.symbol === symbol),
    platform,
  });
}

async function getCandles(symbol, interval, limit, platform = "hyperliquid") {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) return null;
  const endTime = Date.now();
  try {
    if (platform === "binance") {
      const items = await requestJson(
        `${BINANCE_FUTURES_URL}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${Math.min(limit, 1500)}`,
      );
      return items.map((item) => ({
        open_time: Number(item[0]), close_time: Number(item[6]), open: Number(item[1]),
        high: Number(item[2]), low: Number(item[3]), close: Number(item[4]), volume: Number(item[5]),
      })).sort((left, right) => left.open_time - right.open_time);
    }
    if (platform === "okx") {
      const okxInterval = { "1h": "1H", "4h": "4H", "1d": "1Dutc" }[interval] || interval;
      const payload = await requestJson(
        `${OKX_API_URL}/api/v5/market/candles?instId=${symbol}-USDT-SWAP&bar=${okxInterval}&limit=${Math.min(limit, 300)}`,
      );
      return (payload.data || []).map((item) => ({
        open_time: Number(item[0]), close_time: Number(item[0]) + intervalMs - 1,
        open: Number(item[1]), high: Number(item[2]), low: Number(item[3]),
        close: Number(item[4]), volume: Number(item[5]),
      })).sort((left, right) => left.open_time - right.open_time);
    }
    const items = await requestHyperliquid({
      type: "candleSnapshot",
      req: { coin: symbol, interval, startTime: endTime - intervalMs * limit, endTime },
    });
    return items.map((item) => ({
      open_time: item.t, close_time: item.T, open: Number(item.o), high: Number(item.h),
      low: Number(item.l), close: Number(item.c), volume: Number(item.v),
    })).sort((left, right) => left.open_time - right.open_time);
  } catch {
    return [];
  }
}

function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const multiplier = 2 / (period + 1);
  for (const current of values.slice(period)) value = (current - value) * multiplier + value;
  return value;
}

function calculateTechnicalIndicators(candles, now = Date.now()) {
  const completed = (candles || [])
    .filter((item) => item.close_time <= now)
    .sort((left, right) => left.open_time - right.open_time);
  const closes = completed.map((item) => Number(item.close)).filter((value) => Number.isFinite(value) && value > 0);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const previousEma20 = ema(closes.slice(0, -TECHNICAL_RULES.emaSlopeLookback), 20);
  const previousEma50 = ema(closes.slice(0, -TECHNICAL_RULES.emaSlopeLookback), 50);
  const slope = (current, previous) => current !== null && previous
    ? (current / previous - 1) * 100 : null;
  let rsi14 = null;
  if (closes.length >= 15) {
    const changes = closes.slice(-15).slice(1).map((current, index) => current - closes.slice(-15)[index]);
    const averageGain = changes.reduce((sum, change) => sum + Math.max(change, 0), 0) / 14;
    const averageLoss = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0) / 14;
    rsi14 = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;
  const macdSeries = [];
  for (let end = 26; end <= closes.length; end += 1) {
    const fast = ema(closes.slice(0, end), 12);
    const slow = ema(closes.slice(0, end), 26);
    if (fast !== null && slow !== null) macdSeries.push(fast - slow);
  }
  const macdSignal = ema(macdSeries, 9);
  let atr14 = null;
  if (completed.length >= 15) {
    const recent = completed.slice(-15);
    const ranges = recent.slice(1).map((current, index) => Math.max(
      current.high - current.low,
      Math.abs(current.high - recent[index].close),
      Math.abs(current.low - recent[index].close),
    ));
    atr14 = ranges.reduce((sum, value) => sum + value, 0) / 14;
  }
  let volumeRatio = null;
  if (completed.length >= 21) {
    const recent = completed.slice(-21);
    const average = recent.slice(0, -1).reduce((sum, item) => sum + Math.max(0, item.volume), 0) / 20;
    if (average > 0) volumeRatio = Math.max(0, recent.at(-1).volume) / average;
  }
  const lastClose = closes.at(-1) || 0;
  return {
    ema20: ema20 === null ? null : roundPrice(ema20),
    ema50: ema50 === null ? null : roundPrice(ema50),
    ema200: ema200 === null ? null : roundPrice(ema200),
    ema20_slope_percent: slope(ema20, previousEma20),
    ema50_slope_percent: slope(ema50, previousEma50),
    rsi14,
    macd,
    macd_signal: macdSignal,
    macd_histogram: macd !== null && macdSignal !== null ? macd - macdSignal : null,
    atr14,
    atr_percent: atr14 !== null && lastClose > 0 ? atr14 / lastClose * 100 : null,
    realized_volatility: null,
    volume_ratio: volumeRatio,
  };
}

function roundPrice(value) {
  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return Number(value.toFixed(digits));
}

function positionSizing({ direction, confidence, risk, entryRange, stopLoss, leverage, totalAmount, riskMultiplier = 1 }) {
  const marginCapRate = 0.3;
  const empty = { risk_budget_rate: 0, risk_budget_amount: 0, stop_distance_rate: 0, margin_amount: 0, position_value: 0, max_loss_amount: 0, margin_cap_rate: marginCapRate, capped: false };
  if (direction === "WAIT" || leverage <= 0) return empty;
  const entryMid = (entryRange[0] + entryRange[1]) / 2;
  const stopDistanceRate = entryMid > 0 ? Math.abs(entryMid - stopLoss) / entryMid : 0;
  if (stopDistanceRate <= 0) return empty;
  const baseRiskRate = { low: 0.01, medium: 0.0075, high: 0.005 }[risk] ?? 0.005;
  const riskBudgetRate = baseRiskRate * Math.max(0, Math.min(confidence, 100)) / 100
    * Math.max(0.5, Math.min(riskMultiplier, 1.05));
  const riskBudgetAmount = totalAmount * riskBudgetRate;
  const uncappedPositionValue = riskBudgetAmount / stopDistanceRate;
  const uncappedMargin = uncappedPositionValue / leverage;
  const marginAmount = Math.min(uncappedMargin, totalAmount * marginCapRate);
  const positionValue = marginAmount * leverage;
  return {
    risk_budget_rate: Number(riskBudgetRate.toFixed(6)), risk_budget_amount: Number(riskBudgetAmount.toFixed(2)),
    stop_distance_rate: Number(stopDistanceRate.toFixed(6)), margin_amount: Number(marginAmount.toFixed(2)),
    position_value: Number(positionValue.toFixed(2)), max_loss_amount: Number((positionValue * stopDistanceRate).toFixed(2)),
    margin_cap_rate: marginCapRate, capped: uncappedMargin > totalAmount * marginCapRate,
  };
}

function buildExecutionLevels(market, direction, risk, indicators) {
  if (direction === "WAIT") {
    const reference = roundPrice(market.price);
    return { entryRange: [reference, reference], stopLoss: reference, takeProfit: [reference, reference] };
  }
  if (indicators?.atr14 > 0) {
    const atr = Math.max(market.price * 0.0025, Math.min(market.price * 0.03, indicators.atr14));
    const sign = direction === "LONG" ? 1 : -1;
    const entryRange = [
      roundPrice(market.price - sign * atr * 0.75),
      roundPrice(market.price - sign * atr * 0.25),
    ].sort((left, right) => left - right);
    const entryMid = (entryRange[0] + entryRange[1]) / 2;
    const riskDistance = atr * 1.25;
    const stopLoss = roundPrice(entryMid - sign * riskDistance);
    return {
      entryRange,
      stopLoss,
      takeProfit: [
        roundPrice(entryMid + sign * riskDistance * 2),
        roundPrice(entryMid + sign * riskDistance * 3),
      ],
    };
  }
  const stopDistance = { low: 0.02, medium: 0.026, high: 0.035 }[risk] ?? 0.035;
  return direction === "SHORT" ? {
    entryRange: [roundPrice(market.price * 1.003), roundPrice(market.price * 1.008)],
    stopLoss: roundPrice(market.price * (1 + stopDistance)),
    takeProfit: [roundPrice(market.price * 0.965), roundPrice(market.price * 0.928)],
  } : {
    entryRange: [roundPrice(market.price * 0.992), roundPrice(market.price * 0.997)],
    stopLoss: roundPrice(market.price * (1 - stopDistance)),
    takeProfit: [roundPrice(market.price * 1.035), roundPrice(market.price * 1.072)],
  };
}

function analyzeMarket(market, totalAmount, indicators, historyPolicy = null) {
  let trend = Math.max(0, Math.min(30, Math.round(18 + Math.abs(market.change_24h) * 2)));
  let structure = Math.max(0, Math.min(25, Math.round(17 + Math.abs(market.change_24h) - market.volatility * 0.8)));
  const capital = Math.max(0, Math.min(20, Math.round(15 - Math.abs(market.funding_rate) * 100)));
  let direction = "WAIT";
  const failures = [];
  let movingAverageReason = "EMA20/50/200 数据不足，均线方向不明确";
  if (market.source !== "live") failures.push("当前仅有演示行情，禁止生成可执行决策");
  if (indicators && [indicators.ema20, indicators.ema50, indicators.ema200].every(Number.isFinite)) {
    if (indicators.ema20 > indicators.ema50 && indicators.ema50 > indicators.ema200) {
      direction = "LONG";
      trend = 30;
      movingAverageReason = "EMA20 > EMA50 > EMA200，均线形成明确多头排列";
    } else if (indicators.ema20 < indicators.ema50 && indicators.ema50 < indicators.ema200) {
      direction = "SHORT";
      trend = 30;
      movingAverageReason = "EMA20 < EMA50 < EMA200，均线形成明确空头排列";
    } else {
      trend = Math.min(trend, 20);
      failures.push("EMA20/50/200 交叉、走平或排列混乱");
    }
    if (Number.isFinite(indicators.rsi14)) {
      structure = Math.max(8, Math.min(25, Math.round(25 - Math.abs(indicators.rsi14 - 50) * 0.25)));
    }
  } else {
    failures.push(movingAverageReason);
  }
  if (direction !== "WAIT") {
    const spread = Math.abs(indicators.ema20 - indicators.ema200) / market.price * 100;
    const requiredSpread = Math.max(
      TECHNICAL_RULES.minimumEmaSpreadPercent,
      Math.min(
        TECHNICAL_RULES.maximumEmaSpreadThreshold,
        (indicators.atr_percent || 0) * TECHNICAL_RULES.maximumEmaSpreadAtrFactor,
      ),
    );
    if (spread < requiredSpread) failures.push(`均线总间距 ${spread.toFixed(2)}% 不足`);
    if (direction === "LONG" && market.price < indicators.ema50) failures.push("当前价格跌破 EMA50");
    if (direction === "SHORT" && market.price > indicators.ema50) failures.push("当前价格站上 EMA50");
    if (direction === "LONG" && indicators.rsi14 >= TECHNICAL_RULES.longRsiExhaustion) failures.push("RSI 多头过热");
    if (direction === "SHORT" && indicators.rsi14 <= TECHNICAL_RULES.shortRsiExhaustion) failures.push("RSI 空头过冷");
    if ([indicators.ema20_slope_percent, indicators.ema50_slope_percent].every(Number.isFinite)) {
      const slopeConflict = direction === "LONG"
        ? indicators.ema20_slope_percent <= 0 || indicators.ema50_slope_percent <= 0
        : indicators.ema20_slope_percent >= 0 || indicators.ema50_slope_percent >= 0;
      if (slopeConflict) failures.push("EMA20 与 EMA50 斜率未共同支持当前方向");
    }
    if (Number.isFinite(indicators.volume_ratio)
      && indicators.volume_ratio < TECHNICAL_RULES.minimumVolumeRatio) failures.push("最新量能不足");
    const crowded = direction === "LONG"
      ? market.funding_rate >= TECHNICAL_RULES.maximumCrowdedFundingRate
      : market.funding_rate <= -TECHNICAL_RULES.maximumCrowdedFundingRate;
    if (crowded) failures.push("资金费率与方向同侧过度拥挤");
    if ([indicators.macd_histogram, indicators.rsi14].every(Number.isFinite)) {
      const momentumConflict = direction === "LONG"
        ? indicators.macd_histogram < 0 && indicators.rsi14 < 50
        : indicators.macd_histogram > 0 && indicators.rsi14 > 50;
      if (momentumConflict) failures.push("MACD 与 RSI 同时反向");
    }
    if (indicators.atr14 > 0) {
      const stretch = Math.abs(market.price - indicators.ema20) / indicators.atr14;
      const overextended = direction === "LONG" ? market.price > indicators.ema20 : market.price < indicators.ema20;
      if (overextended && stretch > TECHNICAL_RULES.maximumEntryStretchAtr) failures.push("价格偏离 EMA20 过远");
    }
  }
  if (failures.length > 0) {
    direction = "WAIT";
    trend = Math.min(trend, 20);
    structure = Math.min(structure, 15);
  }
  const scoreBreakdown = { trend, structure, capital, macro: 10, news: 7 };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  const thresholdAdjustment = Number(historyPolicy?.threshold_adjustment || 0);
  const effectiveThreshold = Math.max(50, Math.min(90, STRATEGY_PARAMETERS.min_trade_score + thresholdAdjustment));
  if (score < effectiveThreshold) direction = "WAIT";
  const risk = market.volatility > 6 ? "high" : market.volatility > 3 ? "medium" : "low";
  const { entryRange, stopLoss, takeProfit } = buildExecutionLevels(market, direction, risk, indicators);
  const leverage = risk === "medium" ? 3 : 2;
  const generatedAt = new Date().toISOString();
  return {
    symbol: market.symbol, instrument: `${market.symbol}-PERP`, direction, confidence: score, score,
    score_breakdown: scoreBreakdown, entry_range: entryRange, stop_loss: stopLoss,
    take_profit: takeProfit,
    leverage, risk,
    position_sizing: positionSizing({
      direction, confidence: score, risk, entryRange, stopLoss, leverage, totalAmount,
      riskMultiplier: Number(historyPolicy?.risk_multiplier || 1),
    }),
    indicators,
    reasons: [
      `24 小时涨跌 ${market.change_24h.toFixed(2)}%，趋势维度获得 ${trend}/30 分`,
      `当前波动率 ${market.volatility.toFixed(2)}%，技术结构维度获得 ${structure}/25 分`,
      `资金费率 ${market.funding_rate.toFixed(4)}%，资金维度获得 ${capital}/20 分`,
      failures.length > 0 ? `技术准入未通过：${failures.join("；")}` : movingAverageReason,
      `边缘规则使用 ${effectiveThreshold} 分准入阈值，宏观与新闻采用中性基线`,
    ],
    disclaimer: "仅供研究与辅助决策，不构成投资建议；系统不会自动向交易所下单。",
    source: market.source,
    platform: market.platform || "hyperliquid",
    funding_rate: market.funding_rate,
    analysis_engine: "rules",
    analysis_model: null,
    decision_schema_version: null,
    strategy_version: "v1",
    strategy_parameters: STRATEGY_PARAMETERS,
    reference_price: market.price,
    current_price: market.price,
    generated_at: generatedAt,
    plan_id: crypto.randomUUID().replaceAll("-", ""),
    decision_revision: 1,
    revision_reason: null,
    revision_history: [],
    soft_failure_count: 0,
    missed_entry_count: 0,
    decision_status: "watching",
    is_executable: false,
    status_reason: direction === "WAIT"
      ? failures.length > 0 ? `技术准入未通过：${failures.join("；")}` : "均线方向明确，但当前评分尚未达到可执行标准"
      : "已生成固定交易计划，等待价格进入计划入场区间",
  };
}

function refreshDecisionPlan(
  original, refreshed, currentPrice, timeframe, totalAmount, candles = [], historyPolicy = null, now = Date.now(),
) {
  const generatedAt = Date.parse(original.generated_at || "");
  const validityMs = DECISION_VALIDITY_MS[timeframe] || DECISION_VALIDITY_MS["4h"];
  if (original.direction === "WAIT" || !Number.isFinite(generatedAt) || now - generatedAt >= validityMs) {
    return refreshed;
  }
  const resizedPosition = positionSizing({
    direction: original.direction,
    confidence: refreshed.score,
    risk: original.risk,
    entryRange: original.entry_range,
    stopLoss: original.stop_loss,
    leverage: original.leverage,
    totalAmount,
    riskMultiplier: Number(historyPolicy?.risk_multiplier || 1),
  });
  if (["invalidated", "target_reached"].includes(original.decision_status)) {
    return { ...original, current_price: currentPrice, position_sizing: resizedPosition };
  }

  const [entryLow, entryHigh] = [...original.entry_range].sort((a, b) => a - b);
  const firstTarget = original.take_profit[0];
  const observedCandles = candles.filter((item) => item.open_time >= generatedAt && item.close_time <= now);
  const observedHigh = Math.max(currentPrice, ...observedCandles.map((item) => Number(item.high)));
  const observedLow = Math.min(currentPrice, ...observedCandles.map((item) => Number(item.low)));
  const targetReached = original.direction === "LONG" ? observedHigh >= firstTarget : observedLow <= firstTarget;
  const stopReached = original.direction === "LONG" ? observedLow <= original.stop_loss : observedHigh >= original.stop_loss;
  const thresholdAdjustment = Number(historyPolicy?.threshold_adjustment || 0);
  const effectiveThreshold = Math.max(50, Math.min(90, STRATEGY_PARAMETERS.min_trade_score + thresholdAdjustment));
  const keepPlan = (decisionStatus, statusReason, extra = {}) => ({
    ...original,
    confidence: refreshed.confidence,
    score: refreshed.score,
    score_breakdown: refreshed.score_breakdown,
    indicators: refreshed.indicators,
    source: refreshed.source,
    current_price: currentPrice,
    position_sizing: resizedPosition,
    decision_status: decisionStatus,
    is_executable: false,
    status_reason: statusReason,
    reasons: [statusReason, ...refreshed.reasons],
    soft_failure_count: 0,
    missed_entry_count: 0,
    ...extra,
  });
  let decisionStatus = "watching";
  let isExecutable = false;
  let statusReason;

  // 同一根 K 线无法确认触发先后时按止损优先，避免高估决策表现。
  if (stopReached) return keepPlan("invalidated", "价格已触及原决策结构止损，本轮计划失效");
  if (targetReached) return keepPlan("target_reached", "价格已达到原决策首个止盈目标，本轮预测完成，禁止追价入场");

  const directionFailure = refreshed.direction !== original.direction;
  const severeScoreDrop = refreshed.score < Math.max(0, effectiveThreshold - DECISION_SCORE_HYSTERESIS);
  if (directionFailure || severeScoreDrop) {
    const failureCount = Math.min(
      Number(original.soft_failure_count || 0) + 1, SOFT_FAILURE_CONFIRMATIONS,
    );
    if (failureCount >= SOFT_FAILURE_CONFIRMATIONS) {
      return keepPlan(
        "invalidated", "最新均线方向或综合评分已连续两次不满足原决策的可执行标准",
        { soft_failure_count: failureCount },
      );
    }
    return keepPlan(
      "confirming", "最新均线方向或评分首次异常，暂停执行并等待下一次复核确认",
      { soft_failure_count: failureCount },
    );
  }

  const releaseScore = Math.min(100, effectiveThreshold + DECISION_SCORE_HYSTERESIS);
  if (refreshed.direction === "WAIT" || refreshed.score < releaseScore) {
    return keepPlan("confirming", `最新评分处于确认缓冲区，达到 ${releaseScore} 分且方向一致后恢复执行判断`);
  }

  const referencePrice = Number(original.reference_price) || (entryLow + entryHigh) / 2;
  const favorableMiss = original.direction === "LONG"
    ? currentPrice > Math.max(entryHigh, referencePrice)
    : currentPrice < Math.min(entryLow, referencePrice);
  if (favorableMiss) {
    const missedEntryCount = Math.min(
      Number(original.missed_entry_count || 0) + 1, MISSED_ENTRY_CONFIRMATIONS,
    );
    const favorableEntry = original.direction === "LONG" ? entryHigh : entryLow;
    const targetDistance = Math.abs(firstTarget - favorableEntry);
    const missedDistance = Math.abs(currentPrice - favorableEntry);
    const targetProgress = targetDistance > 0 ? missedDistance / targetDistance : 1;
    const atr14 = Number(refreshed.indicators?.atr14);
    const withinAtr = Number.isFinite(atr14) && atr14 > 0 && missedDistance <= atr14 * MAX_MISSED_ENTRY_ATR;
    const newEntryMid = (refreshed.entry_range[0] + refreshed.entry_range[1]) / 2;
    const newRiskDistance = Math.abs(newEntryMid - refreshed.stop_loss);
    const newRewardDistance = Math.abs(refreshed.take_profit[0] - newEntryMid);
    const newRewardRisk = newRiskDistance > 0 ? newRewardDistance / newRiskDistance : 0;
    const revision = Number(original.decision_revision || 1);
    const canReprice = missedEntryCount >= MISSED_ENTRY_CONFIRMATIONS
      && revision < MAX_DECISION_REVISIONS
      && targetProgress < MAX_TARGET_PROGRESS
      && withinAtr
      && newRewardRisk >= MIN_REMAINING_REWARD_RISK;
    if (canReprice) {
      const nextRevision = revision + 1;
      const revisionReason = `价格朝原方向错过入场，偏离 ${roundPrice(missedDistance)}，目标进度 ${(targetProgress * 100).toFixed(1)}%，重新报价`;
      const leverage = Math.min(original.leverage, refreshed.leverage);
      const archived = {
        revision,
        reference_price: original.reference_price ?? null,
        entry_range: original.entry_range,
        stop_loss: original.stop_loss,
        take_profit: original.take_profit,
        leverage: original.leverage,
        risk: original.risk,
        score: original.score,
        confidence: original.confidence,
        generated_at: original.generated_at ?? null,
        archived_at: new Date(now).toISOString(),
        archive_reason: "missed_entry",
        revision_reason: original.revision_reason ?? null,
      };
      const reason = `已生成修订版 V${nextRevision}，等待价格进入新的计划入场区间`;
      return {
        ...original,
        ...refreshed,
        plan_id: original.plan_id,
        entry_range: refreshed.entry_range,
        stop_loss: refreshed.stop_loss,
        take_profit: refreshed.take_profit,
        leverage,
        position_sizing: positionSizing({
          direction: original.direction,
          confidence: refreshed.score,
          risk: refreshed.risk,
          entryRange: refreshed.entry_range,
          stopLoss: refreshed.stop_loss,
          leverage,
          totalAmount,
          riskMultiplier: Number(historyPolicy?.risk_multiplier || 1),
        }),
        reference_price: currentPrice,
        current_price: currentPrice,
        generated_at: new Date(now).toISOString(),
        decision_revision: nextRevision,
        revision_reason: revisionReason,
        revision_history: [...(original.revision_history || []), archived].slice(-MAX_DECISION_REVISIONS),
        soft_failure_count: 0,
        missed_entry_count: 0,
        decision_status: "watching",
        is_executable: false,
        status_reason: reason,
        reasons: [reason, revisionReason, ...refreshed.reasons],
      };
    }
    if (revision >= MAX_DECISION_REVISIONS) statusReason = "已达到最多两次重新报价（V3）上限，等待回踩当前计划区间";
    else if (targetProgress >= MAX_TARGET_PROGRESS) statusReason = `原目标路径已完成 ${(targetProgress * 100).toFixed(1)}%，禁止追价重新报价`;
    else if (!withinAtr) statusReason = "价格偏离超过 0.5 ATR 或 ATR 数据不足，等待回踩";
    else if (missedEntryCount < MISSED_ENTRY_CONFIRMATIONS) statusReason = "首次确认错过入场，等待下一次复核后再决定是否重新报价";
    else statusReason = `新计划剩余盈亏比 ${newRewardRisk.toFixed(2)} 不足，等待回踩`;
    return keepPlan("missed_entry", statusReason, { missed_entry_count: missedEntryCount });
  }

  if (currentPrice >= entryLow && currentPrice <= entryHigh) {
    const riskDistance = Math.abs(currentPrice - original.stop_loss);
    const rewardRisk = riskDistance > 0 ? Math.abs(firstTarget - currentPrice) / riskDistance : 0;
    if (rewardRisk >= MIN_REMAINING_REWARD_RISK) {
      decisionStatus = "executable";
      isExecutable = true;
      statusReason = `价格进入原入场区间，最新评分 ${refreshed.score} 分，剩余盈亏比 ${rewardRisk.toFixed(2)}`;
    } else {
      statusReason = `价格虽进入原入场区间，但剩余盈亏比 ${rewardRisk.toFixed(2)} 低于 ${MIN_REMAINING_REWARD_RISK}`;
    }
  } else if (original.direction === "LONG" && currentPrice > entryHigh) {
    statusReason = "价格高于原入场区间，等待回踩，禁止追涨";
  } else if (original.direction === "SHORT" && currentPrice < entryLow) {
    statusReason = "价格低于原入场区间，等待反弹，禁止追空";
  } else {
    statusReason = "价格已穿过原入场区间但尚未触及止损，等待重新进入计划区间";
  }

  return {
    ...original,
    confidence: refreshed.confidence,
    score: refreshed.score,
    score_breakdown: refreshed.score_breakdown,
    source: refreshed.source,
    current_price: currentPrice,
    position_sizing: resizedPosition,
    decision_status: decisionStatus,
    is_executable: isExecutable,
    status_reason: statusReason,
    reasons: [statusReason, ...refreshed.reasons],
    soft_failure_count: 0,
    missed_entry_count: 0,
  };
}

async function readDecisionPlans(env, ownerId, platform, timeframe) {
  if (!env.DB || !ownerId) return null;
  try {
    const row = await env.DB.prepare(`
      SELECT scan_json FROM owner_decision_plan_scans
      WHERE owner_id = ? AND platform = ? AND timeframe = ?
    `).bind(ownerId, platform, timeframe).first();
    return row?.scan_json ? JSON.parse(row.scan_json) : null;
  } catch (error) {
    console.error("边缘决策计划读取失败", error);
    return null;
  }
}

async function writeDecisionPlans(env, ownerId, platform, timeframe, scan) {
  if (!env.DB || !ownerId) return;
  try {
    await env.DB.prepare(`
      INSERT INTO owner_decision_plan_scans (owner_id, platform, timeframe, scan_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, platform, timeframe) DO UPDATE SET
        scan_json = excluded.scan_json,
        updated_at = excluded.updated_at
    `).bind(ownerId, platform, timeframe, JSON.stringify(scan), Date.now()).run();
  } catch (error) {
    console.error("边缘决策计划保存失败", error);
  }
}

function readEdgeHistoryPolicy(request, platform) {
  try {
    const raw = JSON.parse(request.headers.get("x-alpha-history-policy") || "{}").platforms?.[platform];
    if (!raw || typeof raw !== "object") return null;
    return {
      threshold_adjustment: Math.max(-2, Math.min(4, Number(raw.threshold_adjustment) || 0)),
      risk_multiplier: Math.max(0.5, Math.min(1.05, Number(raw.risk_multiplier) || 1)),
    };
  } catch {
    return null;
  }
}

async function handleApi(request, url, env) {
  const platform = ["hyperliquid", "binance", "okx"].includes(url.searchParams.get("platform"))
    ? url.searchParams.get("platform") : "hyperliquid";
  const candleMatch = url.pathname.match(/^\/api\/v1\/market\/([A-Za-z0-9]+)\/candles$/);
  if (request.method === "GET" && candleMatch) {
    const interval = url.searchParams.get("interval") || "1h";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 120)));
    const candles = await getCandles(candleMatch[1].toUpperCase(), interval, limit, platform);
    return candles === null ? json({ detail: "不支持的 K 线周期" }, 422) : json(candles);
  }

  const marketMatch = url.pathname.match(/^\/api\/v1\/market\/([A-Za-z0-9]+)$/);
  if (request.method === "GET" && marketMatch) {
    const symbol = marketMatch[1].toUpperCase();
    const market = await getPlatformMarket(symbol, platform).catch(() => null);
    return market ? json(market) : json({ detail: "暂不支持该交易品种" }, 404);
  }

  if (url.pathname === "/api/v1/ai/analyze" && request.method === "POST") {
    const payload = await request.json();
    const symbol = String(payload.symbol || "").toUpperCase();
    const timeframe = INTERVAL_MS[payload.timeframe] ? payload.timeframe : "4h";
    if (!/^[A-Z0-9]{1,32}$/.test(symbol)) return json({ detail: "币种格式不正确" }, 422);
    const market = await getPlatformMarket(symbol, platform).catch(() => null);
    const totalAmount = Number(request.headers.get("x-alpha-owner-capital") || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return json({ detail: "缺少已验证的资金设置" }, 503);
    if (!market) return json({ detail: "暂不支持该交易品种" }, 404);
    const candles = await getCandles(symbol, timeframe, 205, platform);
    return json(analyzeMarket(
      market, totalAmount, calculateTechnicalIndicators(candles || []), readEdgeHistoryPolicy(request, platform),
    ));
  }

  if (url.pathname === "/api/v1/ai/opportunities" && request.method === "GET") {
    const totalAmount = Number(request.headers.get("x-alpha-owner-capital") || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return json({ detail: "缺少已验证的资金设置" }, 503);
    const limit = Math.min(4, Math.max(1, Number(url.searchParams.get("limit") || 4)));
    const timeframe = INTERVAL_MS[url.searchParams.get("timeframe")] ? url.searchParams.get("timeframe") : "4h";
    const markets = await getMarkets(platform);
    const eligible = markets.filter((market) => market.volume >= 500_000 && market.open_interest >= 250_000);
    const historyPolicy = readEdgeHistoryPolicy(request, platform);
    const candlesBySymbol = new Map();
    const refreshed = (await Promise.all(eligible.map(async (market) => {
      const candles = await getCandles(market.symbol, timeframe, 205, platform) || [];
      candlesBySymbol.set(market.symbol, candles);
      return analyzeMarket(market, totalAmount, calculateTechnicalIndicators(candles), historyPolicy);
    })))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 2, 12));
    const ownerId = request.headers.get("x-alpha-owner-id");
    const previous = await readDecisionPlans(env, ownerId, platform, timeframe);
    const previousBySymbol = new Map((previous?.opportunities || []).map((item) => [item.symbol, item]));
    const priceBySymbol = new Map(eligible.map((market) => [market.symbol, market.price]));
    const opportunities = refreshed
      .map((item) => previousBySymbol.has(item.symbol)
        ? refreshDecisionPlan(
          previousBySymbol.get(item.symbol), item, priceBySymbol.get(item.symbol), timeframe,
          totalAmount, candlesBySymbol.get(item.symbol), historyPolicy,
        )
        : item)
      .sort((a, b) => Number(b.is_executable) - Number(a.is_executable)
        || Number(b.decision_status === "watching") - Number(a.decision_status === "watching")
        || b.score - a.score)
      .slice(0, limit);
    const scan = { scanned_markets: markets.length, eligible_markets: eligible.length, updated_at: new Date().toISOString(), opportunities, scan_source: "edge_live_scan", platform };
    await writeDecisionPlans(env, ownerId, platform, timeframe, scan);
    return json(scan);
  }

  if (url.pathname === "/api/v1/news" && request.method === "GET") {
    const date = url.searchParams.get("date") || shanghaiDate();
    const items = await readNewsArchive(env, date);
    return json({ date, total: items.length, items, platform: "hyperliquid" });
  }
  if (url.pathname === "/api/v1/news/latest" && request.method === "GET") {
    return json(await readNewsArchive(env, shanghaiDate()));
  }

  return json({ detail: "接口不存在" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, url, env);

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    // Service Worker 预缓存请求的 Accept 可能是 */*，应用入口仍需回退到 index.html。
    const isAppEntry = url.pathname === "/" || url.pathname === "/app";
    if (response.status !== 404 || (!acceptsHtml && !isAppEntry) || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
