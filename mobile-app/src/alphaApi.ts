import { Capacitor, registerPlugin } from "@capacitor/core";

import type { SimulationWalletState } from "./simulationTrading";

export type AssetSymbol = string;
export type MarketInterval = "1m" | "5m" | "1h" | "4h" | "1d";
export type MarketPlatform = "hyperliquid" | "binance" | "okx";

export interface MarketSnapshot {
  symbol: AssetSymbol;
  price: number;
  change_24h: number;
  volume: number;
  volatility: number;
  funding_rate: number;
  open_interest: number;
  source: "live" | "demo";
  platform: MarketPlatform;
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
  platform: MarketPlatform;
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
  indicators?: {
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    rsi14: number | null;
    macd: number | null;
    macd_signal: number | null;
    macd_histogram: number | null;
    atr14: number | null;
    atr_percent: number | null;
    realized_volatility: number | null;
  } | null;
  reasons: string[];
  disclaimer: string;
  source: "live" | "demo";
  analysis_engine: "openai" | "rules";
  analysis_model: string | null;
  decision_schema_version?: "ai_full_v1" | null;
  platform: MarketPlatform;
  strategy_version?: string;
  strategy_parameters?: Record<string, number>;
  reference_price?: number | null;
  current_price?: number | null;
  generated_at?: string | null;
  decision_status?: "watching" | "executable" | "invalidated" | "target_reached";
  is_executable?: boolean;
  status_reason?: string;
}

export interface OpportunityScanResponse {
  scanned_markets: number;
  eligible_markets: number;
  updated_at: string;
  opportunities: AnalysisResponse[];
  scan_source: "live_scan" | "scheduled_cache";
  platform: MarketPlatform;
}

export interface CapitalSettings {
  total_amount: number;
  currency: "USDT";
  updated_at: string;
}

export interface DecisionExecution {
  id: number;
  status: "active" | "completed" | "cancelled";
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  total_amount: number;
  allocated_amount: number;
  started_at: string;
  completed_at: string | null;
}

export interface PositionRecord {
  id: number;
  decision_id: number;
  wallet_address: string | null;
  symbol: string;
  direction: "LONG" | "SHORT";
  planned_entry: number;
  planned_size: number;
  leverage: number;
  margin_amount: number;
  position_value: number;
  stop_loss: number;
  take_profit: number[];
  status: "open" | "completed" | "cancelled";
  created_at: string;
  closed_at: string | null;
}

export interface ExecutionState {
  decision: DecisionExecution;
  position: PositionRecord;
}

export interface PositionMonitor {
  position_id: number;
  decision_id: number;
  symbol: string;
  platform: MarketPlatform;
  action: "HOLD" | "REDUCE" | "EXIT" | "ADJUST_SL" | "ADJUST_TP";
  opening_score: number;
  current_score: number;
  current_price: number;
  unrealized_pnl: number;
  reason: string;
  updated_at: string;
}

export interface HyperliquidPosition {
  coin?: string;
  szi?: string;
  entryPx?: string;
  positionValue?: string;
  unrealizedPnl?: string;
  leverage?: { value?: number; type?: string };
}

export interface HyperliquidFill {
  coin?: string;
  px?: string;
  sz?: string;
  side?: "A" | "B";
  time?: number;
  fee?: string;
  closedPnl?: string;
  dir?: string;
  hash?: string;
  tid?: number;
}

export interface WalletSnapshot {
  address: string;
  equity: number;
  available_balance: number;
  unrealized_pnl: number;
  positions: HyperliquidPosition[];
  history: HyperliquidFill[];
  source: "live" | "unavailable";
  error: string | null;
  platform: MarketPlatform;
}

export interface WalletSettings {
  address: string;
  updated_at: string;
}

export interface PlatformCredentialStatus {
  platform: Exclude<MarketPlatform, "hyperliquid">;
  configured: boolean;
  api_key_hint: string | null;
  updated_at: string | null;
}

export interface CompletedTradeRecord {
  id: number;
  decision_id: number;
  position_id: number;
  wallet_address: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry_price: number;
  exit_price: number;
  size: number;
  fee: number;
  gross_pnl: number;
  net_pnl: number;
  pnl_percent: number;
  entry_source: MarketPlatform | "plan";
  exit_source: MarketPlatform;
  closed_at: string;
  analysis: AnalysisResponse;
  timeframe: MarketInterval;
  started_at: string;
  allocated_amount: number;
  platform: MarketPlatform;
}

export interface ReviewRecord {
  id: number;
  trade_id: number | null;
  review_type: "trade" | "daily";
  review_date: string;
  result: "win" | "loss" | "breakeven" | "no_trades";
  summary: string;
  findings: string[];
  adjustments: string[];
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface CompletionResult {
  trade: CompletedTradeRecord;
  review: ReviewRecord;
}

export interface SimulationWalletResponse extends SimulationWalletState {
  client_id: string;
  platform: MarketPlatform;
  updated_at: string;
}

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 12_000;
const AI_REQUEST_TIMEOUT_MS = 45_000;
export const API_ACCESS_TOKEN_KEY = "alpha-owner-api-token";
export const API_ACCESS_INVALIDATED_EVENT = "alpha-api-access-invalidated";
const COOKIE_SESSION_MARKER = "cookie-session";
const DEVICE_SESSION_PREFIX = "ats1.";

interface OwnerTokenPlugin {
  getToken(): Promise<{ token: string }>;
  setToken(options: { token: string }): Promise<void>;
  clearToken(): Promise<void>;
}

const OwnerToken = registerPlugin<OwnerTokenPlugin>("OwnerToken");
let cachedApiAccessToken: string | null = null;
let apiAccessTokenLoad: Promise<string> | null = null;

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiResponseError";
  }
}

function usesLocalDevelopmentApi() {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(API_BASE);
}

async function parseApiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { detail?: string } | null;
  return new ApiResponseError(payload?.detail || fallback, response.status);
}

function isAuthenticationError(error: unknown) {
  return error instanceof ApiResponseError && (error.status === 401 || error.status === 403);
}

async function clearInvalidAccessToken() {
  if (Capacitor.isNativePlatform()) await OwnerToken.clearToken().catch(() => undefined);
  globalThis.sessionStorage?.removeItem(API_ACCESS_TOKEN_KEY);
  cachedApiAccessToken = "";
  apiAccessTokenLoad = null;
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event(API_ACCESS_INVALIDATED_EVENT));
  }
}

async function exchangeOwnerToken(ownerToken: string) {
  const native = Capacitor.isNativePlatform();
  const response = await fetch(`${API_BASE}/auth/device`, {
    method: "POST",
    credentials: native ? "omit" : "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ transport: native ? "bearer" : "cookie" }),
  });
  // 本地 FastAPI 尚未提供设备会话端点时，保留旧的会话级 Bearer 开发方式。
  if (response.status === 404 && usesLocalDevelopmentApi() && !native) return ownerToken;
  if (!response.ok) throw await parseApiError(response, "设备授权失败");
  const payload = await response.json() as { authorized?: boolean; token?: string };
  if (!payload.authorized) throw new Error("设备授权失败");
  if (!native) return COOKIE_SESSION_MARKER;
  const sessionToken = payload.token?.trim() ?? "";
  if (!sessionToken.startsWith(DEVICE_SESSION_PREFIX)) throw new Error("设备会话格式无效");
  await OwnerToken.setToken({ token: sessionToken });
  return sessionToken;
}

async function completePasswordAuth(response: Response, fallback: string) {
  if (!response.ok) throw await parseApiError(response, fallback);
  const payload = await response.json() as { authorized?: boolean; token?: string };
  if (!payload.authorized) throw new Error(fallback);
  const native = Capacitor.isNativePlatform();
  const sessionToken = native ? payload.token?.trim() ?? "" : COOKIE_SESSION_MARKER;
  if (native && !sessionToken.startsWith(DEVICE_SESSION_PREFIX)) throw new Error("设备会话格式无效");
  if (native) await OwnerToken.setToken({ token: sessionToken });
  globalThis.sessionStorage?.removeItem(API_ACCESS_TOKEN_KEY);
  cachedApiAccessToken = sessionToken;
  apiAccessTokenLoad = Promise.resolve(sessionToken);
  return sessionToken;
}

export async function loginWithPassword(username: string, password: string) {
  const native = Capacitor.isNativePlatform();
  const response = await fetch(`${API_BASE}/auth/password/login`, {
    method: "POST",
    credentials: native ? "omit" : "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password, transport: native ? "bearer" : "cookie" }),
  });
  return completePasswordAuth(response, "账号密码登录失败");
}

export async function setupPassword(username: string, password: string) {
  const native = Capacitor.isNativePlatform();
  const response = await fetch(`${API_BASE}/auth/password/setup`, {
    method: "POST",
    credentials: native ? "omit" : "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, transport: native ? "bearer" : "cookie" }),
  });
  return completePasswordAuth(response, "账号密码设置失败");
}

export async function loadPasswordAuthStatus() {
  const response = await fetch(`${API_BASE}/auth/password/status`, {
    headers: { Accept: "application/json" },
    credentials: Capacitor.isNativePlatform() ? "omit" : "same-origin",
  });
  if (!response.ok) throw await parseApiError(response, "无法检查账号状态");
  return response.json() as Promise<{ setup_required: boolean }>;
}

async function loadCookieSession() {
  const response = await fetch(`${API_BASE}/auth/session`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).catch(() => null);
  return response?.ok ? COOKIE_SESSION_MARKER : "";
}

async function validateDeviceSession(token: string) {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/auth/session`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      credentials: "omit",
    });
  } catch {
    // 离线时保留设备会话，避免网络波动导致用户被迫重新授权。
    return token;
  }
  if (response.ok) {
    const payload = await response.json().catch(() => null) as { authorized?: boolean; token?: string } | null;
    const refreshedToken = payload?.token?.trim() || token;
    if (!refreshedToken.startsWith(DEVICE_SESSION_PREFIX)) {
      await clearInvalidAccessToken();
      return "";
    }
    if (refreshedToken !== token) await OwnerToken.setToken({ token: refreshedToken });
    return refreshedToken;
  }
  if (response.status === 401 || response.status === 403) {
    await clearInvalidAccessToken();
    return "";
  }
  return token;
}

export function getApiAccessToken() {
  if (cachedApiAccessToken !== null) return cachedApiAccessToken;
  if (Capacitor.isNativePlatform()) return "";
  if (usesLocalDevelopmentApi()) {
    cachedApiAccessToken = globalThis.sessionStorage?.getItem(API_ACCESS_TOKEN_KEY) ?? "";
    return cachedApiAccessToken;
  }
  cachedApiAccessToken = "";
  return cachedApiAccessToken;
}

export function loadApiAccessToken(): Promise<string> {
  if (cachedApiAccessToken) return Promise.resolve(cachedApiAccessToken);
  if (!apiAccessTokenLoad) {
    if (!Capacitor.isNativePlatform()) {
      const legacyToken = globalThis.sessionStorage?.getItem(API_ACCESS_TOKEN_KEY)?.trim() ?? "";
      apiAccessTokenLoad = (legacyToken ? exchangeOwnerToken(legacyToken) : loadCookieSession())
        .then((token) => {
          if (usesLocalDevelopmentApi() && token === legacyToken) {
            globalThis.sessionStorage?.setItem(API_ACCESS_TOKEN_KEY, token);
          } else {
            globalThis.sessionStorage?.removeItem(API_ACCESS_TOKEN_KEY);
          }
          cachedApiAccessToken = token;
          return token;
        })
        .catch(() => {
          cachedApiAccessToken = "";
          return "";
        });
      return apiAccessTokenLoad;
    }
    apiAccessTokenLoad = OwnerToken.getToken()
      .then(async ({ token }) => {
        const storedToken = token.trim();
        if (!storedToken) return "";
        if (storedToken.startsWith(DEVICE_SESSION_PREFIX)) return validateDeviceSession(storedToken);
        // 旧版保存的是所有者主令牌；升级后立即换成权限更小的设备会话。
        try {
          return await exchangeOwnerToken(storedToken);
        } catch (error) {
          if (isAuthenticationError(error)) await clearInvalidAccessToken();
          return "";
        }
      })
      .then((token) => {
        cachedApiAccessToken = token;
        return token;
      })
      .catch(() => {
        cachedApiAccessToken = "";
        return "";
      });
  }
  return apiAccessTokenLoad;
}

export async function setApiAccessToken(token: string) {
  const normalized = token.trim();
  if (normalized) {
    try {
      cachedApiAccessToken = await exchangeOwnerToken(normalized);
    } catch (error) {
      if (isAuthenticationError(error)) await clearInvalidAccessToken();
      throw error;
    }
  } else {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: Capacitor.isNativePlatform() ? "omit" : "same-origin",
    }).catch(() => undefined);
    if (Capacitor.isNativePlatform()) await OwnerToken.clearToken();
    globalThis.sessionStorage?.removeItem(API_ACCESS_TOKEN_KEY);
    cachedApiAccessToken = "";
  }
  // Android 永远不保留主令牌；网页正式环境只保留不可读的 HttpOnly Cookie。
  globalThis.sessionStorage?.removeItem(API_ACCESS_TOKEN_KEY);
  if (usesLocalDevelopmentApi() && !Capacitor.isNativePlatform() && cachedApiAccessToken === normalized) {
    globalThis.sessionStorage?.setItem(API_ACCESS_TOKEN_KEY, normalized);
  }
  apiAccessTokenLoad = Promise.resolve(cachedApiAccessToken);
  return cachedApiAccessToken ?? "";
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const upstreamSignal = init.signal;
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });

  let response: Response;
  let token = "";
  try {
    token = await loadApiAccessToken();
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: Capacitor.isNativePlatform() ? "omit" : "same-origin",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(token && token !== COOKIE_SESSION_MARKER ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      throw new Error("后端连接超时");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }

  if (!response.ok) {
    const error = await parseApiError(response, `行情接口请求失败：${response.status}`);
    if (token && isAuthenticationError(error)) {
      await clearInvalidAccessToken();
      throw new Error("登录已过期，请重新登录");
    }
    throw error;
  }

  return response.json() as Promise<T>;
}

export function loadMarket(
  symbol: AssetSymbol,
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  const query = new URLSearchParams({ platform });
  return request<MarketSnapshot>(`/market/${symbol}?${query}`, { signal });
}

export function loadCandles(
  symbol: AssetSymbol,
  interval: MarketInterval,
  limit = 80,
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  const query = new URLSearchParams({ interval, limit: String(limit), platform });
  return request<Candle[]>(`/market/${symbol}/candles?${query}`, { signal });
}

export function loadNews(
  date: string,
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  const query = new URLSearchParams({ date, platform });
  return request<NewsArchiveResponse>(`/news?${query}`, { signal });
}

export function loadAnalysis(
  symbol: AssetSymbol,
  timeframe: MarketInterval,
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  return request<AnalysisResponse>("/ai/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, timeframe, platform }),
    signal,
  }, AI_REQUEST_TIMEOUT_MS);
}

export function loadOpportunities(
  timeframe: MarketInterval,
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
  forceRefresh = false,
) {
  const query = new URLSearchParams({ timeframe, limit: "4", platform });
  if (forceRefresh) query.set("force_refresh", "true");
  return request<OpportunityScanResponse>(`/ai/opportunities?${query}`, { signal }, AI_REQUEST_TIMEOUT_MS);
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

export function loadActiveExecution(signal?: AbortSignal) {
  return request<ExecutionState | null>("/executions/active", { signal });
}

export function loadActiveExecutions(
  signal?: AbortSignal,
  platform?: MarketPlatform,
) {
  const query = platform ? `?${new URLSearchParams({ platform })}` : "";
  return request<ExecutionState[]>(`/executions/active/all${query}`, { signal });
}

export function loadPositionMonitors(
  signal?: AbortSignal,
  platform?: MarketPlatform,
) {
  const query = platform ? `?${new URLSearchParams({ platform })}` : "";
  return request<PositionMonitor[]>(`/positions/monitor${query}`, { signal });
}

export function createExecution(analysis: AnalysisResponse, timeframe: MarketInterval, totalAmount: number) {
  return request<ExecutionState>("/executions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis, timeframe, total_amount: totalAmount }),
  });
}

export function cancelExecution(decisionId: number) {
  return request<ExecutionState>(`/executions/${decisionId}/cancel`, { method: "POST" });
}

export function loadWalletSettings(signal?: AbortSignal) {
  return request<WalletSettings | null>("/settings/wallet", { signal });
}

export function saveWalletSettings(address: string) {
  return request<WalletSettings>("/settings/wallet", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

export function loadSimulationWallet(clientId: string, platform: MarketPlatform, signal?: AbortSignal) {
  const query = new URLSearchParams({ platform });
  return request<SimulationWalletResponse>(`/simulation/wallet/${encodeURIComponent(clientId)}?${query}`, { signal });
}

export function saveSimulationWallet(clientId: string, platform: MarketPlatform, state: SimulationWalletState, signal?: AbortSignal) {
  const query = new URLSearchParams({ platform });
  return request<SimulationWalletResponse>(`/simulation/wallet/${encodeURIComponent(clientId)}?${query}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
    signal,
  });
}

export function loadWallet(address: string, signal?: AbortSignal) {
  return request<WalletSnapshot>(`/wallet/${address}`, { signal });
}

export function loadPlatformCredentialStatus(
  platform: Exclude<MarketPlatform, "hyperliquid">,
  signal?: AbortSignal,
) {
  return request<PlatformCredentialStatus>(`/settings/platform/${platform}`, { signal });
}

export function savePlatformCredentials(
  platform: Exclude<MarketPlatform, "hyperliquid">,
  credentials: { apiKey: string; secretKey: string; passphrase?: string },
) {
  if (globalThis.isSecureContext === false) {
    throw new Error("交易所凭证只能在安全页面中提交");
  }
  const pageUrl = globalThis.location?.href ?? "https://localhost/";
  const target = new URL(`${API_BASE}/settings/platform/${platform}`, pageUrl);
  if (target.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(target.hostname)) {
    throw new Error("交易所凭证只能通过 HTTPS 或本机连接提交");
  }
  return request<PlatformCredentialStatus>(`/settings/platform/${platform}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: credentials.apiKey,
      secret_key: credentials.secretKey,
      passphrase: credentials.passphrase || null,
    }),
  });
}

export function loadPlatformAccount(
  platform: Exclude<MarketPlatform, "hyperliquid">,
  symbol?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (symbol) query.set("symbol", symbol);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WalletSnapshot>(`/platforms/${platform}/account${suffix}`, { signal });
}

export function completePosition(positionId: number) {
  return request<CompletionResult>(`/positions/${positionId}/complete`, { method: "POST" });
}

export function loadCompletedTrades(
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  return request<CompletedTradeRecord[]>(`/trades/completed?platform=${platform}`, { signal });
}

export function loadReviews(
  signal?: AbortSignal,
  platform: MarketPlatform = "hyperliquid",
) {
  return request<ReviewRecord[]>(`/reviews?platform=${platform}`, { signal });
}
