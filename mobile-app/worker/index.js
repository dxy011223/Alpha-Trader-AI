const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STRATEGY_PARAMETERS = {
  min_trade_score: 70,
  trend_weight: 30,
  structure_weight: 25,
  capital_weight: 20,
  macro_weight: 15,
  news_weight: 10,
};
const AI_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "symbol", "direction", "confidence", "score", "trend", "structure", "capital", "macro", "news",
          "entry_range", "stop_loss", "take_profit", "leverage", "risk", "position_sizing", "reasons",
        ],
        properties: {
          symbol: { type: "string" },
          direction: { type: "string", enum: ["LONG", "SHORT", "WAIT"] },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          score: { type: "integer", minimum: 0, maximum: 100 },
          trend: { type: "integer", minimum: 0, maximum: 30 },
          structure: { type: "integer", minimum: 0, maximum: 25 },
          capital: { type: "integer", minimum: 0, maximum: 20 },
          macro: { type: "integer", minimum: 0, maximum: 15 },
          news: { type: "integer", minimum: 0, maximum: 10 },
          entry_range: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 } },
          stop_loss: { type: "number", exclusiveMinimum: 0 },
          take_profit: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 } },
          leverage: { type: "integer", minimum: 1, maximum: 20 },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          position_sizing: {
            type: "object",
            additionalProperties: false,
            required: [
              "risk_budget_rate", "risk_budget_amount", "stop_distance_rate", "margin_amount",
              "position_value", "max_loss_amount", "margin_cap_rate", "capped",
            ],
            properties: {
              risk_budget_rate: { type: "number", minimum: 0, maximum: 0.02 },
              risk_budget_amount: { type: "number", minimum: 0 },
              stop_distance_rate: { type: "number", minimum: 0, maximum: 1 },
              margin_amount: { type: "number", minimum: 0 },
              position_value: { type: "number", minimum: 0 },
              max_loss_amount: { type: "number", minimum: 0 },
              margin_cap_rate: { type: "number", minimum: 0, maximum: 1 },
              capped: { type: "boolean" },
            },
          },
          reasons: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        },
      },
    },
  },
};
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

function nearlyEqual(actual, expected, relativeTolerance = 0.03, absoluteTolerance = 0.01) {
  return Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance);
}

function validateAiDecision(decision, market, totalAmount) {
  const numericFields = ["confidence", "score", "trend", "structure", "capital", "macro", "news", "stop_loss", "leverage"];
  if (!decision || typeof decision !== "object" || numericFields.some((field) => !Number.isFinite(decision[field]))) {
    throw new Error("AI 决策字段不完整");
  }
  if (!Number.isInteger(decision.confidence) || decision.confidence < 0 || decision.confidence > 100
    || !Number.isInteger(decision.score) || decision.score < 0 || decision.score > 100
    || !Number.isInteger(decision.leverage) || decision.leverage < 1 || decision.leverage > 20
    || !["low", "medium", "high"].includes(decision.risk)) {
    throw new Error("AI 决策范围无效");
  }
  const scoreBreakdown = {
    trend: decision.trend,
    structure: decision.structure,
    capital: decision.capital,
    macro: decision.macro,
    news: decision.news,
  };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  if (score !== decision.score) throw new Error("AI 总评分与五维评分不一致");
  for (const factor of Object.keys(scoreBreakdown)) {
    if (scoreBreakdown[factor] < 0 || scoreBreakdown[factor] > STRATEGY_PARAMETERS[`${factor}_weight`]) {
      throw new Error(`AI 的 ${factor} 评分超过策略权重`);
    }
  }
  if (!['LONG', 'SHORT', 'WAIT'].includes(decision.direction)) throw new Error("AI 方向无效");
  if (decision.direction !== "WAIT" && score < STRATEGY_PARAMETERS.min_trade_score) {
    throw new Error("AI 可执行方向未达到评分阈值");
  }
  if (!Array.isArray(decision.entry_range) || decision.entry_range.length !== 2
    || !decision.entry_range.every((value) => Number.isFinite(value) && value > 0)
    || !Array.isArray(decision.take_profit) || decision.take_profit.length !== 2
    || !decision.take_profit.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("AI 价格区间无效");
  }
  const entryRange = [...decision.entry_range].sort((a, b) => a - b);
  if (decision.direction === "LONG" && !(decision.stop_loss < entryRange[0]
    && decision.take_profit[0] > entryRange[1] && decision.take_profit[1] > decision.take_profit[0])) {
    throw new Error("AI 多头止盈止损边界无效");
  }
  if (decision.direction === "SHORT" && !(decision.stop_loss > entryRange[1]
    && decision.take_profit[0] < entryRange[0] && decision.take_profit[1] < decision.take_profit[0])) {
    throw new Error("AI 空头止盈止损边界无效");
  }
  const sizing = decision.position_sizing;
  const sizingFields = ["risk_budget_rate", "risk_budget_amount", "stop_distance_rate", "margin_amount", "position_value", "max_loss_amount", "margin_cap_rate"];
  if (!sizing || sizingFields.some((field) => !Number.isFinite(sizing[field])) || typeof sizing.capped !== "boolean") {
    throw new Error("AI 仓位计算字段无效");
  }
  if (sizing.risk_budget_rate < 0 || sizing.risk_budget_rate > 0.02
    || sizing.risk_budget_amount < 0 || sizing.stop_distance_rate < 0 || sizing.stop_distance_rate > 1
    || sizing.margin_amount < 0 || sizing.position_value < 0 || sizing.max_loss_amount < 0
    || sizing.margin_cap_rate < 0 || sizing.margin_cap_rate > 1) {
    throw new Error("AI 仓位计算范围无效");
  }
  if (decision.direction === "WAIT") {
    if (sizing.margin_amount !== 0 || sizing.position_value !== 0 || sizing.max_loss_amount !== 0) {
      throw new Error("AI 观望决策不得分配仓位");
    }
  } else {
    const entryMid = (entryRange[0] + entryRange[1]) / 2;
    const expectedStopRate = Math.abs(entryMid - decision.stop_loss) / entryMid;
    const marginCap = totalAmount * sizing.margin_cap_rate;
    const uncappedMargin = sizing.risk_budget_amount / sizing.stop_distance_rate / decision.leverage;
    if (sizing.margin_amount <= 0 || sizing.position_value <= 0
      || !nearlyEqual(sizing.stop_distance_rate, expectedStopRate, 0.02, 0.000001)
      || !nearlyEqual(sizing.risk_budget_amount, totalAmount * sizing.risk_budget_rate)
      || !nearlyEqual(sizing.position_value, sizing.margin_amount * decision.leverage)
      || !nearlyEqual(sizing.max_loss_amount, sizing.position_value * sizing.stop_distance_rate)
      || !nearlyEqual(sizing.margin_amount, Math.min(uncappedMargin, marginCap))
      || sizing.capped !== (uncappedMargin > marginCap)) {
      throw new Error("AI 仓位计算未通过一致性校验");
    }
  }
  if (!Array.isArray(decision.reasons) || decision.reasons.length < 2 || decision.reasons.length > 4
    || decision.reasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
    throw new Error("AI 决策理由不完整");
  }
  return {
    symbol: market.symbol,
    instrument: `${market.symbol}-PERP`,
    direction: decision.direction,
    confidence: decision.confidence,
    score,
    score_breakdown: scoreBreakdown,
    entry_range: entryRange,
    stop_loss: decision.stop_loss,
    take_profit: decision.take_profit,
    leverage: decision.leverage,
    risk: decision.risk,
    position_sizing: sizing,
    indicators: null,
    reasons: decision.reasons.map((reason) => String(reason).trim()).filter(Boolean),
    disclaimer: "仅供研究与辅助决策，不构成投资建议；系统不会自动向交易所下单。",
    source: market.source,
    platform: "hyperliquid",
    analysis_engine: "openai",
    analysis_model: AI_MODEL,
    decision_schema_version: "ai_full_v1",
    strategy_version: "v1",
    strategy_parameters: STRATEGY_PARAMETERS,
  };
}

async function generateAiDecisions(env, markets, totalAmount, timeframe) {
  if (!env.AI?.run) throw new Error("Cloudflare AI 绑定未配置");
  const [candleSets, news] = await Promise.all([
    Promise.all(markets.map((market) => getCandles(market.symbol, timeframe, 24))),
    fetchLiveNews(),
  ]);
  const context = {
    timeframe,
    total_amount: totalAmount,
    strategy_parameters: STRATEGY_PARAMETERS,
    markets: markets.map((market, index) => ({ ...market, recent_candles: (candleSets[index] || []).slice(-20) })),
    recent_news: news.slice(0, 8).map(({ title, source, published_at, assets, direction, impact }) => (
      { title, source, published_at, assets, direction, impact }
    )),
  };
  const result = await env.AI.run(AI_MODEL, {
    messages: [
      {
        role: "system",
        content: "你是本系统唯一的交易决策与计算引擎。根据市场、K线、新闻、资金和策略参数，独立制定每个候选币种的方向、五维评分、置信度、入场区间、止损、两个止盈、杠杆、风险等级和完整仓位。五维评分不得超过对应权重且总分必须等于五维之和；低于 min_trade_score 必须 WAIT。LONG 止损低于入场且止盈递增，SHORT 相反。风险预算金额=总资金×风险预算率，开仓价值=保证金×杠杆，最大亏损=开仓价值×止损距离率；WAIT 的保证金、开仓价值和最大亏损必须为 0。必须逐一返回全部币种，理由使用简洁中文，不得声称已下单或保证收益。",
      },
      { role: "user", content: JSON.stringify(context) },
    ],
    response_format: { type: "json_schema", json_schema: AI_DECISION_SCHEMA },
    temperature: 0.1,
    max_tokens: 6000,
  });
  const payload = typeof result?.response === "string" ? JSON.parse(result.response) : result?.response;
  if (!payload || !Array.isArray(payload.decisions)) throw new Error("Cloudflare AI 响应格式无效");
  const decisions = new Map(payload.decisions.map((decision) => [String(decision.symbol || "").toUpperCase(), decision]));
  if (decisions.size !== payload.decisions.length || decisions.size !== markets.length
    || markets.some((market) => !decisions.has(market.symbol))) {
    throw new Error("Cloudflare AI 返回的决策币种不完整");
  }
  return markets.map((market) => validateAiDecision(decisions.get(market.symbol), market, totalAmount));
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
    if (!market) return json({ detail: "暂不支持该交易品种" }, 404);
    try {
      const [decision] = await generateAiDecisions(env, [market], totalAmount, payload.timeframe || "1h");
      return json(decision);
    } catch (error) {
      console.error(JSON.stringify({ message: "Cloudflare AI 决策生成失败", error: String(error?.message || error) }));
      return json({ detail: "AI 决策暂时不可用，请稍后重试" }, 503);
    }
  }

  if (url.pathname === "/api/v1/ai/opportunities" && request.method === "GET") {
    const totalAmount = Number(request.headers.get("x-alpha-owner-capital") || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return json({ detail: "缺少已验证的资金设置" }, 503);
    const markets = await getMarkets();
    const eligible = markets.filter((market) => market.volume >= 500_000 && market.open_interest >= 250_000);
    const limit = Math.min(8, Math.max(4, Number(url.searchParams.get("limit") || 8)));
    const candidates = eligible.sort((a, b) => b.volume - a.volume).slice(0, limit);
    try {
      const opportunities = (await generateAiDecisions(env, candidates, totalAmount, url.searchParams.get("timeframe") || "1h"))
        .sort((a, b) => b.score - a.score);
      return json({ scanned_markets: markets.length, eligible_markets: eligible.length, updated_at: new Date().toISOString(), opportunities, scan_source: "live_scan", platform: "hyperliquid" });
    } catch (error) {
      console.error(JSON.stringify({ message: "Cloudflare AI 机会扫描失败", error: String(error?.message || error) }));
      return json({ detail: "AI 决策暂时不可用，请稍后重试" }, 503);
    }
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
