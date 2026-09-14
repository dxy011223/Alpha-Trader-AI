import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import worker, { SimulationScheduler } from "../worker/app.js";
import {
  findSimulationCandleGap,
  openServerSimulatedTrade,
  processServerSimulatedCandles,
  processServerSimulatedPriceRange,
  SIMULATION_FUNDING_PERIOD_MS,
} from "../worker/simulation-engine.js";

const OWNER_TOKEN = "test-owner-token-abcdefghijklmnopqrstuvwxyz";
const authHeaders = { authorization: `Bearer ${OWNER_TOKEN}` };
const CORE_TEST_SYMBOLS = ["BTC", "ETH", "SOL", "HYPE"];

function executableAnalysis(overrides = {}) {
  return {
    symbol: "BTC",
    direction: "LONG",
    entry_range: [99, 101],
    current_price: 100,
    stop_loss: 95,
    take_profit: [105, 110],
    leverage: 2,
    funding_rate: 0.01,
    position_sizing: { margin_amount: 100 },
    platform: "hyperliquid",
    is_executable: true,
    ...overrides,
  };
}

test("server simulation engine rejects stale entries and applies execution costs", () => {
  assert.throws(
    () => openServerSimulatedTrade(executableAnalysis({ current_price: 102 }), "4h", 1_000, 1_000),
    /入场区间/,
  );
  const trade = openServerSimulatedTrade(executableAnalysis(), "4h", 1_000, 1_000);
  assert.equal(trade.triggerPrice, 100);
  assert.equal(trade.entryPrice, 100.02);
  assert.ok(trade.entryFee > 0);
  assert.ok(trade.unrealizedPnl < 0);
});

test("server simulation engine replays candles conservatively and closes at the second target", () => {
  const trade = openServerSimulatedTrade(executableAnalysis(), "4h", 1_000, 1_000);
  const ambiguous = processServerSimulatedPriceRange(trade, 94, 111, 100, 2_000);
  assert.equal(ambiguous.completedTrade.exit_reason, "stop_loss");

  const firstTarget = processServerSimulatedPriceRange(trade, 99, 106, 104, 2_000);
  assert.equal(firstTarget.activeTrade.firstTargetHit, true);
  assert.equal(firstTarget.activeTrade.size, trade.size / 2);
  assert.equal(firstTarget.activeTrade.effectiveStopLoss, trade.entryPrice);

  const completed = processServerSimulatedCandles(firstTarget.activeTrade, [{
    open_time: 2_000,
    close_time: 3_000,
    open: 104,
    high: 111,
    low: 103,
    close: 110,
    volume: 10,
  }], 110, 3_000);
  assert.equal(completed.completedTrade.exit_reason, "take_profit");
  assert.equal(completed.completedTrade.first_target_hit, true);
  assert.ok(completed.completedTrade.net_pnl > 0);
});

test("server simulation engine accrues funding by elapsed time", () => {
  const trade = openServerSimulatedTrade(executableAnalysis(), "4h", 1_000, 1_000);
  const updated = processServerSimulatedPriceRange(
    trade, 100, 100, 100, 1_000 + SIMULATION_FUNDING_PERIOD_MS,
  );
  assert.ok(updated.activeTrade.fundingAccrued > 0);
  assert.ok(updated.activeTrade.unrealizedPnl < -trade.entryFee);
});

test("server simulation engine pauses when historical candles contain a gap", () => {
  const trade = openServerSimulatedTrade(executableAnalysis(), "4h", 1_000, 1_000);
  const gap = findSimulationCandleGap(trade, [{
    open_time: 600_000,
    close_time: 660_000,
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 10,
  }], 720_000);
  assert.equal(gap.reason, "历史 K 线不足，无法可靠还原止盈止损触发顺序");
});

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
  const executorStates = new Map();
  const simulationEvents = new Map();
  let writes = 0;
  return {
    get writes() { return writes; },
    get passwordCredentials() { return passwordCredentials; },
    get simulationEvents() { return simulationEvents; },
    get simulationWallets() { return wallets; },
    async batch(statements) {
      const snapshots = {
        wallets: new Map([...wallets].map(([key, value]) => [key, structuredClone(value)])),
        events: new Map([...simulationEvents].map(([key, value]) => [key, structuredClone(value)])),
      };
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        wallets.clear();
        simulationEvents.clear();
        for (const [key, value] of snapshots.wallets) wallets.set(key, value);
        for (const [key, value] of snapshots.events) simulationEvents.set(key, value);
        throw error;
      }
    },
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
          } else if (sql.includes("UPDATE owner_simulation_wallets")) {
            const isSettingsUpdate = sql.includes("SET enabled = ?, auto_timeframe");
            const [ownerId, clientId, platform, expectedRevision] = isSettingsUpdate
              ? [params[8], params[9], params[10], params[11]]
              : [params[7], params[8], params[9], params[10]];
            const key = `${ownerId}:${clientId}:${platform}`;
            const record = wallets.get(key);
            if (!record || Number(record.revision ?? 0) !== expectedRevision || (!isSettingsUpdate && !record.enabled)) {
              return { success: true, meta: { changes: 0 } };
            }
            if (isSettingsUpdate) {
              const reset = params[2] === 1;
              wallets.set(key, {
                ...record,
                enabled: params[0],
                auto_timeframe: params[1],
                balance: reset ? 1_000 : record.balance,
                active_trade: reset ? null : record.active_trade,
                history: reset ? "[]" : record.history,
                integrity_status: reset ? "ok" : record.integrity_status,
                integrity_error: reset ? null : record.integrity_error,
                updated_at: params[7],
                revision: Number(record.revision ?? 0) + 1,
              });
            } else {
              wallets.set(key, {
                ...record,
                balance: params[0],
                active_trade: params[1],
                history: params[2],
                integrity_status: params[3],
                integrity_error: params[4],
                last_executor_run_id: params[5],
                updated_at: params[6],
                revision: Number(record.revision ?? 0) + 1,
              });
            }
          } else if (sql.includes("UPDATE simulation_executor_state")) {
            const key = `${params[4]}:${params[5]}:${params[6]}`;
            const existing = executorStates.get(key);
            if (!existing || existing.lease_id !== params[7]) {
              return { success: true, meta: { changes: 0 } };
            }
            executorStates.set(key, {
              ...existing,
              last_run_at: params[0],
              last_success_at: params[1],
              last_error: params[2],
              updated_at: params[3],
              lease_id: null,
              lease_until: null,
            });
          } else if (sql.includes("INSERT INTO simulation_executor_state")) {
            const [ownerId, clientId, platform] = params;
            const key = `${ownerId}:${clientId}:${platform}`;
            if (sql.includes("lease_id = excluded.lease_id")) {
              const existing = executorStates.get(key);
              if (Number(existing?.lease_until || 0) > params[7]) {
                return { success: true, meta: { changes: 0 } };
              }
              executorStates.set(key, {
                ...existing,
                last_run_at: params[3],
                updated_at: params[4],
                lease_id: params[5],
                lease_until: params[6],
              });
            }
          } else if (sql.includes("INSERT OR IGNORE INTO simulation_trade_events")) {
            const wallet = wallets.get(`${params[8]}:${params[9]}:${params[10]}`);
            if (params.length > 8 && wallet?.last_executor_run_id !== params[11]) {
              return { success: true, meta: { changes: 0 } };
            }
            simulationEvents.set(params[0], {
              event_id: params[0],
              owner_id: params[1],
              client_id: params[2],
              platform: params[3],
              trade_id: params[4],
              event_type: params[5],
              occurred_at: params[6],
              payload_json: params[7],
            });
          } else if (sql.includes("owner_simulation_wallets")) {
            const key = `${params[0]}:${params[1]}:${params[2]}`;
            wallets.set(key, {
              platform: params[2],
              enabled: params[3],
              balance: 1_000,
              active_trade: null,
              history: "[]",
              auto_timeframe: params[4],
              updated_at: params[5],
              revision: 0,
              integrity_status: "ok",
              integrity_error: null,
            });
          } else if (sql.includes("owner_decision_plan_scans")) {
            decisionPlans.set(`${params[0]}:${params[1]}:${params[2]}`, { scan_json: params[3], updated_at: params[4] });
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
          if (sql.includes("owner_decision_plan_scans")) return decisionPlans.get(`${params[0]}:${params[1]}:${params[2]}`) ?? null;
          if (sql.includes("FROM simulation_executor_state")) return executorStates.get(`${params[0]}:${params[1]}:${params[2]}`) ?? null;
          return wallets.get(`${params[0]}:${params[1]}:${params[2]}`) ?? null;
        },
        async all() {
          if (sql.includes("FROM simulation_trade_events")) {
            const ownerId = params[0];
            const clientId = sql.includes("client_id = ?") ? params[1] : null;
            const platform = clientId ? params[2] : null;
            const requestedLimit = Number(params.at(-1));
            const limit = Number.isFinite(requestedLimit) ? requestedLimit : 6000;
            return {
              results: [...simulationEvents.values()]
                .filter((event) => event.owner_id === ownerId
                  && (!clientId || event.client_id === clientId)
                  && (!platform || event.platform === platform)
                  && (!sql.includes("event_type = 'closed'") || event.event_type === "closed"))
                .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
                .slice(0, limit),
            };
          }
          if (sql.includes("WHERE enabled = 1") || sql.includes("WHERE w.enabled = 1")) {
            return {
              results: [...wallets.entries()]
                .filter(([, value]) => Boolean(value.enabled))
                .slice(0, Number(params[0]))
                .map(([key, value]) => {
                  const [owner_id, client_id, platform] = key.split(":");
                  return { owner_id, client_id, platform, ...value };
                }),
            };
          }
          if (!sql.includes("owner_simulation_wallets")) return { results: [] };
          const ownerPrefix = `${params[0]}:`;
          return {
            results: [...wallets.entries()]
              .filter(([key]) => key.startsWith(ownerPrefix))
              .map(([, value]) => ({ platform: value.platform, history: value.history })),
          };
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
    autoTimeframe: "4h",
    revision: 0,
    integrity: { status: "ok", detail: null },
    executor: {
      mode: "server",
      healthy: false,
      last_run_at: null,
      last_success_at: null,
      last_error: null,
    },
  });

  const activeTrades = [{ id: 1, analysis: { platform: "okx" } }, { id: 2 }, { id: 3 }];
  const saved = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, balance: -125.5, activeTrades, history: [{ net_pnl: 999 }], autoTimeframe: "1h" }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  const payload = await saved.json();
  assert.equal(payload.enabled, true);
  assert.equal(payload.balance, 1_000, "客户端上传的余额必须被忽略");
  assert.deepEqual(payload.activeTrades, [], "客户端上传的持仓必须被忽略");
  assert.deepEqual(payload.history, [], "客户端上传的历史必须被忽略");
  assert.equal(payload.autoTimeframe, "1h");

  const reloaded = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.deepEqual((await reloaded.json()).activeTrades, []);

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
    body: JSON.stringify({ enabled: true, autoTimeframe: "2h" }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(rejected.status, 422);
  assert.equal(DB.writes, 1, "非法自动周期不得写入数据库");
});

test("rejects stale simulation wallet revisions instead of overwriting newer data", async () => {
  const DB = createSimulationDatabase();
  const url = "https://example.test/api/v1/simulation/wallet/device_revision_12345678?platform=okx";
  const save = (autoTimeframe, revision) => worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, autoTimeframe, revision }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });

  const created = await save("4h", 0);
  assert.equal((await created.json()).revision, 0);
  const updated = await save("1h", 0);
  assert.equal((await updated.json()).revision, 1);
  const stale = await save("1d", 0);
  assert.equal(stale.status, 409);
  const reloaded = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await reloaded.json()).autoTimeframe, "1h");
});

test("server validates manual simulation execution and exposes audit events", async () => {
  const DB = createSimulationDatabase();
  const url = "https://example.test/api/v1/simulation/wallet/device_execute_12345678?platform=hyperliquid";
  const created = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, autoTimeframe: "1h", revision: 0 }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(created.status, 200);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    const target = new URL(request.url);
    if (target.pathname.endsWith("/ai/opportunities")) {
      return Response.json({ opportunities: [executableAnalysis({ plan_id: "verified-plan" })] });
    }
    return Response.json({});
  };
  try {
    const executed = await worker.fetch(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        action: "execute",
        plan_id: "verified-plan",
        symbol: "BTC",
        timeframe: "1h",
        revision: 0,
        analysis: executableAnalysis({ direction: "SHORT" }),
      }),
    }), { DB, OWNER_API_TOKEN: OWNER_TOKEN, BACKEND_API_URL: "https://backend.example.test" }, {});
    const wallet = await executed.json();
    assert.equal(executed.status, 200);
    assert.equal(wallet.activeTrades.length, 1);
    assert.equal(wallet.activeTrades[0].analysis.direction, "LONG", "客户端伪造的决策内容必须被忽略");

    const events = await worker.fetch(new Request(
      "https://example.test/api/v1/simulation/wallet/device_execute_12345678/events?platform=hyperliquid&limit=20",
      { headers: authHeaders },
    ), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
    const eventPayload = await events.json();
    assert.equal(eventPayload.items.length, 1);
    assert.equal(eventPayload.items[0].event_type, "opened");
    assert.equal(eventPayload.items[0].payload.trade.analysis.direction, "LONG");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled simulation closes positions and persists heartbeat and audit events", async () => {
  const DB = createSimulationDatabase();
  const now = Date.now();
  const trade = openServerSimulatedTrade(executableAnalysis(), "4h", 1_000, now - 2 * 60 * 60 * 1_000);
  const walletUrl = "https://example.test/api/v1/simulation/wallet/device_cron_12345678?platform=hyperliquid";
  const saved = await worker.fetch(new Request(walletUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, balance: 1_000, activeTrades: [trade], history: [] }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(saved.status, 200);
  const secondWalletUrl = "https://example.test/api/v1/simulation/wallet/device_cron_87654321?platform=hyperliquid";
  const secondSaved = await worker.fetch(new Request(secondWalletUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ enabled: true, balance: 1_000, activeTrades: [trade], history: [] }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal(secondSaved.status, 200);
  for (const record of DB.simulationWallets.values()) record.active_trade = JSON.stringify([trade]);

  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const upstreamUrls = [];
  globalThis.fetch = async (request) => {
    upstreamCalls += 1;
    const url = new URL(request.url);
    upstreamUrls.push(url.toString());
    if (url.pathname.endsWith("/candles")) {
      const start = trade.lastProcessedCandleCloseTime;
      return Response.json(Array.from({ length: 119 }, (_, index) => ({
        open_time: start + index * 60_000,
        close_time: start + (index + 1) * 60_000,
        open: 100,
        high: index === 118 ? 111 : 101,
        low: 99,
        close: index === 118 ? 110 : 100,
        volume: 10,
      })));
    }
    if (url.pathname.endsWith("/ai/opportunities")) {
      return Response.json({ opportunities: [] });
    }
    return Response.json({ price: 110 });
  };
  try {
    const env = {
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
      BACKEND_API_URL: "https://backend.example.test",
    };
    await Promise.all([worker.scheduled({}, env, {}), worker.scheduled({}, env, {})]);
    const response = await worker.fetch(new Request(walletUrl, { headers: authHeaders }), env);
    const wallet = await response.json();
    assert.equal(wallet.activeTrades.length, 0);
    assert.equal(wallet.history.length, 1);
    assert.equal(wallet.history[0].exit_reason, "take_profit");
    assert.ok(wallet.balance > 1_000);
    assert.equal(wallet.executor.healthy, true);
    assert.equal(wallet.executor.last_error, null);
    const secondResponse = await worker.fetch(new Request(secondWalletUrl, { headers: authHeaders }), env);
    assert.equal((await secondResponse.json()).history.length, 1);
    assert.equal(DB.simulationEvents.size, 2);
    assert.equal([...DB.simulationEvents.values()][0].event_type, "closed");
    assert.equal(upstreamCalls, 3, "同一轮相同行情应跨设备复用，重叠定时任务不得重复执行");
    assert.ok(upstreamUrls.some((url) => url.includes("interval=1m&limit=180")), "中断后应扩大 K 线回放窗口");
    assert.ok(upstreamUrls.some((url) => url.includes("/ai/opportunities") && url.includes("limit=20")), "后台应扫描足够候选以填补去重后的空位");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Durable Object scheduler starts once and always renews its alarm", async () => {
  let alarm = null;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (value) => { alarm = value; },
  };
  const state = { storage, waitUntil: () => undefined };
  const scheduler = new SimulationScheduler(state, {});

  assert.equal((await scheduler.fetch()).status, 204);
  const firstAlarm = alarm;
  assert.ok(firstAlarm > Date.now());
  await scheduler.fetch();
  assert.equal(alarm, firstAlarm);

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await scheduler.alarm();
  } finally {
    console.error = originalError;
  }
  assert.ok(alarm >= firstAlarm);
});

test("app entry starts the backup scheduler without delaying the response", async () => {
  const pending = [];
  let starts = 0;
  const response = await worker.fetch(new Request("https://example.test/app"), {
    ASSETS: { fetch: async () => new Response("app", { headers: { "content-type": "text/html" } }) },
    SIMULATION_SCHEDULER: {
      getByName: (name) => {
        assert.equal(name, "simulation-executor");
        return { fetch: async () => { starts += 1; } };
      },
    },
  }, {
    waitUntil: (promise) => pending.push(promise),
  });

  assert.equal(response.status, 200);
  await Promise.all(pending);
  assert.equal(starts, 1);
});

test("deduplicates simulation history and proxies only anonymous decision policy", async () => {
  const DB = createSimulationDatabase();
  const history = Array.from({ length: 12 }, (_, index) => ({
    id: -(index + 1),
    symbol: "BTC",
    direction: "LONG",
    started_at: `2026-09-14T00:${String(index).padStart(2, "0")}:00.000Z`,
    closed_at: `2026-09-14T01:${String(index).padStart(2, "0")}:00.000Z`,
    net_pnl: index < 8 ? 20 : -10,
    timeframe: "4h",
    analysis: { position_sizing: { max_loss_amount: 10 } },
  }));
  const save = (clientId, platform = "hyperliquid") => worker.fetch(new Request(
    `https://example.test/api/v1/simulation/wallet/${clientId}?platform=${platform}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ enabled: true, autoTimeframe: "4h" }),
    },
  ), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await save("device_history_12345678")).status, 200);
  assert.equal((await save("device_history_87654321")).status, 200);
  const otherTimeframeHistory = history.map((trade, index) => ({
    ...trade,
    id: -(index + 101),
    timeframe: "1h",
    net_pnl: -20,
  }));
  assert.equal((await save("device_history_1h")).status, 200);
  const improvingHistory = history.map((trade, index) => ({
    ...trade,
    symbol: "ETH",
    net_pnl: index >= 4 ? 20 : -10,
  }));
  assert.equal((await save("device_history_binance", "binance")).status, 200);
  const ownerId = DB.simulationWallets.keys().next().value.split(":")[0];
  const addEvents = (clientId, records, platform = "hyperliquid") => {
    for (const trade of records) {
      const eventId = `${ownerId}:${clientId}:${platform}:${trade.id}:closed:${trade.closed_at}`;
      DB.simulationEvents.set(eventId, {
        event_id: eventId,
        owner_id: ownerId,
        client_id: clientId,
        platform,
        trade_id: String(trade.id),
        event_type: "closed",
        occurred_at: trade.closed_at,
        payload_json: JSON.stringify({ trade }),
      });
    }
  };
  addEvents("device_history_12345678", history);
  addEvents("device_history_87654321", [history[0]]);
  addEvents("device_history_1h", otherTimeframeHistory);
  addEvents("device_history_binance", improvingHistory, "binance");

  const originalFetch = globalThis.fetch;
  let policyHeader = "";
  let proxiedBody = "";
  globalThis.fetch = async (input, init) => {
    const upstream = new Request(input, init);
    policyHeader = upstream.headers.get("x-alpha-history-policy") || "";
    proxiedBody = await upstream.clone().text();
    return Response.json({ proxied: true });
  };
  try {
    const response = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    });
    assert.equal(response.status, 200);
    const policies = JSON.parse(policyHeader).platforms;
    const policy = policies.hyperliquid;
    assert.equal(policy.timeframe, "4h");
    assert.equal(policy.sample_count, 12, "跨设备重复交易只能计入一次");
    assert.equal(policy.wins, 8);
    assert.equal(policy.losses, 4);
    assert.equal(policy.consecutive_losses, 4);
    assert.equal(policy.threshold_adjustment, 4);
    assert.equal(policy.risk_multiplier, 0.5);
    assert.equal(policy.direction_performance.LONG.threshold_adjustment, -1);
    assert.equal(policies.binance.consecutive_losses, 0);
    assert.equal(policies.binance.threshold_adjustment, -2);
    assert.equal(policies.binance.risk_multiplier, 1.05);
    assert.equal(policyHeader.includes("BTC"), false, "不得发送币种等原始交易字段");
    assert.equal(policyHeader.includes("started_at"), false);

    const oneHourResponse = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=1h&limit=4",
      { headers: authHeaders },
    ), {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    });
    assert.equal(oneHourResponse.status, 200);
    const oneHourPolicy = JSON.parse(policyHeader).platforms.hyperliquid;
    assert.equal(oneHourPolicy.timeframe, "1h");
    assert.equal(oneHourPolicy.sample_count, 12);
    assert.equal(oneHourPolicy.losses, 12);

    const executionBody = { analysis: { symbol: "BTC" }, timeframe: "1h", total_amount: 1_000 };
    const executionResponse = await worker.fetch(new Request(
      "https://example.test/api/v1/executions",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(executionBody),
      },
    ), {
      BACKEND_API_URL: "https://backend.example.test",
      DB,
      OWNER_API_TOKEN: OWNER_TOKEN,
    });
    assert.equal(executionResponse.status, 200);
    assert.equal(JSON.parse(policyHeader).platforms.hyperliquid.timeframe, "1h");
    assert.deepEqual(JSON.parse(proxiedBody), executionBody, "读取周期不得消耗原始请求体");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("signs authenticated backend requests without exposing the signing key", async () => {
  const originalFetch = globalThis.fetch;
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64");
  globalThis.fetch = async (input) => {
    assert.ok(input.headers.get("x-alpha-worker-timestamp"));
    assert.ok(input.headers.get("x-alpha-worker-signature"));
    assert.deepEqual(await input.json(), { symbol: "BTC", timeframe: "4h" });
    return Response.json({ proxied: true });
  };

  try {
    const response = await worker.fetch(new Request("https://example.test/api/v1/ai/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ symbol: "BTC", timeframe: "4h" }),
    }), {
      BACKEND_API_URL: "https://backend.example.test",
      BACKEND_SIGNING_PRIVATE_KEY: privateKey,
      DB: createSimulationDatabase(),
      OWNER_API_TOKEN: OWNER_TOKEN,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { proxied: true });
  } finally {
    globalThis.fetch = originalFetch;
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
    assert.ok(payload.opportunities.every((item) => item.direction === "WAIT"));
    assert.ok(payload.opportunities.every((item) => item.position_sizing.margin_amount === 0));
    assert.ok(payload.opportunities.every((item) => item.status_reason.includes("均线方向不明确")));

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
    assert.equal(firstPlan.position_sizing.margin_amount, 0);
    assert.equal(updatedPlan.position_sizing.margin_amount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("preserves a POST body when analysis falls back after backend authentication fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async (input, init) => {
    if (input instanceof Request && new URL(input.url).hostname === "backend.example.test") {
      assert.deepEqual(await input.json(), { symbol: "BTC", timeframe: "4h" });
      return Response.json({ detail: "访问令牌无效" }, { status: 401 });
    }
    const payload = JSON.parse(init.body);
    if (payload.type === "metaAndAssetCtxs") {
      return Response.json([
        { universe: [{ name: "BTC" }] },
        [{ markPx: "100", prevDayPx: "98", dayNtlVlm: "1000000", funding: "0.0001", openInterest: "50000" }],
      ]);
    }
    return Response.json([{ t: 1, T: 2, o: "99", h: "101", l: "98", c: "100", v: "42" }]);
  };
  console.error = () => undefined;

  try {
    const response = await worker.fetch(new Request("https://example.test/api/v1/ai/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ symbol: "BTC", timeframe: "4h" }),
    }), {
      BACKEND_API_URL: "https://backend.example.test",
      DB: createSimulationDatabase(),
      OWNER_API_TOKEN: OWNER_TOKEN,
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).analysis_engine, "rules");
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
    assert.ok(edgePayload.opportunities.every((item) => item.direction === "WAIT"));
    assert.ok(edgePayload.opportunities.every((item) => item.position_sizing.margin_amount === 0));
    assert.ok(edgePayload.opportunities.every((item) => item.status_reason.includes("均线方向不明确")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("calculates complete edge gates and safely revises a missed entry without the Python backend", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const candles = Array.from({ length: 205 }, (_, index) => {
    const close = 80 + index * 0.1 + Math.sin(index) * 0.5;
    return {
      t: now - (205 - index) * 14_400_000,
      T: now - (204 - index) * 14_400_000 - 1,
      o: String(close - 0.05),
      h: String(close + 1),
      l: String(close - 1),
      c: String(close),
      v: "1000",
    };
  });
  const lastPrice = candles.at(-1).c;
  let marketScanCount = 0;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.type === "metaAndAssetCtxs") {
      const currentPrice = Number(lastPrice) + (marketScanCount > 0 ? 0.3 : 0);
      marketScanCount += 1;
      return Response.json([
        { universe: CORE_TEST_SYMBOLS.map((name) => ({ name })) },
        CORE_TEST_SYMBOLS.map(() => ({
          markPx: String(currentPrice),
          prevDayPx: String(currentPrice - 4),
          dayNtlVlm: "1000000",
          funding: "0.0001",
          openInterest: "10000",
        })),
      ]);
    }
    return Response.json(candles);
  };
  try {
    const DB = createSimulationDatabase();
    const env = { DB, OWNER_API_TOKEN: OWNER_TOKEN };
    const scan = () => worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), env, {});
    const response = await scan();
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.scan_source, "edge_live_scan");
    assert.equal(payload.opportunities.length, 4);
    assert.ok(payload.opportunities.every((item) => Number.isFinite(item.indicators.ema200)));
    assert.ok(payload.opportunities.every((item) => !item.status_reason.includes("数据不足")));
    assert.ok(payload.opportunities.every((item) => item.direction === "LONG"));
    assert.ok(payload.opportunities.every((item) => item.decision_revision === 1));

    const confirmingMiss = await (await scan()).json();
    assert.ok(
      confirmingMiss.opportunities.every((item) => item.decision_status === "missed_entry"),
      JSON.stringify(confirmingMiss.opportunities.map((item) => ({
        symbol: item.symbol, status: item.decision_status, reason: item.status_reason,
      }))),
    );
    assert.ok(confirmingMiss.opportunities.every((item) => item.missed_entry_count === 1));

    const revised = await (await scan()).json();
    assert.ok(revised.opportunities.every((item) => item.decision_revision === 2));
    assert.ok(revised.opportunities.every((item) => item.revision_history.length === 1));
    assert.ok(revised.opportunities.every((item, index) => (
      item.plan_id === payload.opportunities[index].plan_id
    )));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads Binance public market data directly when the full backend is absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/ticker/24hr")) {
      return Response.json({ lastPrice: "100", priceChangePercent: "2", quoteVolume: "1000000" });
    }
    if (target.pathname.endsWith("/premiumIndex")) return Response.json({ lastFundingRate: "0.0001" });
    if (target.pathname.endsWith("/openInterest")) return Response.json({ openInterest: "10000" });
    throw new Error(`未处理的测试地址：${target}`);
  };
  try {
    const response = await worker.fetch(new Request(
      "https://example.test/api/v1/market/BTC?platform=binance",
    ), {}, {});
    const market = await response.json();
    assert.equal(response.status, 200);
    assert.equal(market.platform, "binance");
    assert.equal(market.source, "live");
    assert.equal(market.price, 100);
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
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(config.main, "./mobile-app/worker/app.js");
  assert.equal(config.assets.directory, "./mobile-app/dist/client");
  assert.equal(config.d1_databases[0].migrations_dir, "./mobile-app/migrations");
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.deepEqual(config.secrets.required, [
    "OWNER_API_TOKEN",
    "DEVICE_SESSION_SECRET",
    "BACKEND_SIGNING_PRIVATE_KEY",
  ]);
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "SIMULATION_SCHEDULER", class_name: "SimulationScheduler" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["SimulationScheduler"] },
  ]);
  assert.match(packageJson.scripts["migrate:cloudflare"], /d1 migrations apply alpha-trader-ai-db --remote/);
  assert.match(
    packageJson.scripts["deploy:cloudflare"],
    /build:cloudflare && npm run migrate:cloudflare && npx wrangler[^&]+ deploy/,
  );
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
