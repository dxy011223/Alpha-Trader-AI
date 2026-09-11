import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

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
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
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

test("serves market and AI APIs without the local Python backend", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
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

    const opportunities = await worker.fetch(new Request("https://example.test/api/v1/ai/opportunities?timeframe=4h&limit=4"), {});
    const scan = await opportunities.json();
    assert.equal(scan.opportunities.length, 4);
    assert.equal(scan.opportunities[0].instrument.endsWith("-PERP"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});
