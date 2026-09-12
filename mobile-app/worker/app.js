import baseWorker from "./index.js";

const APP_ORIGINS = new Set(["https://localhost", "http://localhost"]);

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

async function authenticateOwner(request, env) {
  const expected = String(env.OWNER_API_TOKEN || "").trim();
  if (!expected) return { error: json({ detail: "服务端尚未配置访问令牌" }, 503) };
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const [expectedHash, suppliedHash] = await Promise.all([digest(expected), digest(supplied)]);
  if (!supplied || expectedHash !== suppliedHash) {
    return { error: json({ detail: "访问令牌无效或缺失" }, 401) };
  }
  return { ownerId: expectedHash.slice(0, 24) };
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
  return {
    client_id: clientId,
    platform,
    enabled: Boolean(row?.enabled),
    balance: Number(row?.balance ?? 1_000),
    activeTrade: parseJson(row?.active_trade, null),
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
      const activeTrade = payload.activeTrade === null || typeof payload.activeTrade === "object"
        ? payload.activeTrade
        : undefined;
      if (typeof payload.enabled !== "boolean" || !Number.isFinite(balance) || balance < 0 || balance > 1_000_000_000 || history === null || activeTrade === undefined) {
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
        activeTrade ? JSON.stringify(activeTrade) : null,
        JSON.stringify(history),
        now,
      ).run();
      return json(walletResponse({
        enabled: payload.enabled,
        balance,
        active_trade: activeTrade ? JSON.stringify(activeTrade) : null,
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

async function proxyBackend(request, env) {
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
  return fetch(new Request(target, request));
}

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const simulationMatch = url.pathname.match(/^\/api\/v1\/simulation\/wallet\/([A-Za-z0-9_-]{8,64})$/);
    const protectedLocally = simulationMatch || url.pathname === "/api/v1/settings/capital";
    const aiRoute = url.pathname === "/api/v1/ai/analyze" || url.pathname === "/api/v1/ai/opportunities";
    const fullBackendRoute = url.pathname.startsWith("/api/v1/")
      && !url.pathname.match(/^\/api\/v1\/(market\/|news(?:\/|$))/)
      && !protectedLocally
      && !aiRoute;
    const nonHyperliquid = url.searchParams.get("platform")
      && url.searchParams.get("platform") !== "hyperliquid";

    if (fullBackendRoute || (nonHyperliquid && !protectedLocally)) {
      const proxied = await proxyBackend(request, env);
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
      const capital = await readCapital(env, auth.ownerId);
      if (!capital) return json({ detail: "资金设置数据库尚未配置" }, 503);
      const headers = new Headers(request.headers);
      headers.set("x-alpha-owner-capital", String(capital.total_amount));
      return baseWorker.fetch(new Request(request, { headers }), env, ctx);
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
