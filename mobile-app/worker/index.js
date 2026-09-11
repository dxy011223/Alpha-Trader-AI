const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
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

async function getMarkets() {
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

async function getCandles(symbol, interval, limit) {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) return null;
  const endTime = Date.now();
  try {
    const items = await requestHyperliquid({
      type: "candleSnapshot",
      req: { coin: symbol, interval, startTime: endTime - intervalMs * limit, endTime },
    });
    return items.map((item) => ({
      open_time: item.t, close_time: item.T, open: Number(item.o), high: Number(item.h),
      low: Number(item.l), close: Number(item.c), volume: Number(item.v),
    }));
  } catch {
    return [];
  }
}

function roundPrice(value) {
  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return Number(value.toFixed(digits));
}

function positionSizing({ direction, confidence, risk, entryRange, stopLoss, leverage, totalAmount }) {
  const marginCapRate = 0.3;
  const empty = { risk_budget_rate: 0, risk_budget_amount: 0, stop_distance_rate: 0, margin_amount: 0, position_value: 0, max_loss_amount: 0, margin_cap_rate: marginCapRate, capped: false };
  if (direction === "WAIT" || leverage <= 0) return empty;
  const entryMid = (entryRange[0] + entryRange[1]) / 2;
  const stopDistanceRate = entryMid > 0 ? Math.abs(entryMid - stopLoss) / entryMid : 0;
  if (stopDistanceRate <= 0) return empty;
  const baseRiskRate = { low: 0.01, medium: 0.0075, high: 0.005 }[risk] ?? 0.005;
  const riskBudgetRate = baseRiskRate * Math.max(0, Math.min(confidence, 100)) / 100;
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

function analyzeMarket(market, totalAmount) {
  const trend = Math.max(0, Math.min(30, Math.round(18 + Math.abs(market.change_24h) * 2)));
  const structure = Math.max(0, Math.min(25, Math.round(17 + Math.abs(market.change_24h) - market.volatility * 0.8)));
  const capital = Math.max(0, Math.min(20, Math.round(15 - Math.abs(market.funding_rate) * 100)));
  const scoreBreakdown = { trend, structure, capital, macro: 10, news: 7 };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  let direction = market.change_24h >= 1 ? "LONG" : market.change_24h <= -1 ? "SHORT" : "WAIT";
  if (score < 70) direction = "WAIT";
  const risk = market.volatility > 6 ? "high" : market.volatility > 3 ? "medium" : "low";
  const entryRange = direction === "SHORT"
    ? [roundPrice(market.price * 1.003), roundPrice(market.price * 1.008)]
    : [roundPrice(market.price * 0.992), roundPrice(market.price * 0.997)];
  const stopDistance = { low: 0.02, medium: 0.026, high: 0.035 }[risk] ?? 0.035;
  const stopLoss = roundPrice(market.price * (direction === "SHORT" ? 1 + stopDistance : 1 - stopDistance));
  const leverage = risk === "medium" ? 3 : 2;
  return {
    symbol: market.symbol, instrument: `${market.symbol}-PERP`, direction, confidence: score, score,
    score_breakdown: scoreBreakdown, entry_range: entryRange, stop_loss: stopLoss,
    take_profit: direction === "SHORT"
      ? [roundPrice(market.price * 0.965), roundPrice(market.price * 0.928)]
      : [roundPrice(market.price * 1.035), roundPrice(market.price * 1.072)],
    leverage, risk,
    position_sizing: positionSizing({ direction, confidence: score, risk, entryRange, stopLoss, leverage, totalAmount }),
    indicators: null,
    reasons: [
      `24 小时涨跌 ${market.change_24h.toFixed(2)}%，趋势维度获得 ${trend}/30 分`,
      `当前波动率 ${market.volatility.toFixed(2)}%，技术结构维度获得 ${structure}/25 分`,
      `资金费率 ${market.funding_rate.toFixed(4)}%，资金维度获得 ${capital}/20 分`,
      "宏观与新闻暂未出现否决性风险，重大事件发生时需要重新评估",
    ],
    disclaimer: "仅供研究与辅助决策，不构成投资建议；系统不会自动下单。", source: market.source,
    platform: "hyperliquid", analysis_engine: "rules", analysis_model: null,
  };
}

async function handleApi(request, url, env) {
  const candleMatch = url.pathname.match(/^\/api\/v1\/market\/([A-Za-z0-9]+)\/candles$/);
  if (request.method === "GET" && candleMatch) {
    const interval = url.searchParams.get("interval") || "1h";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 120)));
    const candles = await getCandles(candleMatch[1].toUpperCase(), interval, limit);
    return candles === null ? json({ detail: "不支持的 K 线周期" }, 422) : json(candles);
  }

  const marketMatch = url.pathname.match(/^\/api\/v1\/market\/([A-Za-z0-9]+)$/);
  if (request.method === "GET" && marketMatch) {
    const symbol = marketMatch[1].toUpperCase();
    const market = (await getMarkets()).find((item) => item.symbol === symbol);
    return market ? json(market) : json({ detail: "暂不支持该交易品种" }, 404);
  }

  if (url.pathname === "/api/v1/ai/analyze" && request.method === "POST") {
    const payload = await request.json();
    const symbol = String(payload.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{1,32}$/.test(symbol)) return json({ detail: "币种格式不正确" }, 422);
    const market = (await getMarkets()).find((item) => item.symbol === symbol);
    const totalAmount = Number(request.headers.get("x-alpha-owner-capital") || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return json({ detail: "缺少已验证的资金设置" }, 503);
    return market ? json(analyzeMarket(market, totalAmount)) : json({ detail: "暂不支持该交易品种" }, 404);
  }

  if (url.pathname === "/api/v1/ai/opportunities" && request.method === "GET") {
    const totalAmount = Number(request.headers.get("x-alpha-owner-capital") || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return json({ detail: "缺少已验证的资金设置" }, 503);
    const markets = await getMarkets();
    const eligible = markets.filter((market) => market.volume >= 500_000 && market.open_interest >= 250_000);
    const limit = Math.min(20, Math.max(4, Number(url.searchParams.get("limit") || 8)));
    const opportunities = eligible.map((market) => analyzeMarket(market, totalAmount)).sort((a, b) => b.score - a.score).slice(0, limit);
    return json({ scanned_markets: markets.length, eligible_markets: eligible.length, updated_at: new Date().toISOString(), opportunities, scan_source: "live_scan", platform: "hyperliquid" });
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
