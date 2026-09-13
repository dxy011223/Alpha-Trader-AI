import baseWorker from "./index.js";

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

function walletResponse(row, clientId, platform) {
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
    updated_at: row?.updated_at ?? new Date().toISOString(),
  };
}

async function handleSimulationWallet(request, env, ownerId, clientId, platform) {
  if (!env.DB) return json({ detail: "模拟交易数据库尚未配置" }, 503);
  try {
    if (request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT enabled, balance, active_trade, history, updated_at FROM owner_simulation_wallets WHERE owner_id = ? AND client_id = ? AND platform = ?",
      ).bind(ownerId, clientId, platform).first();
      return json(walletResponse(row, clientId, platform));
    }
    if (request.method === "PUT") {
      const payload = await request.json();
      const balance = Number(payload.balance);
      const history = Array.isArray(payload.history) ? payload.history.slice(0, 500) : null;
      const activeTrades = Array.isArray(payload.activeTrades)
        ? payload.activeTrades
        : payload.activeTrade === null ? []
          : payload.activeTrade && typeof payload.activeTrade === "object" ? [payload.activeTrade] : undefined;
      const activeTradesValid = Array.isArray(activeTrades)
        && activeTrades.length <= MAX_ACTIVE_DECISIONS
        && activeTrades.every((trade) => trade && typeof trade === "object" && !Array.isArray(trade));
      if (typeof payload.enabled !== "boolean" || !Number.isFinite(balance) || Math.abs(balance) > 1_000_000_000 || history === null || !activeTradesValid) {
        return json({ detail: "模拟钱包数据格式不正确" }, 422);
      }
      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO owner_simulation_wallets (owner_id, client_id, platform, enabled, balance, active_trade, history, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, client_id, platform) DO UPDATE SET
          enabled = excluded.enabled,
          balance = excluded.balance,
          active_trade = excluded.active_trade,
          history = excluded.history,
          updated_at = excluded.updated_at
      `).bind(
        ownerId,
        clientId,
        platform,
        payload.enabled ? 1 : 0,
        balance,
        activeTrades.length > 0 ? JSON.stringify(activeTrades) : null,
        JSON.stringify(history),
        now,
      ).run();
      return json(walletResponse({
        enabled: payload.enabled,
        balance,
        active_trade: activeTrades.length > 0 ? JSON.stringify(activeTrades) : null,
        history: JSON.stringify(history),
        updated_at: now,
      }, clientId, platform));
    }
  } catch (error) {
    console.error("模拟交易数据库操作失败", error);
    return json({ detail: "模拟交易数据暂时无法保存" }, 503);
  }
  return json({ detail: "不支持的请求方法" }, 405);
}

async function proxyBackend(request, env, authenticated = false) {
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
  const upstream = new Request(target, request);
  if (!authenticated) return fetch(upstream);
  const headers = new Headers(upstream.headers);
  headers.set("authorization", `Bearer ${String(env.OWNER_API_TOKEN).trim()}`);
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
    const protectedLocally = simulationMatch || url.pathname === "/api/v1/settings/capital";
    const aiRoute = url.pathname === "/api/v1/ai/analyze" || url.pathname === "/api/v1/ai/opportunities";
    const publicBackendRoute = Boolean(url.pathname.match(/^\/api\/v1\/(market\/|news(?:\/|$))/));
    const fullBackendRoute = url.pathname.startsWith("/api/v1/")
      && !publicBackendRoute
      && !protectedLocally
      && !aiRoute;
    const nonHyperliquid = url.searchParams.get("platform")
      && url.searchParams.get("platform") !== "hyperliquid";

    if (nonHyperliquid && publicBackendRoute) {
      const proxied = await proxyBackend(request, env);
      return proxied ?? json({ detail: "当前部署尚未配置完整后端服务" }, 503);
    }

    if (fullBackendRoute) {
      const auth = await authenticateOwner(request, env);
      if (auth.error) return auth.error;
      const proxied = await proxyBackend(request, env, true);
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
        return handleSimulationWallet(request, env, auth.ownerId, simulationMatch[1], platform);
      }
      if (url.pathname === "/api/v1/settings/capital") {
        return handleCapital(request, env, auth.ownerId);
      }
      if (aiRoute) {
        const proxied = await proxyBackend(request, env, true);
        if (proxied?.ok || (proxied && proxied.status < 500)) return proxied;
        if (proxied) console.error("完整后端决策暂时不可用，切换到边缘规则引擎");
        const capital = await readCapital(env, auth.ownerId);
        if (!capital) return json({ detail: "资金设置数据库尚未配置" }, 503);
        const headers = new Headers(request.headers);
        headers.set("x-alpha-owner-capital", String(capital.total_amount));
        headers.set("x-alpha-owner-id", auth.ownerId);
        return baseWorker.fetch(new Request(request, { headers }), env, ctx);
      }
    }
    return baseWorker.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/") && APP_ORIGINS.has(request.headers.get("origin") || "")) {
      return withAppCors(request, new Response(null, { status: 204 }));
    }
    const response = await handleRequest(request, env, ctx);
    return withAppCors(request, withHtmlNoStore(request, response));
  },
};
