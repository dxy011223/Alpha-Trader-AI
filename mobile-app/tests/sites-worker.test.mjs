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
  let writes = 0;
  return {
    get writes() { return writes; },
    prepare(sql) {
      let params = [];
      return {
        bind(...values) {
          params = values;
          return this;
        },
        async run() {
          writes += 1;
          if (sql.includes("owner_capital_settings")) {
            capital.set(params[0], { total_amount: params[1], currency: "USDT", updated_at: params[2] });
          } else if (sql.includes("owner_simulation_wallets")) {
            const key = `${params[0]}:${params[1]}:${params[2]}`;
            wallets.set(key, { enabled: params[3], balance: params[4], active_trade: params[5], history: params[6], updated_at: params[7] });
          }
          return { success: true };
        },
        async first() {
          if (sql.includes("owner_capital_settings")) return capital.get(params[0]) ?? null;
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

  const saved = await worker.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ total_amount: 25_000 }),
  }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await saved.json()).total_amount, 25_000);

  const reloaded = await worker.fetch(new Request(url, { headers: authHeaders }), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
  assert.equal((await reloaded.json()).total_amount, 25_000);
});

test("refuses to proxy secrets to an insecure backend", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/v1/executions/active", { headers: authHeaders }),
    { BACKEND_API_URL: "http://backend.example.test", OWNER_API_TOKEN: OWNER_TOKEN },
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).detail, /HTTPS/);
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

function createAiBinding() {
  return {
    async run(_model, options) {
      const context = JSON.parse(options.messages[1].content);
      return {
        response: {
          decisions: context.markets.map((market) => ({
            symbol: market.symbol,
            direction: "WAIT",
            confidence: 64,
            score: 64,
            trend: 18,
            structure: 16,
            capital: 14,
            macro: 9,
            news: 7,
            entry_range: [market.price, market.price],
            stop_loss: market.price,
            take_profit: [market.price, market.price],
            leverage: 1,
            risk: "low",
            position_sizing: {
              risk_budget_rate: 0,
              risk_budget_amount: 0,
              stop_distance_rate: 0,
              margin_amount: 0,
              position_value: 0,
              max_loss_amount: 0,
              margin_cap_rate: 0.3,
              capped: false,
            },
            reasons: ["市场结构暂不支持入场", "等待新的量价确认"],
          })),
        },
      };
    },
  };
}

test("serves public market data and uses Cloudflare AI for decisions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
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
    ), { AI: createAiBinding(), DB, OWNER_API_TOKEN: OWNER_TOKEN });
    assert.equal(opportunities.status, 200);
    const payload = await opportunities.json();
    assert.equal(payload.opportunities.length, 4);
    assert.ok(payload.opportunities.every((item) => item.analysis_engine === "openai"));
    assert.ok(payload.opportunities.every((item) => item.decision_schema_version === "ai_full_v1"));

    const unavailable = await worker.fetch(new Request(
      "https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4",
      { headers: authHeaders },
    ), { DB, OWNER_API_TOKEN: OWNER_TOKEN });
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).detail, /AI 决策暂时不可用/);
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
  assert.equal(config.ai.binding, "AI");
  assert.deepEqual(config.secrets.required, ["OWNER_API_TOKEN"]);
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
  assert.match(downloadPage, /href="\/downloads\/alpha-trader-ai\.apk\?v=1\.4\.2"/);
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
