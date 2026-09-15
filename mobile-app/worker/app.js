import baseWorker from "./index.js";
import {
  findSimulationCandleGap,
  openServerSimulatedTrade,
  processServerSimulatedCandles,
} from "./simulation-engine.js";

const APP_ORIGINS = new Set(["https://localhost", "http://localhost"]);
const MAX_ACTIVE_DECISIONS = 3;
const SESSION_COOKIE = "alpha_owner_session";
const SESSION_PREFIX = "ats1";
const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
// 0 表示使用服务端密钥加盐的 HMAC-SHA256；正数保留给旧版 PBKDF2 数据兼容。
const PASSWORD_HASH_VERSION = 0;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_LOCK_SECONDS = 15 * 60;
const ACCOUNT_MAX_FAILURES = 5;
const CLIENT_MAX_FAILURES = 10;
const HISTORY_MIN_SAMPLES = 12;
const HISTORY_DIRECTION_MIN_SAMPLES = 8;
const HISTORY_MAX_SAMPLES = 200;
const SUPPORTED_TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const SIMULATION_EXECUTOR_HEALTHY_MS = 3 * 60 * 1_000;
const SIMULATION_EXECUTOR_WALLET_LIMIT = 30;
const SIMULATION_MARKET_TIMEOUT_MS = 12_000;
const SIMULATION_OPPORTUNITY_TIMEOUT_MS = 30_000;
const SIMULATION_SCHEDULER_INTERVAL_MS = 60_000;
const SCHEDULED_DECISION_PLATFORMS = ["hyperliquid", "binance", "okx"];

function appendVary(headers, value) {
  const values = (headers.get("vary") || "").split(",").map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set("vary", [...values.filter(Boolean), value].join(", "));
  }
}

function withAppCors(request, response) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin") || "";
  if (!url.pathname.startsWith("/api/") || !APP_ORIGINS.has(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type");
  headers.set("access-control-max-age", "86400");
  appendVary(headers, "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withHtmlNoStore(request, response) {
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  const isAppEntry = ["/", "/app", "/index.html"].includes(new URL(request.url).pathname);
  const isHtml = response.headers.get("content-type")?.includes("text/html");
  if (!acceptsHtml && !isAppEntry && !isHtml) return response;

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (item) => item.toString(16).padStart(2, "0")).join("");
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function createBackendSignature(request, privateKeyValue) {
  const privateKey = String(privateKeyValue || "").trim();
  if (!privateKey) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = await request.clone().arrayBuffer();
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const url = new URL(request.url);
  const message = `${timestamp}\n${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${bodyHash}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodeBase64(privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(message),
  );
  return { timestamp, signature: encodeBase64Url(new Uint8Array(signature)) };
}

async function sessionKey(secret, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function issueSessionToken(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${SESSION_PREFIX}.${expiresAt}.${nonce}`;
  const key = await sessionKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return { token: `${payload}.${encodeBase64Url(new Uint8Array(signature))}`, expiresAt };
}

async function verifySessionToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_PREFIX) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const signature = decodeBase64Url(parts[3]);
  if (!signature) return false;
  const key = await sessionKey(secret, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(parts.slice(0, 3).join(".")),
  );
}

function readCookie(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function getSessionSecret(env) {
  return String(env.DEVICE_SESSION_SECRET || env.OWNER_API_TOKEN || "").trim();
}

function getPasswordSecret(env) {
  return String(env.DEVICE_SESSION_SECRET || "").trim();
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validUsername(value) {
  return /^[a-z0-9._@-]{3,64}$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 128;
}

async function derivePasswordHash(password, salt, version, secret) {
  if (version === PASSWORD_HASH_VERSION) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const passwordBytes = new TextEncoder().encode(password);
    const payload = new Uint8Array(salt.length + 1 + passwordBytes.length);
    payload.set(salt);
    payload[salt.length] = 0;
    payload.set(passwordBytes, salt.length + 1);
    const signature = await crypto.subtle.sign("HMAC", key, payload);
    return encodeBase64Url(new Uint8Array(signature));
  }

  // 兼容已存在的旧版 PBKDF2 凭证，新账号不再使用高 CPU 方案。
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations: version,
  }, key, 256);
  return encodeBase64Url(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function issueAuthenticatedResponse(env, transport) {
  const sessionSecret = getSessionSecret(env);
  if (!sessionSecret) return json({ detail: "设备会话密钥尚未配置" }, 503);
  const session = await issueSessionToken(sessionSecret);
  const response = json({
    authorized: true,
    expires_at: new Date(session.expiresAt * 1000).toISOString(),
    ...(transport === "bearer" ? { token: session.token } : {}),
  });
  if (transport === "bearer") return response;
  const headers = new Headers(response.headers);
  headers.set("set-cookie", sessionCookie(session.token, SESSION_TTL_SECONDS));
  return new Response(response.body, { status: response.status, headers });
}

function nextFailureState(record, now, maximum) {
  const withinWindow = Number(record?.failed_window_started_at || 0) > now - LOGIN_WINDOW_SECONDS;
  const attempts = withinWindow ? Number(record?.failed_attempts || 0) + 1 : 1;
  return {
    attempts,
    windowStartedAt: withinWindow ? Number(record.failed_window_started_at) : now,
    lockedUntil: attempts >= maximum ? now + LOGIN_LOCK_SECONDS : null,
  };
}

async function readClientRateLimit(env, request) {
  const clientAddress = request.headers.get("cf-connecting-ip") || "unknown";
  const clientHash = await digest(`${getSessionSecret(env)}:${clientAddress}`);
  const row = await env.DB.prepare(
    "SELECT failed_attempts, failed_window_started_at, locked_until FROM auth_login_rate_limits WHERE client_hash = ?",
  ).bind(clientHash).first();
  return { clientHash, row };
}

async function recordClientFailure(env, clientHash, record, now) {
  const state = nextFailureState(record, now, CLIENT_MAX_FAILURES);
  await env.DB.prepare(`
    INSERT INTO auth_login_rate_limits
      (client_hash, failed_attempts, failed_window_started_at, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_hash) DO UPDATE SET
      failed_attempts = excluded.failed_attempts,
      failed_window_started_at = excluded.failed_window_started_at,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).bind(clientHash, state.attempts, state.windowStartedAt, state.lockedUntil, now).run();
  return state;
}

async function clearClientFailures(env, clientHash, now) {
  await env.DB.prepare(`
    INSERT INTO auth_login_rate_limits
      (client_hash, failed_attempts, failed_window_started_at, locked_until, updated_at)
    VALUES (?, 0, NULL, NULL, ?)
    ON CONFLICT(client_hash) DO UPDATE SET
      failed_attempts = 0,
      failed_window_started_at = NULL,
      locked_until = NULL,
      updated_at = excluded.updated_at
  `).bind(clientHash, now).run();
}

async function recordAccountFailure(env, credential, now) {
  const state = nextFailureState(credential, now, ACCOUNT_MAX_FAILURES);
  await env.DB.prepare(`
    UPDATE owner_password_credentials SET
      failed_attempts = ?, failed_window_started_at = ?, locked_until = ?, updated_at = ?
    WHERE owner_id = ?
  `).bind(state.attempts, state.windowStartedAt, state.lockedUntil, now, credential.owner_id).run();
  return state;
}

async function authenticateOwner(request, env) {
  const expected = String(env.OWNER_API_TOKEN || "").trim();
  if (!expected) return { error: json({ detail: "服务端尚未配置访问令牌" }, 503) };
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const supplied = bearer || readCookie(request, SESSION_COOKIE);
  if (!supplied) return { error: json({ detail: "访问令牌缺失" }, 401) };
  const [expectedHash, suppliedHash] = await Promise.all([digest(expected), digest(supplied)]);
  if (expectedHash === suppliedHash) return { ownerId: expectedHash.slice(0, 24), credential: "owner" };
  const sessionSecret = getSessionSecret(env);
  if (sessionSecret && await verifySessionToken(supplied, sessionSecret)) {
    return { ownerId: expectedHash.slice(0, 24), credential: "session" };
  }
  // 兼容升级前由 OWNER_API_TOKEN 签发的设备会话。
  if (sessionSecret !== expected && await verifySessionToken(supplied, expected)) {
    return { ownerId: expectedHash.slice(0, 24), credential: "session" };
  }
  return { error: json({ detail: "登录状态无效，请重新登录" }, 401) };
}

async function handleAuth(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/v1/auth/password/status") {
    if (request.method !== "GET") return json({ detail: "不支持的请求方法" }, 405);
    if (!env.DB) return json({ detail: "账号数据库尚未配置" }, 503);
    const credential = await env.DB.prepare(
      "SELECT owner_id FROM owner_password_credentials LIMIT 1",
    ).first();
    return json({ setup_required: !credential });
  }

  if (pathname === "/api/v1/auth/device") {
    if (request.method !== "POST") return json({ detail: "不支持的请求方法" }, 405);
    const auth = await authenticateOwner(request, env);
    if (auth.error) return auth.error;
    if (auth.credential !== "owner") return json({ detail: "设备授权必须使用所有者令牌" }, 403);
    const payload = await request.json().catch(() => ({}));
    const transport = payload.transport === "bearer" ? "bearer" : "cookie";
    return issueAuthenticatedResponse(env, transport);
  }

  if (pathname === "/api/v1/auth/password/setup") {
    if (request.method !== "POST") return json({ detail: "不支持的请求方法" }, 405);
    if (!env.DB) return json({ detail: "账号数据库尚未配置" }, 503);
    const ownerToken = String(env.OWNER_API_TOKEN || "").trim();
    if (!ownerToken) return json({ detail: "服务端身份配置缺失" }, 503);
    const passwordSecret = getPasswordSecret(env);
    if (!passwordSecret) return json({ detail: "服务端登录密钥尚未配置" }, 503);
    const existingCredential = await env.DB.prepare(
      "SELECT owner_id FROM owner_password_credentials LIMIT 1",
    ).first();
    if (existingCredential) return json({ detail: "账号已创建，请直接登录" }, 409);
    const payload = await request.json().catch(() => ({}));
    const username = normalizeUsername(payload.username);
    if (!validUsername(username)) return json({ detail: "账号需为 3 至 64 位字母、数字或 . _ @ -" }, 422);
    if (!validPassword(payload.password)) return json({ detail: "密码长度需为 10 至 128 位" }, 422);
    const now = Math.floor(Date.now() / 1000);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    let passwordHash;
    try {
      passwordHash = await derivePasswordHash(payload.password, salt, PASSWORD_HASH_VERSION, passwordSecret);
    } catch (error) {
      console.error("创建账号密码摘要失败", error);
      return json({ detail: "账号安全初始化失败，请稍后重试" }, 503);
    }
    const ownerId = (await digest(ownerToken)).slice(0, 24);
    try {
      await env.DB.prepare(`
        INSERT INTO owner_password_credentials
          (owner_id, username_normalized, password_salt, password_hash, password_iterations,
           failed_attempts, failed_window_started_at, locked_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
      `).bind(ownerId, username, encodeBase64Url(salt), passwordHash, PASSWORD_HASH_VERSION, now, now).run();
    } catch {
      // 首次注册只允许一个账号；并发提交时由数据库唯一约束兜底。
      return json({ detail: "账号已创建，请直接登录" }, 409);
    }
    const transport = payload.transport === "bearer" ? "bearer" : "cookie";
    return issueAuthenticatedResponse(env, transport);
  }

  if (pathname === "/api/v1/auth/password/login") {
    if (request.method !== "POST") return json({ detail: "不支持的请求方法" }, 405);
    if (!env.DB) return json({ detail: "账号数据库尚未配置" }, 503);
    const passwordSecret = getPasswordSecret(env);
    if (!passwordSecret) return json({ detail: "服务端登录密钥尚未配置" }, 503);
    const payload = await request.json().catch(() => ({}));
    const username = normalizeUsername(payload.username);
    if (!validUsername(username) || !validPassword(payload.password)) {
      return json({ detail: "账号或密码错误" }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const { clientHash, row: clientRate } = await readClientRateLimit(env, request);
    if (Number(clientRate?.locked_until || 0) > now) {
      return json({ detail: "登录尝试次数过多，请 15 分钟后重试" }, 429);
    }
    const credential = await env.DB.prepare(`
      SELECT owner_id, password_salt, password_hash, password_iterations,
             failed_attempts, failed_window_started_at, locked_until
      FROM owner_password_credentials WHERE username_normalized = ?
    `).bind(username).first();
    if (Number(credential?.locked_until || 0) > now) {
      return json({ detail: "登录尝试次数过多，请 15 分钟后重试" }, 429);
    }

    const salt = credential ? decodeBase64Url(credential.password_salt) : new Uint8Array(16);
    const version = credential ? Number(credential.password_iterations) : PASSWORD_HASH_VERSION;
    let suppliedHash;
    try {
      suppliedHash = await derivePasswordHash(
        payload.password,
        salt || new Uint8Array(16),
        version,
        passwordSecret,
      );
    } catch (error) {
      console.error("验证账号密码摘要失败", error);
      return json({ detail: "账号安全验证失败，请稍后重试" }, 503);
    }
    const valid = Boolean(credential) && constantTimeEqual(suppliedHash, credential.password_hash);
    if (!valid) {
      const clientFailure = await recordClientFailure(env, clientHash, clientRate, now);
      const accountFailure = credential ? await recordAccountFailure(env, credential, now) : null;
      if (clientFailure.lockedUntil || accountFailure?.lockedUntil) {
        return json({ detail: "登录尝试次数过多，请 15 分钟后重试" }, 429);
      }
      return json({ detail: "账号或密码错误" }, 401);
    }

    await Promise.all([
      clearClientFailures(env, clientHash, now),
      env.DB.prepare(`
        UPDATE owner_password_credentials SET
          failed_attempts = 0, failed_window_started_at = NULL, locked_until = NULL, updated_at = ?
        WHERE owner_id = ?
      `).bind(now, credential.owner_id).run(),
    ]);
    const transport = payload.transport === "bearer" ? "bearer" : "cookie";
    return issueAuthenticatedResponse(env, transport);
  }

  if (pathname === "/api/v1/auth/session") {
    if (request.method !== "GET") return json({ detail: "不支持的请求方法" }, 405);
    const auth = await authenticateOwner(request, env);
    if (auth.error) return auth.error;
    const transport = request.headers.get("authorization")?.startsWith("Bearer ") ? "bearer" : "cookie";
    // 每次启动校验成功后续签，避免长期使用时突然掉线。
    return issueAuthenticatedResponse(env, transport);
  }

  if (pathname === "/api/v1/auth/logout") {
    if (request.method !== "POST") return json({ detail: "不支持的请求方法" }, 405);
    const response = json({ authorized: false });
    const headers = new Headers(response.headers);
    headers.set("set-cookie", sessionCookie("", 0));
    return new Response(response.body, { status: response.status, headers });
  }

  return json({ detail: "鉴权接口不存在" }, 404);
}

async function readCapital(env, ownerId) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT total_amount, currency, updated_at FROM owner_capital_settings WHERE owner_id = ?",
  ).bind(ownerId).first();
  return row ? {
    total_amount: Number(row.total_amount),
    currency: row.currency,
    updated_at: row.updated_at,
  } : {
    total_amount: 10_000,
    currency: "USDT",
    updated_at: new Date().toISOString(),
  };
}

function buildDecisionHistoryPolicy(trades) {
  const directions = { LONG: [], SHORT: [] };
  for (const trade of trades) directions[trade.direction].push(trade);
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const losses = trades.filter((trade) => trade.netPnl < 0).length;
  const winRate = trades.length > 0 ? wins / trades.length * 100 : 0;
  const averageR = trades.length > 0
    ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length
    : 0;
  const recentTrades = trades.slice(0, 6);
  const recentWins = recentTrades.filter((trade) => trade.netPnl > 0).length;
  const recentWinRate = recentTrades.length > 0 ? recentWins / recentTrades.length * 100 : 0;
  let consecutiveLosses = 0;
  for (const trade of trades) {
    if (trade.netPnl >= 0) break;
    consecutiveLosses += 1;
  }
  const smoothedWinRate = (wins + 6) / (trades.length + 12);
  let thresholdAdjustment = 0;
  let riskMultiplier = 1;
  if (trades.length >= HISTORY_MIN_SAMPLES) {
    if (smoothedWinRate >= 0.56 && averageR >= 0.25) {
      thresholdAdjustment = -2;
      riskMultiplier = 1.05;
    } else if (smoothedWinRate >= 0.52 && averageR >= 0.1) {
      thresholdAdjustment = -1;
    } else if (smoothedWinRate < 0.46 || averageR < 0) {
      thresholdAdjustment = 2;
      riskMultiplier = 0.75;
    } else {
      riskMultiplier = 0.9;
    }
    if (recentTrades.length >= 6 && recentWinRate <= 33.34) {
      thresholdAdjustment += 1;
      riskMultiplier = Math.min(riskMultiplier, 0.75);
    }
    if (consecutiveLosses >= 4) {
      thresholdAdjustment = Math.max(thresholdAdjustment, 4);
      riskMultiplier = Math.min(riskMultiplier, 0.5);
    } else if (consecutiveLosses >= 3) {
      thresholdAdjustment = Math.max(thresholdAdjustment, 3);
      riskMultiplier = Math.min(riskMultiplier, 0.65);
    }
  }
  thresholdAdjustment = clamp(thresholdAdjustment, -2, 4);
  const directionPerformance = Object.fromEntries(Object.entries(directions).map(([direction, items]) => {
    const directionWins = items.filter((trade) => trade.netPnl > 0).length;
    const directionWinRate = items.length > 0 ? directionWins / items.length * 100 : 0;
    const smoothedDirectionWinRate = (directionWins + 4) / (items.length + 8);
    const thresholdAdjustmentByDirection = items.length < HISTORY_DIRECTION_MIN_SAMPLES
      ? 0
      : smoothedDirectionWinRate < 0.45 ? 2
        : smoothedDirectionWinRate > 0.56 ? -1 : 0;
    const riskMultiplierByDirection = items.length < HISTORY_DIRECTION_MIN_SAMPLES
      ? 1
      : smoothedDirectionWinRate < 0.45 ? 0.8
        : smoothedDirectionWinRate > 0.56 ? 1.05 : 1;
    return [direction, {
      sample_count: items.length,
      wins: directionWins,
      win_rate: Number(directionWinRate.toFixed(2)),
      threshold_adjustment: thresholdAdjustmentByDirection,
      risk_multiplier: riskMultiplierByDirection,
    }];
  }));
  return {
    sample_count: trades.length,
    wins,
    losses,
    win_rate: Number(winRate.toFixed(2)),
    average_r: Number(clamp(averageR, -2, 2).toFixed(4)),
    recent_win_rate: Number(recentWinRate.toFixed(2)),
    consecutive_losses: consecutiveLosses,
    threshold_adjustment: thresholdAdjustment,
    risk_multiplier: riskMultiplier,
    direction_performance: directionPerformance,
  };
}

async function readRequestTimeframe(request, url) {
  let timeframe = url.searchParams.get("timeframe");
  if (!timeframe && request.method === "POST") {
    const payload = await request.clone().json().catch(() => ({}));
    timeframe = payload?.timeframe;
  }
  return SUPPORTED_TIMEFRAMES.has(timeframe) ? timeframe : "4h";
}

async function readHistoryPolicy(env, ownerId, timeframe) {
  if (!env.DB) return null;
  const normalizedTimeframe = SUPPORTED_TIMEFRAMES.has(timeframe) ? timeframe : "4h";
  try {
    const result = await env.DB.prepare(
      `SELECT platform, trade_id, occurred_at, payload_json
       FROM simulation_trade_events
       WHERE owner_id = ? AND event_type = 'closed'
       ORDER BY occurred_at DESC LIMIT 6000`,
    ).bind(ownerId).all();
    const grouped = new Map();
    for (const row of result.results || []) {
      const platform = String(row.platform || "").toLowerCase();
      if (!["hyperliquid", "binance", "okx"].includes(platform)) continue;
      const seen = grouped.get(platform) || new Map();
      const trade = parseJson(row.payload_json, null)?.trade;
      if (!trade || typeof trade !== "object") continue;
      const direction = String(trade.direction || "").toUpperCase();
      const netPnl = Number(trade.net_pnl);
      const tradeTimeframe = SUPPORTED_TIMEFRAMES.has(trade.timeframe) ? trade.timeframe : "4h";
      if (tradeTimeframe !== normalizedTimeframe) continue;
      if (!["LONG", "SHORT"].includes(direction) || !Number.isFinite(netPnl)) continue;
      const identity = String(row.trade_id || trade.id);
      if (seen.has(identity)) continue;
      const plannedLoss = Number(trade?.analysis?.position_sizing?.max_loss_amount);
      const storedRMultiple = Number(trade.r_multiple);
      const rMultiple = Number.isFinite(storedRMultiple)
        ? clamp(storedRMultiple, -2, 2)
        : plannedLoss > 0
          ? clamp(netPnl / plannedLoss, -2, 2)
          : netPnl > 0 ? 1 : netPnl < 0 ? -1 : 0;
      const closedAt = Date.parse(trade.closed_at || row.occurred_at || "") || 0;
      seen.set(identity, { direction, netPnl, rMultiple, closedAt });
      grouped.set(platform, seen);
    }
    const platforms = {};
    const scopeValue = await digest(`${getSessionSecret(env)}:${ownerId}:history-cache`);
    for (const [platform, items] of grouped) {
      const recentItems = [...items.values()]
        .sort((left, right) => right.closedAt - left.closedAt)
        .slice(0, HISTORY_MAX_SAMPLES);
      const summary = buildDecisionHistoryPolicy(recentItems);
      const fingerprintValue = await digest(JSON.stringify({ platform, timeframe: normalizedTimeframe, ...summary }));
      platforms[platform] = {
        ...summary,
        timeframe: normalizedTimeframe,
        fingerprint: fingerprintValue.slice(0, 16),
        scope_key: scopeValue.slice(0, 16),
      };
    }
    return { version: 2, timeframe: normalizedTimeframe, platforms };
  } catch (error) {
    console.error("模拟决策历史聚合失败，已回退到基础评分", error);
    return null;
  }
}

async function handleCapital(request, env, ownerId) {
  if (!env.DB) return json({ detail: "资金设置数据库尚未配置" }, 503);
  if (request.method === "GET") return json(await readCapital(env, ownerId));
  if (request.method !== "PUT") return json({ detail: "不支持的请求方法" }, 405);
  const payload = await request.json();
  const amount = Number(payload.total_amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    return json({ detail: "总金额格式不正确" }, 422);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO owner_capital_settings (owner_id, total_amount, currency, updated_at)
    VALUES (?, ?, 'USDT', ?)
    ON CONFLICT(owner_id) DO UPDATE SET
      total_amount = excluded.total_amount,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `).bind(ownerId, amount, now).run();
  return json({ total_amount: amount, currency: "USDT", updated_at: now });
}

function executorStatus(row) {
  const lastSuccessAt = row?.last_success_at ?? null;
  const lastSuccessTime = Date.parse(lastSuccessAt || "");
  return {
    mode: "server",
    healthy: Number.isFinite(lastSuccessTime) && Date.now() - lastSuccessTime <= SIMULATION_EXECUTOR_HEALTHY_MS,
    last_run_at: row?.last_run_at ?? null,
    last_success_at: lastSuccessAt,
    last_error: row?.last_error ?? null,
  };
}

async function readExecutorStatus(env, ownerId, clientId, platform) {
  try {
    return await env.DB.prepare(
      `SELECT last_run_at, last_success_at, last_error
       FROM simulation_executor_state
       WHERE owner_id = ? AND client_id = ? AND platform = ?`,
    ).bind(ownerId, clientId, platform).first();
  } catch {
    // 数据库迁移完成前保持旧客户端执行方式，不让钱包接口整体不可用。
    return null;
  }
}

const SIMULATION_WALLET_COLUMNS = `
  enabled, balance, active_trade, history, auto_timeframe, updated_at, revision,
  integrity_status, integrity_error
`;

async function readSimulationWalletRow(env, ownerId, clientId, platform) {
  return env.DB.prepare(
    `SELECT ${SIMULATION_WALLET_COLUMNS}
     FROM owner_simulation_wallets WHERE owner_id = ? AND client_id = ? AND platform = ?`,
  ).bind(ownerId, clientId, platform).first();
}

function walletResponse(row, clientId, platform, executorRow = null) {
  const storedActiveTrades = parseJson(row?.active_trade, []);
  const activeTrades = (Array.isArray(storedActiveTrades)
    ? storedActiveTrades
    : storedActiveTrades && typeof storedActiveTrades === "object" ? [storedActiveTrades] : []
  ).slice(0, MAX_ACTIVE_DECISIONS);
  return {
    client_id: clientId,
    platform,
    enabled: Boolean(row?.enabled),
    balance: Number(row?.balance ?? 1_000),
    activeTrades,
    // 保留旧字段，避免尚未升级的 APK 读取数据库后丢失首笔执行状态。
    activeTrade: activeTrades[0] ?? null,
    history: parseJson(row?.history, []),
    autoTimeframe: SUPPORTED_TIMEFRAMES.has(row?.auto_timeframe) ? row.auto_timeframe : "4h",
    updated_at: row?.updated_at ?? new Date().toISOString(),
    revision: Number(row?.revision ?? 0),
    integrity: {
      status: ["ok", "gap", "error"].includes(row?.integrity_status) ? row.integrity_status : "ok",
      detail: row?.integrity_error ?? null,
    },
    executor: executorStatus(executorRow),
  };
}

async function handleSimulationWallet(request, env, ctx, ownerId, clientId, platform) {
  if (!env.DB) return json({ detail: "模拟交易数据库尚未配置" }, 503);
  try {
    if (request.method === "GET") {
      const row = await readSimulationWalletRow(env, ownerId, clientId, platform);
      const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
      return json(walletResponse(row, clientId, platform, executorRow));
    }
    if (request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      if (!["execute", "cancel"].includes(payload.action)) {
        return json({ detail: "不支持的模拟交易命令" }, 422);
      }
      const current = await readSimulationWalletRow(env, ownerId, clientId, platform);
      if (!current?.enabled) return json({ detail: "请先开启当前平台的模拟交易" }, 409);
      const scopedRow = { ...current, owner_id: ownerId, client_id: clientId, platform };
      const expectedRevision = Number.isInteger(payload.revision) ? payload.revision : Number(current.revision ?? 0);
      if (expectedRevision !== Number(current.revision ?? 0)) {
        const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
        return json({
          detail: "模拟钱包已由服务端更新，请使用最新状态重试",
          wallet: walletResponse(current, clientId, platform, executorRow),
        }, 409);
      }
      const storedActiveTrades = parseJson(current.active_trade, []);
      const activeTrades = (Array.isArray(storedActiveTrades)
        ? storedActiveTrades
        : storedActiveTrades && typeof storedActiveTrades === "object" ? [storedActiveTrades] : []
      ).slice(0, MAX_ACTIVE_DECISIONS);
      const storedHistory = parseJson(current.history, []);
      const history = Array.isArray(storedHistory) ? storedHistory : [];
      const now = Date.now();
      let nextActiveTrades = activeTrades;
      let events = [];
      if (payload.action === "cancel") {
        const tradeId = String(payload.trade_id ?? "");
        const cancelled = activeTrades.find((trade) => String(trade?.id) === tradeId);
        if (!cancelled) return json({ detail: "未找到需要取消的模拟交易" }, 404);
        nextActiveTrades = activeTrades.filter((trade) => String(trade?.id) !== tradeId);
        events = [simulationEvent(scopedRow, cancelled, "closed", new Date(now).toISOString(), {
          action: "manual_cancel",
          symbol: cancelled?.analysis?.symbol,
        })];
      } else {
        if (activeTrades.length >= MAX_ACTIVE_DECISIONS) {
          return json({ detail: `最多同时执行 ${MAX_ACTIVE_DECISIONS} 个决策` }, 409);
        }
        const timeframe = SUPPORTED_TIMEFRAMES.has(payload.timeframe) ? payload.timeframe : null;
        const symbol = String(payload.symbol || "").toUpperCase();
        if (!timeframe || !/^[A-Z0-9]{2,15}$/.test(symbol)) {
          return json({ detail: "模拟执行参数格式不正确" }, 422);
        }
        const opportunities = await loadSimulationOpportunities(
          env, ctx, ownerId, platform, timeframe, { market: new Map(), opportunities: new Map() },
        );
        const candidate = opportunities.find((item) => item?.symbol === symbol
          && item?.is_executable === true
          && (!payload.plan_id || item?.plan_id === payload.plan_id));
        if (!candidate) return json({ detail: "该决策已变化或不再满足执行条件，请刷新后重试" }, 409);
        if (activeTrades.some((trade) => trade?.analysis?.symbol === symbol)) {
          return json({ detail: "当前币种已有执行中的决策" }, 409);
        }
        const trade = openServerSimulatedTrade(candidate, timeframe, Number(current.balance), now);
        nextActiveTrades = [trade, ...activeTrades];
        events = [simulationEvent(scopedRow, trade, "opened", new Date(now).toISOString(), { trade })];
      }
      const committed = await commitSimulationWallet(env, scopedRow, {
        balance: Number(current.balance),
        activeJson: nextActiveTrades.length > 0 ? JSON.stringify(nextActiveTrades) : null,
        historyJson: JSON.stringify(history.slice(0, 500)),
        integrityStatus: current.integrity_status || "ok",
        integrityError: current.integrity_error || null,
        updatedAt: new Date(now).toISOString(),
      }, events);
      if (!committed) return json({ detail: "模拟钱包已由服务端更新，请刷新后重试" }, 409);
      const latest = await readSimulationWalletRow(env, ownerId, clientId, platform);
      const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
      return json(walletResponse(latest, clientId, platform, executorRow));
    }
    if (request.method === "PUT") {
      const payload = await request.json();
      // 旧版客户端没有自动周期字段时按原有 4h 行为兼容，但不再接收其余额和交易历史。
      const requestedTimeframe = payload.autoTimeframe ?? "4h";
      const autoTimeframe = SUPPORTED_TIMEFRAMES.has(requestedTimeframe) ? requestedTimeframe : null;
      const reset = payload.action === "reset";
      if (typeof payload.enabled !== "boolean" || !autoTimeframe
        || (payload.action !== undefined && !["configure", "reset"].includes(payload.action))) {
        return json({ detail: "模拟钱包设置格式不正确" }, 422);
      }
      const current = await readSimulationWalletRow(env, ownerId, clientId, platform);
      const expectedRevision = Number.isInteger(payload.revision) ? payload.revision : Number(current?.revision ?? 0);
      if (current && expectedRevision !== Number(current.revision ?? 0)) {
        const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
        return json({
          detail: "模拟钱包已由服务端更新，请使用最新状态重试",
          wallet: walletResponse(current, clientId, platform, executorRow),
        }, 409);
      }
      const currentActiveTrades = parseJson(current?.active_trade, []);
      const hasActiveTrades = Array.isArray(currentActiveTrades)
        ? currentActiveTrades.length > 0
        : Boolean(currentActiveTrades);
      if (hasActiveTrades && (!payload.enabled || reset)) {
        return json({ detail: "仍有模拟交易执行中，暂不可关闭或重置" }, 409);
      }
      const now = new Date().toISOString();
      const nextRevision = current ? expectedRevision + 1 : 0;
      const result = current
        ? await env.DB.prepare(`
          UPDATE owner_simulation_wallets
          SET enabled = ?, auto_timeframe = ?,
              balance = CASE WHEN ? = 1 THEN 1000 ELSE balance END,
              active_trade = CASE WHEN ? = 1 THEN NULL ELSE active_trade END,
              history = CASE WHEN ? = 1 THEN '[]' ELSE history END,
              integrity_status = CASE WHEN ? = 1 THEN 'ok' ELSE integrity_status END,
              integrity_error = CASE WHEN ? = 1 THEN NULL ELSE integrity_error END,
              updated_at = ?, revision = revision + 1
          WHERE owner_id = ? AND client_id = ? AND platform = ? AND revision = ?
        `).bind(
          payload.enabled ? 1 : 0,
          autoTimeframe,
          reset ? 1 : 0,
          reset ? 1 : 0,
          reset ? 1 : 0,
          reset ? 1 : 0,
          reset ? 1 : 0,
          now,
          ownerId,
          clientId,
          platform,
          expectedRevision,
        ).run()
        : await env.DB.prepare(`
          INSERT INTO owner_simulation_wallets (
            owner_id, client_id, platform, enabled, balance, active_trade, history,
            auto_timeframe, updated_at, revision, integrity_status, integrity_error
          ) VALUES (?, ?, ?, ?, 1000, NULL, '[]', ?, ?, 0, 'ok', NULL)
        `).bind(
          ownerId,
          clientId,
          platform,
          payload.enabled ? 1 : 0,
          autoTimeframe,
          now,
        ).run();
      if (Number(result?.meta?.changes ?? 0) === 0) {
        const latest = await readSimulationWalletRow(env, ownerId, clientId, platform);
        const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
        return json({
          detail: "模拟钱包已由服务端更新，请使用最新状态重试",
          wallet: walletResponse(latest, clientId, platform, executorRow),
        }, 409);
      }
      const stored = await readSimulationWalletRow(env, ownerId, clientId, platform);
      const executorRow = await readExecutorStatus(env, ownerId, clientId, platform);
      return json(walletResponse({ ...stored, revision: nextRevision }, clientId, platform, executorRow));
    }
  } catch (error) {
    console.error("模拟交易数据库操作失败", error);
    return json({ detail: "模拟交易数据暂时无法保存" }, 503);
  }
  return json({ detail: "不支持的请求方法" }, 405);
}

async function handleSimulationEvents(request, env, ownerId, clientId, platform, url) {
  if (request.method !== "GET") return json({ detail: "不支持的请求方法" }, 405);
  if (!env.DB) return json({ detail: "模拟交易数据库尚未配置" }, 503);
  const limit = clamp(Number(url.searchParams.get("limit") || 50), 1, 100);
  const cursor = String(url.searchParams.get("cursor") || "").trim();
  if (cursor && !Number.isFinite(Date.parse(cursor))) return json({ detail: "分页游标格式不正确" }, 422);
  const result = await env.DB.prepare(`
    SELECT event_id, trade_id, event_type, occurred_at, payload_json
    FROM simulation_trade_events
    WHERE owner_id = ? AND client_id = ? AND platform = ?
      AND (? = '' OR occurred_at < ?)
    ORDER BY occurred_at DESC, event_id DESC LIMIT ?
  `).bind(ownerId, clientId, platform, cursor, cursor, limit + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  return json({
    items: visibleRows.map((row) => ({
      event_id: row.event_id,
      trade_id: row.trade_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      payload: parseJson(row.payload_json, {}),
    })),
    next_cursor: hasMore ? visibleRows.at(-1)?.occurred_at ?? null : null,
  });
}

function stableSimulationPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toPrecision(12) : "invalid";
}

function simulationSignalKey(analysis, timeframe, platform) {
  const planIdentity = String(analysis?.plan_id || "").trim() || [
    analysis?.generated_at || "legacy",
    analysis?.symbol,
    analysis?.direction,
    stableSimulationPrice(analysis?.optimal_entry_price || 0),
    (analysis?.entry_range || []).map(stableSimulationPrice).join("-"),
    stableSimulationPrice(analysis?.stop_loss),
    (analysis?.take_profit || []).map(stableSimulationPrice).join("-"),
  ].join(":");
  return `${platform}:${timeframe}:${planIdentity}:v${analysis?.decision_revision ?? 1}`;
}

function simulationCandleLimit(trade, now) {
  const lastProcessed = Number(trade?.lastProcessedCandleCloseTime ?? trade?.startedAt ?? now);
  const required = Math.max(5, Math.ceil(Math.max(0, now - lastProcessed) / 60_000) + 2);
  return [5, 15, 60, 180, 300, 500].find((limit) => limit >= required) ?? 500;
}

function cachedSimulationRequest(cache, key, loader) {
  if (!cache.has(key)) cache.set(key, loader());
  return cache.get(key);
}

async function fetchSimulationMarketData(env, ctx, pathname, platform, cache) {
  return cachedSimulationRequest(cache.market, `${platform}:${pathname}`, async () => {
    const url = `https://simulation-executor.invalid${pathname}`;
    const request = new Request(url, { signal: AbortSignal.timeout(SIMULATION_MARKET_TIMEOUT_MS) });
    const proxied = await proxyBackend(request, env).catch(() => null);
    if (proxied?.ok) return proxied.json();
    if (platform !== "hyperliquid") throw new Error("完整后端行情暂时不可用");
    const edgeRequest = new Request(url, { signal: AbortSignal.timeout(SIMULATION_MARKET_TIMEOUT_MS) });
    const edgeResponse = await baseWorker.fetch(edgeRequest, env, ctx);
    if (!edgeResponse.ok) throw new Error("边缘行情暂时不可用");
    return edgeResponse.json();
  });
}

async function loadSimulationOpportunities(env, ctx, ownerId, platform, timeframe, cache) {
  return cachedSimulationRequest(cache.opportunities, `${ownerId}:${platform}:${timeframe}`, async () => {
    const request = new Request(
      `https://simulation-executor.invalid/api/v1/ai/opportunities?timeframe=${timeframe}&limit=20&platform=${platform}`,
      { signal: AbortSignal.timeout(SIMULATION_OPPORTUNITY_TIMEOUT_MS) },
    );
    const capital = await readCapital(env, ownerId);
    const historyPolicy = await readHistoryPolicy(env, ownerId, timeframe);
    const response = await proxyBackend(
      request, env, true, capital?.total_amount, historyPolicy,
    ).catch(() => null);
    let selectedResponse = response?.ok ? response : null;
    if (!selectedResponse) {
      const headers = new Headers(request.headers);
      headers.set("x-alpha-owner-capital", String(capital?.total_amount || 10_000));
      headers.set("x-alpha-owner-id", ownerId);
      if (historyPolicy) headers.set("x-alpha-history-policy", JSON.stringify(historyPolicy));
      selectedResponse = await baseWorker.fetch(new Request(request, { headers }), env, ctx).catch(() => null);
    }
    if (!selectedResponse?.ok) return [];
    const payload = await selectedResponse.json();
    return Array.isArray(payload?.opportunities) ? payload.opportunities : [];
  });
}

function simulationEvent(row, trade, eventType, occurredAt, payload) {
  return {
    eventId: [row.owner_id, row.client_id, row.platform, trade.id, eventType, occurredAt].join(":"),
    tradeId: String(trade.id),
    eventType,
    occurredAt,
    payload: JSON.stringify(payload),
  };
}

function simulationEventStatement(env, row, event, runId) {
  return env.DB.prepare(`
    INSERT OR IGNORE INTO simulation_trade_events (
      event_id, owner_id, client_id, platform, trade_id, event_type, occurred_at, payload_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM owner_simulation_wallets
      WHERE owner_id = ? AND client_id = ? AND platform = ? AND last_executor_run_id = ?
    )
  `).bind(
    event.eventId,
    row.owner_id,
    row.client_id,
    row.platform,
    event.tradeId,
    event.eventType,
    event.occurredAt,
    event.payload,
    row.owner_id,
    row.client_id,
    row.platform,
    runId,
  );
}

async function commitSimulationWallet(env, row, state, events) {
  const runId = crypto.randomUUID();
  const update = env.DB.prepare(`
    UPDATE owner_simulation_wallets
    SET balance = ?, active_trade = ?, history = ?, integrity_status = ?, integrity_error = ?,
        last_executor_run_id = ?, updated_at = ?, revision = revision + 1
    WHERE owner_id = ? AND client_id = ? AND platform = ? AND revision = ? AND enabled = 1
  `).bind(
    state.balance,
    state.activeJson,
    state.historyJson,
    state.integrityStatus,
    state.integrityError,
    runId,
    state.updatedAt,
    row.owner_id,
    row.client_id,
    row.platform,
    Number(row.revision ?? 0),
  );
  const results = await env.DB.batch([
    update,
    ...events.map((event) => simulationEventStatement(env, row, event, runId)),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

async function saveExecutorHeartbeat(env, row, leaseId, lastRunAt, lastSuccessAt, lastError) {
  // 只允许当前租约持有者释放租约，避免超时旧任务覆盖新一轮执行状态。
  await env.DB.prepare(`
    UPDATE simulation_executor_state
    SET last_run_at = ?, last_success_at = ?, last_error = ?, updated_at = ?,
        lease_id = NULL, lease_until = NULL
    WHERE owner_id = ? AND client_id = ? AND platform = ? AND lease_id = ?
  `).bind(
    lastRunAt,
    lastSuccessAt,
    lastError,
    new Date().toISOString(),
    row.owner_id,
    row.client_id,
    row.platform,
    leaseId,
  ).run();
}

async function claimSimulationWallet(env, row, now) {
  const leaseId = crypto.randomUUID();
  const leaseUntil = Math.floor(now / 1000) + 90;
  const result = await env.DB.prepare(`
    INSERT INTO simulation_executor_state (
      owner_id, client_id, platform, last_run_at, last_success_at, last_error, updated_at,
      lease_id, lease_until
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    ON CONFLICT(owner_id, client_id, platform) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      updated_at = excluded.updated_at,
      lease_id = excluded.lease_id,
      lease_until = excluded.lease_until
    WHERE simulation_executor_state.lease_until IS NULL
       OR simulation_executor_state.lease_until <= ?
  `).bind(
    row.owner_id,
    row.client_id,
    row.platform,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    leaseId,
    leaseUntil,
    Math.floor(now / 1000),
  ).run();
  return Number(result?.meta?.changes ?? 0) > 0 ? leaseId : null;
}

async function executeSimulationWallet(env, ctx, row, now, cache) {
  const autoTimeframe = SUPPORTED_TIMEFRAMES.has(row.auto_timeframe) ? row.auto_timeframe : "4h";
  const originalActiveTrades = parseJson(row.active_trade, []);
  let activeTrades = (Array.isArray(originalActiveTrades)
    ? originalActiveTrades
    : originalActiveTrades && typeof originalActiveTrades === "object" ? [originalActiveTrades] : []
  ).slice(0, MAX_ACTIVE_DECISIONS);
  const originalHistory = parseJson(row.history, []);
  let history = Array.isArray(originalHistory) ? originalHistory.slice(0, 500) : [];
  let balance = Number(row.balance);
  const events = [];
  const nextActiveTrades = [];
  const integrityWarnings = [];

  for (const storedTrade of activeTrades) {
    const trade = storedTrade?.analysis && typeof storedTrade.analysis === "object"
      ? { ...storedTrade, analysis: { ...storedTrade.analysis, platform: row.platform } }
      : storedTrade;
    try {
      const symbol = String(trade?.analysis?.symbol || "").toUpperCase();
      if (!/^[A-Z0-9]{2,15}$/.test(symbol)) throw new Error("模拟持仓币种格式无效");
      const query = `platform=${row.platform}`;
      const candleLimit = simulationCandleLimit(trade, now);
      const [snapshot, candles] = await Promise.all([
        fetchSimulationMarketData(env, ctx, `/api/v1/market/${symbol}?${query}`, row.platform, cache),
        fetchSimulationMarketData(
          env, ctx, `/api/v1/market/${symbol}/candles?interval=1m&limit=${candleLimit}&${query}`, row.platform, cache,
        ),
      ]);
      const gap = findSimulationCandleGap(trade, candles, now);
      if (gap) {
        integrityWarnings.push(`${symbol}：${gap.reason}`);
        nextActiveTrades.push(trade);
        continue;
      }
      const processed = processServerSimulatedCandles(trade, candles, Number(snapshot?.price), now);
      if (processed.completedTrade) {
        const completed = processed.completedTrade;
        balance += Number(completed.net_pnl) || 0;
        history = [completed, ...history.filter((item) => item?.id !== completed.id)].slice(0, 500);
        events.push(simulationEvent(row, completed, "closed", completed.closed_at, {
          trade: completed,
        }));
      } else if (processed.activeTrade) {
        if (!trade.firstTargetHit && processed.activeTrade.firstTargetHit) {
          events.push(simulationEvent(row, processed.activeTrade, "first_target", new Date(now).toISOString(), {
            symbol,
            price: processed.activeTrade.analysis.take_profit?.[0],
          }));
        }
        nextActiveTrades.push(processed.activeTrade);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      console.error(`模拟持仓 ${String(trade?.id || "未知")} 更新失败，已保留原状态`, error);
      integrityWarnings.push(`${String(trade?.analysis?.symbol || "未知币种")}：${detail}`);
      nextActiveTrades.push(trade);
    }
  }
  activeTrades = nextActiveTrades;

  const opportunities = await loadSimulationOpportunities(
    env, ctx, row.owner_id, row.platform, autoTimeframe, cache,
  );
  const activeSymbols = new Set(activeTrades.map((trade) => trade?.analysis?.symbol));
  const executedSignals = new Set([
    ...activeTrades.map((trade) => simulationSignalKey(trade.analysis, trade.timeframe || "4h", row.platform)),
    ...history.map((trade) => simulationSignalKey(trade.analysis, trade.timeframe || "4h", row.platform)),
  ]);
  for (const candidate of opportunities) {
    if (activeTrades.length >= MAX_ACTIVE_DECISIONS) break;
    const signalKey = simulationSignalKey(candidate, autoTimeframe, row.platform);
    if (candidate?.is_executable !== true
      || candidate.platform !== row.platform
      || activeSymbols.has(candidate.symbol)
      || executedSignals.has(signalKey)) continue;
    try {
      const trade = openServerSimulatedTrade(candidate, autoTimeframe, balance, now + activeTrades.length);
      activeTrades.push(trade);
      activeSymbols.add(candidate.symbol);
      executedSignals.add(signalKey);
      events.push(simulationEvent(row, trade, "opened", new Date(trade.startedAt).toISOString(), {
        symbol: candidate.symbol,
        direction: candidate.direction,
        entry_price: trade.entryPrice,
      }));
    } catch {
      // 价格离开最优入场价的内部触发带或决策字段不完整时安全跳过，等待下一次重新扫描。
    }
  }

  const activeJson = activeTrades.length > 0 ? JSON.stringify(activeTrades) : null;
  const historyJson = JSON.stringify(history);
  const integrityStatus = integrityWarnings.length > 0
    ? integrityWarnings.some((item) => item.includes("K 线")) ? "gap" : "error"
    : "ok";
  const integrityError = integrityWarnings.length > 0 ? integrityWarnings.join("；").slice(0, 1000) : null;
  const changed = activeJson !== (row.active_trade || null)
    || historyJson !== row.history
    || balance !== Number(row.balance)
    || integrityStatus !== (row.integrity_status || "ok")
    || integrityError !== (row.integrity_error || null);
  if (!changed) return integrityWarnings;

  const updatedAt = new Date(now).toISOString();
  const committed = await commitSimulationWallet(env, row, {
    balance,
    activeJson,
    historyJson,
    integrityStatus,
    integrityError,
    updatedAt,
  }, events);
  if (!committed) {
    console.log(`模拟钱包 ${row.client_id}/${row.platform} 已被其他请求更新，本轮跳过写回`);
    return ["钱包状态已并发更新，本轮结果未写入"];
  }
  return integrityWarnings;
}

async function runScheduledSimulation(env, ctx) {
  if (!env.DB) {
    console.error("模拟交易定时执行失败：D1 数据库未配置");
    return;
  }
  let rows;
  try {
    const result = await env.DB.prepare(`
      SELECT w.owner_id, w.client_id, w.platform, w.balance, w.active_trade, w.history,
             w.auto_timeframe, w.updated_at, w.revision, w.integrity_status, w.integrity_error
      FROM owner_simulation_wallets AS w
      LEFT JOIN simulation_executor_state AS s
        ON s.owner_id = w.owner_id AND s.client_id = w.client_id AND s.platform = w.platform
      WHERE w.enabled = 1
      ORDER BY COALESCE(s.last_run_at, '') ASC, w.updated_at ASC
      LIMIT ?
    `).bind(SIMULATION_EXECUTOR_WALLET_LIMIT).all();
    rows = result.results || [];
  } catch (error) {
    console.error("模拟交易定时执行失败：请先应用数据库迁移", error);
    return;
  }

  const cache = { market: new Map(), opportunities: new Map() };
  const executeClaimedWallet = async (row) => {
    const startedAt = Date.now();
    const leaseId = await claimSimulationWallet(env, row, startedAt);
    if (!leaseId) return;
    const lastRunAt = new Date(startedAt).toISOString();
    try {
      const warnings = await executeSimulationWallet(env, ctx, row, Date.now(), cache);
      const warningDetail = warnings?.length ? warnings.join("；").slice(0, 1000) : null;
      await saveExecutorHeartbeat(
        env, row, leaseId, lastRunAt, warningDetail ? null : new Date().toISOString(), warningDetail,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      console.error(`模拟钱包 ${row.client_id}/${row.platform} 定时执行失败`, error);
      await saveExecutorHeartbeat(env, row, leaseId, lastRunAt, null, detail).catch((heartbeatError) => {
        console.error("模拟交易执行状态保存失败", heartbeatError);
      });
    }
  };
  for (let index = 0; index < rows.length; index += 5) {
    await Promise.all(rows.slice(index, index + 5).map(executeClaimedWallet));
  }
}

async function runScheduledDecisionScan(env, ctx, now = Date.now()) {
  if (!env.DB || !String(env.OWNER_API_TOKEN || "").trim()) return;
  const ownerId = (await digest(String(env.OWNER_API_TOKEN).trim())).slice(0, 24);
  const capital = await readCapital(env, ownerId);
  if (!capital) return;
  const minute = Math.floor(now / 60_000);
  const platform = SCHEDULED_DECISION_PLATFORMS[minute % SCHEDULED_DECISION_PLATFORMS.length];
  const timeframe = "4h";
  // 已启用的模拟钱包会在同一轮执行中扫描机会，避免重复拉取相同行情。
  const simulationScan = await env.DB.prepare(`
    SELECT 1 AS enabled
    FROM owner_simulation_wallets
    WHERE owner_id = ? AND platform = ? AND enabled = 1 AND auto_timeframe = ?
    LIMIT 1
  `).bind(ownerId, platform, timeframe).first();
  if (simulationScan) return;
  const jobKey = `${ownerId}:decision-scan:${platform}:${timeframe}`;
  const leaseUntil = Math.floor(now / 1000) + 55;
  const lease = await env.DB.prepare(`
    INSERT INTO scheduled_job_leases (job_key, lease_until, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(job_key) DO UPDATE SET
      lease_until = excluded.lease_until,
      updated_at = excluded.updated_at
    WHERE scheduled_job_leases.lease_until <= ?
  `).bind(jobKey, leaseUntil, new Date(now).toISOString(), Math.floor(now / 1000)).run();
  if (Number(lease?.meta?.changes ?? 0) === 0) return;
  const historyPolicy = await readHistoryPolicy(env, ownerId, timeframe);
  const headers = new Headers({
    "x-alpha-owner-capital": String(capital.total_amount),
    "x-alpha-owner-id": ownerId,
  });
  if (historyPolicy) headers.set("x-alpha-history-policy", JSON.stringify(historyPolicy));
  const response = await baseWorker.fetch(new Request(
    `https://scheduled-scan.invalid/api/v1/ai/opportunities?platform=${platform}&timeframe=${timeframe}&limit=4&force_refresh=true`,
    { headers },
  ), env, ctx);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || `${platform} 定时决策扫描失败：${response.status}`);
  }
  console.log(`${platform} 定时决策扫描完成`);
}

export class SimulationScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    if (await this.state.storage.getAlarm() === null) {
      await this.state.storage.setAlarm(Date.now() + 1_000);
    }
    return new Response(null, { status: 204 });
  }

  async alarm() {
    try {
      await runScheduledSimulation(this.env, {
        waitUntil: (promise) => this.state.waitUntil(promise),
      });
    } catch (error) {
      console.error("模拟交易备用调度执行失败", error);
    } finally {
      // Alarm 不会自动重复，必须在每轮结束后显式续约。
      await this.state.storage.setAlarm(Date.now() + SIMULATION_SCHEDULER_INTERVAL_MS);
    }
  }
}

function startSimulationScheduler(env, ctx) {
  if (!env.SIMULATION_SCHEDULER || typeof ctx?.waitUntil !== "function") return;
  const scheduler = env.SIMULATION_SCHEDULER.getByName("simulation-executor");
  ctx.waitUntil(scheduler.fetch("https://simulation-scheduler.invalid/ensure").catch((error) => {
    console.error("模拟交易备用调度启动失败", error);
  }));
}

async function proxyBackend(
  request,
  env,
  authenticated = false,
  totalAmount = null,
  historyPolicy = null,
) {
  const base = String(env.BACKEND_API_URL || "").trim();
  if (!base) return null;
  const source = new URL(request.url);
  let backend;
  try {
    backend = new URL(base);
  } catch {
    return json({ detail: "完整后端地址配置无效" }, 503);
  }
  if (backend.protocol !== "https:") {
    return json({ detail: "完整后端必须使用 HTTPS" }, 503);
  }
  const target = new URL(source.pathname + source.search, backend);
  // 代理使用克隆副本，保留原请求体供完整后端失败后的边缘规则回退使用。
  const upstream = new Request(target, request.clone());
  if (!authenticated) return fetch(upstream);
  const headers = new Headers(upstream.headers);
  headers.set("authorization", `Bearer ${String(env.OWNER_API_TOKEN).trim()}`);
  if (Number.isFinite(totalAmount) && totalAmount > 0) {
    headers.set("x-alpha-owner-capital", String(totalAmount));
  }
  if (historyPolicy) {
    headers.set("x-alpha-history-policy", JSON.stringify(historyPolicy));
  }
  const workerSignature = await createBackendSignature(request, env.BACKEND_SIGNING_PRIVATE_KEY);
  if (workerSignature) {
    headers.set("x-alpha-worker-timestamp", workerSignature.timestamp);
    headers.set("x-alpha-worker-signature", workerSignature.signature);
  }
  headers.delete("cookie");
  const response = await fetch(new Request(upstream, { headers }));
  if (response.status === 401 || response.status === 403) {
    console.error("完整后端拒绝了 Worker 访问令牌，请检查两端 OWNER_API_TOKEN 是否一致");
    return json({ detail: "服务端访问令牌配置不一致" }, 502);
  }
  return response;
}

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const authRoute = url.pathname.startsWith("/api/v1/auth/");
    if (authRoute) return handleAuth(request, env, url);
    const simulationMatch = url.pathname.match(/^\/api\/v1\/simulation\/wallet\/([A-Za-z0-9_-]{8,64})$/);
    const simulationEventsMatch = url.pathname.match(/^\/api\/v1\/simulation\/wallet\/([A-Za-z0-9_-]{8,64})\/events$/);
    const protectedLocally = simulationMatch || simulationEventsMatch || url.pathname === "/api/v1/settings/capital";
    const aiRoute = url.pathname === "/api/v1/ai/analyze" || url.pathname === "/api/v1/ai/opportunities";
    const publicBackendRoute = Boolean(url.pathname.match(/^\/api\/v1\/(market\/|news(?:\/|$))/));
    const fullBackendRoute = url.pathname.startsWith("/api/v1/")
      && !publicBackendRoute
      && !protectedLocally
      && !aiRoute;
    const nonHyperliquid = url.searchParams.get("platform")
      && url.searchParams.get("platform") !== "hyperliquid";

    if (nonHyperliquid && publicBackendRoute) {
      const proxied = await proxyBackend(request, env).catch(() => null);
      if (proxied?.ok || (proxied && proxied.status < 500)) return proxied;
      // 完整后端休眠时由边缘端直接读取交易所公开行情。
    }

    if (fullBackendRoute) {
      const auth = await authenticateOwner(request, env);
      if (auth.error) return auth.error;
      const capital = await readCapital(env, auth.ownerId);
      const historyPolicy = request.method === "POST" && url.pathname === "/api/v1/executions"
        ? await readHistoryPolicy(env, auth.ownerId, await readRequestTimeframe(request, url))
        : null;
      const proxied = await proxyBackend(
        request, env, true, capital?.total_amount, historyPolicy,
      );
      return proxied ?? json({ detail: "当前部署尚未配置完整后端服务" }, 503);
    }

    if (protectedLocally || aiRoute) {
      const auth = await authenticateOwner(request, env);
      if (auth.error) return auth.error;
      if (simulationMatch) {
        const platform = url.searchParams.get("platform") || "hyperliquid";
        if (!["hyperliquid", "binance", "okx"].includes(platform)) {
          return json({ detail: "不支持的模拟交易平台" }, 422);
        }
        return handleSimulationWallet(request, env, ctx, auth.ownerId, simulationMatch[1], platform);
      }
      if (simulationEventsMatch) {
        const platform = url.searchParams.get("platform") || "hyperliquid";
        if (!["hyperliquid", "binance", "okx"].includes(platform)) {
          return json({ detail: "不支持的模拟交易平台" }, 422);
        }
        return handleSimulationEvents(
          request, env, auth.ownerId, simulationEventsMatch[1], platform, url,
        );
      }
      if (url.pathname === "/api/v1/settings/capital") {
        return handleCapital(request, env, auth.ownerId);
      }
      if (aiRoute) {
        const capital = await readCapital(env, auth.ownerId);
        const historyPolicy = await readHistoryPolicy(
          env, auth.ownerId, await readRequestTimeframe(request, url),
        );
        if (!capital) return json({ detail: "资金设置数据库尚未配置" }, 503);
        // 决策固定由边缘规则引擎生成，避免后端休眠与恢复时切换到另一套计划。
        const headers = new Headers(request.headers);
        headers.set("x-alpha-owner-capital", String(capital.total_amount));
        headers.set("x-alpha-owner-id", auth.ownerId);
        if (historyPolicy) {
          headers.set("x-alpha-history-policy", JSON.stringify(historyPolicy));
        }
        const edgeResponse = await baseWorker.fetch(new Request(request, { headers }), env, ctx);
        return edgeResponse;
      }
    }
    return baseWorker.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (["/", "/app", "/index.html"].includes(url.pathname)) {
      startSimulationScheduler(env, ctx);
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/") && APP_ORIGINS.has(request.headers.get("origin") || "")) {
      return withAppCors(request, new Response(null, { status: 204 }));
    }
    const response = await handleRequest(request, env, ctx);
    return withAppCors(request, withHtmlNoStore(request, response));
  },
  async scheduled(controller, env, ctx) {
    const scheduledAt = Number(controller?.scheduledTime);
    const now = Number.isFinite(scheduledAt) ? scheduledAt : Date.now();
    try {
      await runScheduledDecisionScan(env, ctx, now);
    } catch (error) {
      console.error("定时决策扫描失败，继续处理模拟交易", error);
    }
    await runScheduledSimulation(env, ctx);
  },
};
