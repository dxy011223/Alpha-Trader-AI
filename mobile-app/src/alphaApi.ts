export type AssetSymbol = string;
export type MarketInterval = "1m" | "5m" | "1h" | "4h" | "1d";

export interface MarketSnapshot {
  symbol: AssetSymbol;
  price: number;
  change_24h: number;
  volume: number;
  volatility: number;
  funding_rate: number;
  open_interest: number;
  source: "live" | "demo";
}

export interface Candle {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItem {
  id: number;
  title: string;
  source: string;
  published_at: string;
  impact: number;
  assets: string[];
  direction: "bullish" | "bearish" | "neutral";
  analysis: string;
}

export interface NewsArchiveResponse {
  date: string;
  total: number;
  items: NewsItem[];
}

export interface AnalysisResponse {
  symbol: AssetSymbol;
  instrument: string;
  direction: "LONG" | "SHORT" | "WAIT";
  confidence: number;
  score: number;
  score_breakdown: {
    trend: number;
    structure: number;
    capital: number;
    macro: number;
    news: number;
  };
  entry_range: number[];
  stop_loss: number;
  take_profit: number[];
  leverage: number;
  risk: "low" | "medium" | "high";
  position_sizing: {
    risk_budget_rate: number;
    risk_budget_amount: number;
    stop_distance_rate: number;
    margin_amount: number;
    position_value: number;
    max_loss_amount: number;
    margin_cap_rate: number;
    capped: boolean;
  };
  reasons: string[];
  disclaimer: string;
  source: "live" | "demo";
}

export interface OpportunityScanResponse {
  scanned_markets: number;
  eligible_markets: number;
  updated_at: string;
  opportunities: AnalysisResponse[];
}

export interface CapitalSettings {
  total_amount: number;
  currency: "USDT";
  updated_at: string;
}

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/$/, "");

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
  });

  if (!response.ok) {
    throw new Error(`行情接口请求失败：${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function loadMarket(symbol: AssetSymbol, signal?: AbortSignal) {
  return request<MarketSnapshot>(`/market/${symbol}`, { signal });
}

export function loadCandles(
  symbol: AssetSymbol,
  interval: MarketInterval,
  limit = 80,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ interval, limit: String(limit) });
  return request<Candle[]>(`/market/${symbol}/candles?${query}`, { signal });
}

export function loadNews(date: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ date });
  return request<NewsArchiveResponse>(`/news?${query}`, { signal });
}

export function loadAnalysis(symbol: AssetSymbol, timeframe: MarketInterval, signal?: AbortSignal) {
  return request<AnalysisResponse>("/ai/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, timeframe }),
    signal,
  });
}

export function loadOpportunities(timeframe: MarketInterval, signal?: AbortSignal) {
  const query = new URLSearchParams({ timeframe, limit: "8" });
  return request<OpportunityScanResponse>(`/ai/opportunities?${query}`, { signal });
}

export function loadCapitalSettings(signal?: AbortSignal) {
  return request<CapitalSettings>("/settings/capital", { signal });
}

export function saveCapitalSettings(totalAmount: number, signal?: AbortSignal) {
  return request<CapitalSettings>("/settings/capital", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ total_amount: totalAmount, currency: "USDT" }),
    signal,
  });
}
