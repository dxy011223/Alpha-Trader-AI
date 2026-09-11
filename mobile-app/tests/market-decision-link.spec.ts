import { expect, test } from "@playwright/test";

function analysis(symbol: string, platform = "hyperliquid") {
  return {
    symbol,
    instrument: `${symbol}-PERP`,
    direction: "LONG",
    confidence: 82,
    score: 80,
    score_breakdown: { trend: 24, structure: 20, capital: 16, macro: 12, news: 8 },
    entry_range: [99, 100],
    stop_loss: 95,
    take_profit: [108, 115],
    leverage: 3,
    risk: "medium",
    position_sizing: {
      risk_budget_rate: 0.0075,
      risk_budget_amount: 75,
      stop_distance_rate: 0.05,
      margin_amount: 500,
      position_value: 1500,
      max_loss_amount: 75,
      margin_cap_rate: 0.3,
      capped: false,
    },
    reasons: ["趋势保持向上。"],
    disclaimer: "仅供研究",
    source: "live",
    platform,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { ethereum?: { request: (payload: { method: string }) => Promise<string[]> } }).ethereum = {
      request: async ({ method }) => {
        if (method !== "eth_requestAccounts") throw new Error("不支持的钱包请求");
        return ["0x1111111111111111111111111111111111111111"];
      },
    };
  });
  type SimulationState = { enabled: boolean; balance: number; activeTrade: object | null; history: object[] };
  const simulationStates = new Map<string, SimulationState>();
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.includes("/simulation/wallet/")) {
      const platform = url.searchParams.get("platform") ?? "hyperliquid";
      if (request.method() === "PUT") simulationStates.set(platform, request.postDataJSON() as SimulationState);
      const simulationState = simulationStates.get(platform)
        ?? { enabled: false, balance: 1_000, activeTrade: null, history: [] };
      await route.fulfill({ json: {
        ...simulationState,
        client_id: url.pathname.split("/").at(-1),
        platform,
        updated_at: "2026-09-11T00:00:00Z",
      } });
      return;
    }

    if (url.pathname.endsWith("/settings/capital")) {
      await route.fulfill({ json: { total_amount: 10_000, currency: "USDT", updated_at: "2026-09-11T00:00:00Z" } });
      return;
    }
    if (url.pathname.endsWith("/executions/active")) {
      await route.fulfill({ json: null });
      return;
    }
    if (url.pathname.endsWith("/trades/completed") || url.pathname.endsWith("/reviews")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname.endsWith("/settings/platform/binance")) {
      await route.fulfill({ json: { platform: "binance", configured: false, api_key_hint: null, updated_at: null } });
      return;
    }
    if (url.pathname.endsWith("/news")) {
      await route.fulfill({ json: {
        date: url.searchParams.get("date"),
        total: 0,
        items: [],
        platform: url.searchParams.get("platform"),
      } });
      return;
    }
    if (url.pathname.endsWith("/settings/wallet")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { address: string };
        await route.fulfill({ json: { address: body.address, updated_at: "2026-09-11T00:00:00Z" } });
      } else {
        await route.fulfill({ json: null });
      }
      return;
    }
    if (url.pathname.includes("/wallet/0x")) {
      await route.fulfill({ json: {
        address: url.pathname.split("/").at(-1),
        equity: 1250,
        available_balance: 900,
        unrealized_pnl: 25,
        positions: [],
        history: [],
        source: "live",
        error: null,
      } });
      return;
    }
    if (url.pathname.endsWith("/ai/opportunities")) {
      const platform = url.searchParams.get("platform") ?? "hyperliquid";
      await route.fulfill({ json: {
        scanned_markets: 20,
        eligible_markets: 8,
        updated_at: "2026-09-11T00:00:00Z",
        opportunities: [analysis("ETH", platform), analysis("SOL", platform), analysis("DOGE", platform), analysis("HYPE", platform)],
        platform,
      } });
      return;
    }
    if (url.pathname.endsWith("/ai/analyze")) {
      const body = request.postDataJSON() as { symbol: string; platform?: string };
      await route.fulfill({ json: analysis(body.symbol, body.platform) });
      return;
    }
    if (url.pathname.endsWith("/candles")) {
      await route.fulfill({ json: [] });
      return;
    }
    const symbol = url.pathname.split("/").at(-1) ?? "BTC";
    await route.fulfill({ json: {
      symbol,
      price: symbol === "DOGE" ? 0.24 : 100,
      change_24h: 2,
      volume: 1_000_000,
      volatility: 3,
      funding_rate: 0.001,
      open_interest: 2_000_000,
      source: "live",
      platform: url.searchParams.get("platform") ?? "hyperliquid",
    } });
  });
  await page.goto("/app");
});

test("持仓页可连接浏览器钱包并同步 Hyperliquid 数据", async ({ page }) => {
  await page.getByRole("button", { name: "持仓", exact: true }).click();
  await page.getByRole("button", { name: "连接钱包", exact: true }).click();

  await expect(page.getByText("当前地址 0x111111…111111")).toBeVisible();
  await expect(page.getByText("1,250.00 USDT")).toBeVisible();
  await expect(page.getByText("实时", { exact: true })).toBeVisible();
});

test("平台切换会更新所有页面数据并持久化", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

  const binanceRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/market/BTC") && url.searchParams.get("platform") === "binance";
  });
  await page.getByRole("radio", { name: /Binance 永续/ }).click();
  await binanceRequest;
  await expect(page.getByText(/Binance 永续 · 实时数据/)).toBeVisible();

  const navigation = page.locator(".bottom-nav button");
  await navigation.nth(1).click();
  await expect(page.getByText("Binance 永续 · AI 决策引擎")).toBeVisible();
  await navigation.nth(2).click();
  await expect(page.getByText("Binance 永续 · 新闻雷达")).toBeVisible();
  await navigation.nth(3).click();
  await expect(page.getByLabel("Binance 永续 API Key")).toBeVisible();
  await navigation.nth(4).click();

  await expect.poll(() => requestedUrls.some((raw) => {
    const url = new URL(raw);
    return url.pathname.endsWith("/ai/opportunities") && url.searchParams.get("platform") === "binance";
  })).toBe(true);
  for (const suffix of ["/news", "/trades/completed", "/reviews"]) {
    await expect.poll(() => requestedUrls.some((raw) => {
      const url = new URL(raw);
      return url.pathname.endsWith(suffix) && url.searchParams.get("platform") === "binance";
    })).toBe(true);
  }
  await expect.poll(() => requestedUrls.some((raw) => raw.includes("/settings/platform/binance"))).toBe(true);

  await page.reload();
  await expect(page.getByText(/Binance 永续 · 实时数据/)).toBeVisible();
});

test("市场 K 线支持自由搜索并跟随决策页币种", async ({ page }) => {
  await expect(page.getByRole("button", { name: "自由" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".decision-market-chart-card")).toHaveCount(0);
  await page.getByLabel("搜索币种").fill("doge");
  await page.getByLabel("搜索币种").press("Enter");
  await expect(page.locator("#quote-title")).toContainText("DOGE/USDT");
  await expect(page.getByLabel("DOGE 1h K 线图")).toBeVisible();

  await page.getByRole("button", { name: "决策", exact: true }).last().click();
  await expect(page.getByText("ETH-PERP", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "市场", exact: true }).click();
  await page.getByRole("button", { name: "决策", exact: true }).first().click();

  await expect(page.getByText("跟随决策页", { exact: true })).toBeVisible();
  await expect(page.locator(".decision-market-chart-card")).toHaveCount(4);
  for (const symbol of ["ETH", "SOL", "DOGE", "HYPE"]) {
    await expect(page.getByLabel(`${symbol} 4h K 线图`)).toBeVisible();
  }
});

test("模拟交易不读取真实钱包历史并在决策执行后自动开仓", async ({ page }) => {
  await page.getByRole("button", { name: "行情平台设置" }).click();
  const databaseSave = page.waitForRequest((request) => request.method() === "PUT" && request.url().includes("/simulation/wallet/"));
  await page.getByRole("switch", { name: "已关闭" }).click();
  await expect(page.getByText("1,000.00 USDC")).toBeVisible();
  await databaseSave;

  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await page.reload();
  await page.getByLabel("主导航").getByRole("button", { name: "决策", exact: true }).click();
  await page.getByRole("button", { name: /开始执行 ETH/ }).click();
  await page.getByRole("button", { name: "确认开始执行" }).click();
  await page.getByLabel("主导航").getByRole("button", { name: "持仓", exact: true }).click();

  await expect(page.getByText("自动模拟中")).toBeVisible();
  await expect(page.getByText("模拟入场价")).toBeVisible();
  await expect(page.getByRole("button", { name: "连接钱包", exact: true })).toHaveCount(0);
  expect(requestedUrls.some((raw) => /\/settings\/wallet$|\/wallet\/0x|\/trades\/completed|\/reviews|\/executions\/active/.test(new URL(raw).pathname))).toBe(false);
});

test("切换平台时模拟余额与持仓互不串用", async ({ page }) => {
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await page.getByRole("switch", { name: "已关闭" }).click();
  await page.keyboard.press("Escape");

  await page.getByLabel("主导航").getByRole("button", { name: "决策", exact: true }).click();
  await page.getByRole("button", { name: /开始执行 ETH/ }).click();
  await page.getByRole("button", { name: "确认开始执行" }).click();
  await page.getByLabel("主导航").getByRole("button", { name: "市场", exact: true }).click();

  await page.getByRole("button", { name: "行情平台设置" }).click();
  await page.getByRole("radio", { name: /Binance 永续/ }).click();
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await expect(page.getByRole("switch", { name: "已关闭" })).toBeVisible();
  await expect(page.getByText("1,000.00 USDC")).toBeVisible();

  await page.getByRole("radio", { name: /Hyperliquid/ }).click();
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await expect(page.getByRole("switch", { name: "已开启" })).toBeDisabled();
  await expect(page.getByText(/当前平台有模拟交易执行中/)).toBeVisible();
});
