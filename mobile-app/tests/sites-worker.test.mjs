import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/app.js";

const OWNER_TOKEN = "test-owner-token-abcdefghijklmnopqrstuvwxyz";
const authHeaders = { authorization: `Bearer ${OWNER_TOKEN}` };

test("allows Capacitor API requests without authenticating the CORS preflight", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/v1/ai/analyze", {
    method: "OPTIONS",
    headers: {
      origin: "https://localhost",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  }), {});

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
  assert.match(response.headers.get("access-control-allow-headers"), /Authorization/);
  assert.match(response.headers.get("vary"), /Origin/i);
});

test("adds CORS headers to API responses only for app origins", async () => {
  const env = { OWNER_API_TOKEN: OWNER_TOKEN };
  const allowed = await worker.fetch(new Request("https://example.test/api/v1/settings/capital", {
    headers: { ...authHeaders, origin: "http://localhost" },
  }), env);
  const denied = await worker.fetch(new Request("https://example.test/api/v1/settings/capital", {
    headers: { ...authHeaders, origin: "https://attacker.example" },
  }), env);

  assert.equal(allowed.status, 503);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost");
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

function createSimulationDatabase() {
  const wallets = new Map();
  const capital = new Map();
  const passwordCredentials = new Map();
  const loginRateLimits = new Map();
  const decisionPlans = new Map();
  let writes = 0;
  return {
    get writes() { return writes; },
    get passwordCredentials() { return passwordCredentials; },
    prepare(sql) {
      let params = [];
      return {
        bind(...values) {
          params = values;
          return this;
        },
        async run() {
          writes += 1;
          if (sql.includes("INSERT INTO owner_password_credentials")) {
            const [ownerId, username, salt, passwordHash, iterations, createdAt, updatedAt] = params;
            const duplicate = passwordCredentials.has(username)
              || [...passwordCredentials.values()].some((item) => item.owner_id === ownerId);
            if (duplicate) throw new Error("账号已存在");
            passwordCredentials.set(username, {
              owner_id: ownerId,
              username_normalized: username,
              password_salt: salt,
              password_hash: passwordHash,
              password_iterations: iterations,
              failed_attempts: 0,
              failed_window_started_at: null,
              locked_until: null,
              created_at: createdAt,
              updated_at: updatedAt,
            });
          } else if (sql.includes("UPDATE owner_password_credentials")) {
            const reset = sql.includes("failed_attempts = 0");
            const ownerId = params.at(-1);
            const record = [...passwordCredentials.values()].find((item) => item.owner_id === ownerId);
            if (record) {
              record.failed_attempts = reset ? 0 : params[0];
              record.failed_window_started_at = reset ? null : params[1];
              record.locked_until = reset ? null : params[2];
            }
          } else if (sql.includes("INSERT INTO auth_login_rate_limits")) {
            const [clientHash] = params;
            loginRateLimits.set(clientHash, params.length === 2 ? {
              failed_attempts: 0,
              failed_window_started_at: null,
              locked_until: null,
            } : {
              failed_attempts: params[1],
              failed_window_started_at: params[2],
              locked_until: params[3],
            });
          } else if (sql.includes("owner_capital_settings")) {
            capital.set(params[0], { total_amount: params[1], currency: "USDT", updated_at: params[2] });
          } else if (sql.includes("owner_simulation_wallets")) {
            const key = `${params[0]}:${params[1]}:${params[2]}`;
            wallets.set(key, { enabled: params[3], balance: params[4], active_trade: params[5], history: params[6], updated_at: params[7] });
          } else if (sql.includes("owner_decision_plan_scans")) {
            decisionPlans.set(`${params[0]}:${params[1]}`, { scan_json: params[2], updated_at: params[3] });
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes("FROM owner_password_credentials")) {
            if (sql.includes("LIMIT 1")) return passwordCredentials.values().next().value ?? null;
            return passwordCredentials.get(params[0]) ?? null;
          }
          if (sql.includes("FROM auth_login_rate_limits")) return loginRateLimits.get(params[0]) ?? null;
          if (sql.includes("owner_capital_settings")) return capital.get(params[0]) ?? null;
          if (sql.includes("owner_decision_plan_scans")) return decisionPlans.get(`${params[0]}:${params[1]}`) ?? null;
          return wallets.get(`${params[0]}:${params[1]}:${params[2]}`) ?? null;
        },
      };
    },
  };
}

test("persists simulation wallet state through the D1 binding", async () => {
  const DB = createSimulationDatabase();
  const url = "https://example.test/api/v1/simulation/wallet/device_test_12345678?platform=binance";
  const initial = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  const initialPayload = await initial.json();
  assert.match(initialPayload.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  delete initialPayload.updated_at;
  assert.deepEqual(initialPayload, {
    client_id: "device_test_12345678",
    platform: "binance",
    enabled: false,
    balance: 1_000,
    activeTrades: [],
    activeTrade: null,
    history: [],
  });

  const activeTrades = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const saved = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, balance: -125.5, activeTrades, history: [] }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  const payload = await saved.json();
  assert.equal(payload.enabled, true);
  assert.equal(payload.balance, -125.5);
  assert.deepEqual(payload.activeTrades, activeTrades);
  assert.deepEqual(payload.activeTrade, activeTrades[0], "旧版客户端仍可读取首笔执行状态");

  const reloaded = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.deepEqual((await reloaded.json()).activeTrades, activeTrades);

  const hyperliquid = await worker.fetch(new Request(
    "https://example.test/api/v1/simulation/wallet/device_test_12345678?platform=hyperliquid",
    { headers: authHeaders },
  ), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  const hyperliquidPayload = await hyperliquid.json();
  assert.equal(hyperliquidPayload.platform, "hyperliquid");
  assert.equal(hyperliquidPayload.enabled, false);
  assert.equal(hyperliquidPayload.balance, 1_000);
  assert.equal(DB.writes, 1, "GET 请求不得创建数据库记录");

  const rejected = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, balance: 1_000, activeTrades: [{}, {}, {}, {}], history: [] }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(rejected.status, 422);
  assert.equal(DB.writes, 1, "超过三笔的模拟交易不得写入数据库");
});

test("protects owner state and persists capital in D1", async () => {
  const DB = createSimulationDatabase();
  const url = "https://example.test/api/v1/settings/capital";
  const denied = await worker.fetch(new Request(url), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).detail, "访问令牌缺失");

  const invalid = await worker.fetch(new Request(url, {
    headers: { authorization: "Bearer invalid-owner-token" },
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).detail, "登录状态无效，请重新登录");

  const saved = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ total_amount: 25_000 }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await saved.json()).total_amount, 25_000);

  const reloaded = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await reloaded.json()).total_amount, 25_000);
});

test("exchanges the owner secret for signed bearer and HttpOnly cookie sessions", async () => {
  const bearerEnrollment = await worker.fetch(new Request("https://example.test/api/v1/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ transport: "bearer" }),
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(bearerEnrollment.status, 200);
  const bearerPayload = await bearerEnrollment.json();
  assert.match(bearerPayload.token, /^ats1\./);

  const bearerSession = await worker.fetch(new Request("https://example.test/api/v1/auth/session", {
    headers: { authorization: `Bearer ${bearerPayload.token}` },
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  const refreshedBearerPayload = await bearerSession.json();
  assert.equal(refreshedBearerPayload.authorized, true);
  assert.match(refreshedBearerPayload.token, /^ats1\./);
  assert.notEqual(refreshedBearerPayload.token, bearerPayload.token);

  const tokenParts = bearerPayload.token.split(".");
  tokenParts[3] = `${tokenParts[3].startsWith("A") ? "B" : "A"}${tokenParts[3].slice(1)}`;
  const tamperedToken = tokenParts.join(".");
  const tamperedSession = await worker.fetch(new Request("https://example.test/api/v1/auth/session", {
    headers: { authorization: `Bearer ${tamperedToken}` },
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(tamperedSession.status, 401);

  const malformedCookie = await worker.fetch(new Request("https://example.test/api/v1/auth/session", {
    headers: { cookie: "alpha_owner_session=%broken" },
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(malformedCookie.status, 401);

  const cookieEnrollment = await worker.fetch(new Request("https://example.test/api/v1/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ transport: "cookie" }),
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  const setCookie = cookieEnrollment.headers.get("set-cookie");
  assert.match(setCookie, /alpha_owner_session=ats1\./);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal((await cookieEnrollment.json()).token, undefined);

  const cookie = setCookie.split(";", 1)[0];
  const cookieSession = await worker.fetch(new Request("https://example.test/api/v1/auth/session", {
    headers: { cookie },
  }), { OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(cookieSession.status, 200);
});

test("creates the only local password account without exposing the owner token", async () => {
  const DB = createSimulationDatabase();
  const env = {
    DB,
    DEVICE_SESSION_SECRET: "device-session-secret-abcdefghijklmnopqrstuvwxyz",
    OWNER_API_TOKEN: OWNER_TOKEN,
  };
  const initialStatus = await worker.fetch(
    new Request("https://example.test/api/v1/auth/password/status"),
    env,
  );
  assert.deepEqual(await initialStatus.json(), { setup_required: true });

  const setup = await worker.fetch(new Request("https://example.test/api/v1/auth/password/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Owner@Example.Test", password: "correct-password", transport: "bearer" }),
  }), env);
  assert.equal(setup.status, 200);
  assert.match((await setup.json()).token, /^ats1\./);
  assert.equal([...DB.passwordCredentials.values()][0].password_iterations, 0);

  const duplicateSetup = await worker.fetch(new Request("https://example.test/api/v1/auth/password/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "another-owner", password: "another-password", transport: "bearer" }),
  }), env);
  assert.equal(duplicateSetup.status, 409);
  assert.deepEqual(await duplicateSetup.json(), { detail: "账号已创建，请直接登录" });

  const registeredStatus = await worker.fetch(
    new Request("https://example.test/api/v1/auth/password/status"),
    env,
  );
  assert.deepEqual(await registeredStatus.json(), { setup_required: false });

  const login = await worker.fetch(new Request("https://example.test/api/v1/auth/password/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
    body: JSON.stringify({ username: "owner@example.test", password: "correct-password", transport: "cookie" }),
  }), env);
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /alpha_owner_session=ats1\./);
  assert.equal((await login.json()).token, undefined);
});

test("locks a password account after five failed attempts", async () => {
  const DB = createSimulationDatabase();
  const env = { DB, DEVICE_SESSION_SECRET: "device-session-secret-abcdefghijklmnopqrstuvwxyz", OWNER_API_TOKEN: OWNER_TOKEN };
  await worker.fetch(new Request("https://example.test/api/v1/auth/password/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "correct-password", transport: "bearer" }),
  }), env);

  let response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await worker.fetch(new Request("https://example.test/api/v1/auth/password/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ username: "owner", password: "incorrect-password" }),
    }), env);
  }
  assert.equal(response.status, 429);

  const stillLocked = await worker.fetch(new Request("https://example.test/api/v1/auth/password/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ username: "owner", password: "correct-password" }),
  }), env);
  assert.equal(stillLocked.status, 429);
});

test("keeps device sessions valid when the owner token rotates", async () => {
  const sessionSecret = "device-session-secret-abcdefghijklmnopqrstuvwxyz";
  const enrolled = await worker.fetch(new Request("https://example.test/api/v1/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ transport: "bearer" }),
  }), { DEVICE_SESSION_SECRET: sessionSecret, OWNER_API_TOKEN: OWNER_TOKEN });
  const { token } = await enrolled.json();

  const checked = await worker.fetch(new Request("https://example.test/api/v1/auth/session", {
    headers: { authorization: `Bearer ${token}` },
  }), {
    DEVICE_SESSION_SECRET: sessionSecret,
    OWNER_API_TOKEN: "rotated-owner-token-abcdefghijklmnopqrstuvwxyz",
  });
  assert.equal(checked.status, 200);
});

test("refuses to proxy secrets to an insecure backend", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/v1/executions/active", { headers: authHeaders }),
    { BACKEND_API_URL: "http://backend.example.test", OWNER_API_TOKEN: OWNER_TOKEN },
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).detail, /HTTPS/);
});

test("reports a server configuration error when the backend rejects the Worker token", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  globalThis.fetch = async () => Response.json({ detail: "访问令牌无效" }, { status: 401 });
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const response = await worker.fetch(
      new Request("https://example.test/api/v1/executions/active", { headers: authHeaders }),
      { BACKEND_API_URL: "https://backend.example.test", OWNER_API_TOKEN: OWNER_TOKEN },
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { detail: "服务端访问令牌配置不一致" });
    assert.match(errors.join("\n"), /后端拒绝了 Worker 访问令牌/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("falls back to the edge rule engine when the backend rejects the Worker token", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => Response.json({ detail: "访问令牌无效" }, { status: 401 });
  console.error = () => undefined;

  try {
    const DB = createSimulationDatabase();
    const env = {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    };
    const response = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), env);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.opportunities.length, 4);
    assert.ok(payload.opportunities.every((item) => item.analysis_engine === "rules"));
    assert.ok(payload.opportunities.every((item) => item.reference_price > 0));
    assert.ok(payload.opportunities.every((item) => item.is_executable === false));

    const firstPlan = payload.opportunities[0];
    await worker.fetch(new Request("https://example.test/api/v1/settings/capital", {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ total_amount: 20_000 }),
    }), env);
    const rescanned = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), env);
    const updatedPlan = (await rescanned.json()).opportunities.find((item) => item.symbol === firstPlan.symbol);
    assert.deepEqual(updatedPlan.entry_range, firstPlan.entry_range);
    assert.deepEqual(updatedPlan.take_profit, firstPlan.take_profit);
    assert.equal(updatedPlan.position_sizing.margin_amount, firstPlan.position_sizing.margin_amount * 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("serves the app shell to service-worker preload requests", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/app", { headers: { accept: "*/*" } }),
    {
      ASSETS: {
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          calls.push(pathname);
          return new Response(pathname === "/index.html" ? "app" : "missing", {
            status: pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, ["/app", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, new URL(request.url).pathname.startsWith("/api/") ? 0 : 1);
  }
});

test("serves public market data and keeps a rule fallback when the Python backend is absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (_url instanceof Request && new URL(_url.url).hostname === "backend.example.test") {
      assert.equal(_url.headers.get("authorization"), `Bearer ${OWNER_TOKEN}`);
      assert.equal(_url.headers.get("x-alpha-owner-capital"), "10000");
      return Response.json({ proxied: true });
    }
    if (!init?.body) return Response.json({ Data: [] });
    const payload = JSON.parse(init.body);
    if (payload.type === "metaAndAssetCtxs") {
      return Response.json([
        { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }, { name: "HYPE" }] },
        [
          { markPx: "100", prevDayPx: "98", dayNtlVlm: "1000000", funding: "0.0001", openInterest: "50000" },
          { markPx: "50", prevDayPx: "49", dayNtlVlm: "900000", funding: "0.0001", openInterest: "50000" },
          { markPx: "25", prevDayPx: "24", dayNtlVlm: "800000", funding: "0.0001", openInterest: "50000" },
          { markPx: "10", prevDayPx: "9", dayNtlVlm: "700000", funding: "0.0001", openInterest: "50000" },
        ],
      ]);
    }
    return Response.json([{ t: 1, T: 2, o: "99", h: "101", l: "98", c: "100", v: "42" }]);
  };

  try {
    const market = await worker.fetch(new Request("https://example.test/api/v1/market/BTC"), {});
    assert.equal(market.status, 200);
    assert.equal((await market.json()).source, "live");

    const candles = await worker.fetch(new Request("https://example.test/api/v1/market/BTC/candles?interval=1h&limit=5"), {});
    assert.deepEqual(await candles.json(), [{ open_time: 1, close_time: 2, open: 99, high: 101, low: 98, close: 100, volume: 42 }]);

    const DB = createSimulationDatabase();
    const opportunities = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    });
    assert.equal(opportunities.status, 200);
    const payload = await opportunities.json();
    assert.equal(payload.proxied, true);

    const enrollment = await worker.fetch(new Request("https://example.test/api/v1/auth/device", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ transport: "bearer" }),
    }), { OWNER_API_TOKEN: OWNER_TOKEN });
    const { token: deviceToken } = await enrollment.json();
    const sessionOpportunities = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: { authorization: `Bearer ${deviceToken}` } },
    ), {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    });
    assert.equal(sessionOpportunities.status, 200);
    assert.equal((await sessionOpportunities.json()).proxied, true);

    const edgeRules = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
    assert.equal(edgeRules.status, 200);
    const edgePayload = await edgeRules.json();
    assert.equal(edgePayload.opportunities.length, 4);
    assert.ok(edgePayload.opportunities.every((item) => item.analysis_engine === "rules"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));

  const builtIndex = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(builtIndex, /<script type="module" crossorigin src="\/assets\/[^\"]+\.js"><\/script>/);
});

test("keeps the Cloudflare deployment contract at the repository root", async () => {
  const config = JSON.parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));

  assert.equal(config.main, "./mobile-app/worker/app.js");
  assert.equal(config.assets.directory, "./mobile-app/dist/client");
  assert.equal(config.d1_databases[0].migrations_dir, "./mobile-app/migrations");
  assert.deepEqual(config.secrets.required, [
    "OWNER_API_TOKEN",
    "DEVICE_SESSION_SECRET",
  ]);
});

test("provides installable PWA metadata and icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.equal(manifest.start_url, "/app");
  assert.equal(manifest.display, "standalone");
  assert.match(index, /<meta name="description" content="安装 Alpha Trader AI，查看实时行情、K 线与 AI 决策分析。" \/>/);
  assert.match(index, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.doesNotMatch(serviceWorker, /APP_SHELL\s*=\s*\[[^\]]*"\/app"/);
  assert.match(serviceWorker, /caches\.match\("\/"\)/);
  assert.deepEqual(manifest.icons.slice(0, 2).map((icon) => icon.sizes), ["192x192", "512x512"]);
  await Promise.all([
    access(new URL("../public/icons/app-icon-192.png", import.meta.url)),
    access(new URL("../public/icons/app-icon-512.png", import.meta.url)),
    access(new URL("../public/sw.js", import.meta.url)),
  ]);
});

test("publishes a valid-sized Android APK download", async () => {
  const apk = await stat(new URL("../public/downloads/alpha-trader-ai.apk", import.meta.url));
  const downloadPage = await readFile(new URL("../src/DownloadLanding.tsx", import.meta.url), "utf8");

  assert.ok(apk.size > 1_000_000, "APK should not be an empty placeholder");
  assert.ok(apk.size <= 25 * 1024 * 1024, "APK must fit the Cloudflare static asset limit");
  assert.match(downloadPage, /href="\/downloads\/alpha-trader-ai\.apk\?v=1\.4\.9"/);
});

test("Android bundle removes the prototype device chrome", async () => {
  const prototype = await readFile(new URL("../src/Prototype.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/prototype.css", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(prototype, /VITE_APP_TARGET === "android"/);
  assert.match(prototype, /classList\.add\("native-android"\)/);
  assert.match(styles, /\.native-android \.phone-bezel/);
  assert.match(styles, /\.native-android \.status-bar/);
  assert.match(styles, /\.native-android \.keyboard-dock/);
  assert.match(packageJson.scripts["android:sync"], /prepare-android-assets\.mjs/);
});
