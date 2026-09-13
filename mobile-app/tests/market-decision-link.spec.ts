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
    strategy_version: "v2",
    strategy_parameters: {
      min_trade_score: 72,
      trend_weight: 27,
      structure_weight: 25,
      capital_weight: 23,
      macro_weight: 15,
      news_weight: 10,
    },
    reference_price: 101,
    current_price: 99.5,
    generated_at: "2026-09-13T00:00:00Z",
    decision_status: "executable",
    is_executable: true,
    status_reason: "价格进入原入场区间，信号仍然有效。",
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("alpha-e2e-skip-owner-token") !== "1") {
      window.sessionStorage.setItem("alpha-owner-api-token", "test-owner-token");
    }
    (window as Window & { ethereum?: { request: (payload: { method: string }) => Promise<string[]> } }).ethereum = {
      request: async ({ method }) => {
        if (method !== "eth_requestAccounts") throw new Error("不支持的钱包请求");
        return ["0x1111111111111111111111111111111111111111"];
      },
    };
  });
  type SimulationState = { enabled: boolean; balance: number; activeTrades: object[]; activeTrade?: object | null; history: object[] };
  const simulationStates = new Map<string, SimulationState>();
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.includes("/simulation/wallet/")) {
      const platform = url.searchParams.get("platform") ?? "hyperliquid";
      if (request.method() === "PUT") simulationStates.set(platform, request.postDataJSON() as SimulationState);
      const simulationState = simulationStates.get(platform)
        ?? { enabled: false, balance: 1_000, activeTrades: [], activeTrade: null, history: [] };
      await route.fulfill({ json: {
        ...simulationState,
        client_id: url.pathname.split("/").at(-1),
        platform,
        updated_at: "2026-09-11T00:00:00Z",
      } });
      return;
    }

    if (url.pathname.endsWith("/auth/device")) {
      await route.fulfill({ json: { authorized: true, expires_at: "2027-09-13T00:00:00Z" } });
      return;
    }
    if (url.pathname.endsWith("/auth/session")) {
      await route.fulfill({ status: 401, json: { detail: "访问令牌缺失" } });
      return;
    }
    if (url.pathname.endsWith("/auth/password/status")) {
      await route.fulfill({ json: { setup_required: true } });
      return;
    }
    if (url.pathname.endsWith("/auth/logout")) {
      await route.fulfill({ json: { authorized: false } });
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
    if (url.pathname.endsWith("/trades/completed")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname.endsWith("/reviews")) {
      const platform = url.searchParams.get("platform") ?? "hyperliquid";
      await route.fulfill({ json: [{
        id: 91,
        trade_id: null,
        review_type: "daily",
        review_date: "2026-09-12",
        result: "loss",
        summary: `${platform} 每日真实交易复盘`,
        findings: ["近期突破策略表现下降。"],
        adjustments: ["策略优化：已生成 v2，仅影响后续分析，不会自动下单。"],
        metrics: {
          platform,
          total: 5,
          wins: 2,
          win_rate: 40,
          net_pnl: -25,
          strategy_optimization: {
            status: "updated",
            version_before: "v1",
            version_after: "v2",
            sample_total: 20,
            sample_limit: 100,
            win_rate: 40,
            net_pnl: -25,
            changes: ["可交易阈值 70→72"],
          },
        },
        created_at: "2026-09-13T00:10:00Z",
      }] });
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
      price: 100,
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

test("机会扫描失败会显示原因并可手动重试", async ({ page }) => {
  await page.route("**/api/v1/ai/opportunities**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "服务端尚未配置访问令牌" }),
    });
  }, { times: 1 });

  await page.locator(".bottom-nav button").nth(1).click();
  await expect(page.getByRole("alert")).toContainText("服务端尚未配置访问令牌");

  await page.getByRole("button", { name: "重新扫描" }).click();
  await expect(page.getByRole("tab", { name: /ETH/ })).toBeVisible();
});

test("决策页展示固定参考价、当前复核价和可执行状态", async ({ page }) => {
  await page.locator(".bottom-nav button").nth(1).click();

  await expect(page.getByText("决策参考价")).toBeVisible();
  await expect(page.getByText("当前复核价")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始执行/ })).toBeEnabled();
  await expect(page.getByText("价格进入原入场区间，信号仍然有效。")).toBeVisible();
});

test("缺少访问令牌时显示账号密码登录且不发送 AI 扫描请求", async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.setItem("alpha-e2e-skip-owner-token", "1");
    window.sessionStorage.removeItem("alpha-owner-api-token");
  });
  await page.reload();
  let aiRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/ai/opportunities")) aiRequests += 1;
  });

  await expect(page.getByRole("heading", { name: "登录 Alpha Trader AI" })).toBeVisible();
  await expect(page.getByLabel("登录账号")).toBeVisible();
  await expect(page.getByLabel("登录密码")).toBeVisible();
  await expect(page.getByText("首次使用时创建账号密码")).toBeVisible();
  await expect(page.getByLabel("首次设置所有者访问令牌")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设置并登录" })).toBeDisabled();
  await expect(page.locator(".bottom-nav")).toHaveCount(0);
  expect(aiRequests).toBe(0);
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

test("复盘页展示每日策略优化版本和样本指标", async ({ page }) => {
  await page.getByLabel("主导航").getByRole("button", { name: "复盘", exact: true }).click();

  const dailyReview = page.getByLabel("2026-09-12 每日策略复盘");
  await expect(dailyReview).toBeVisible();
  await expect(dailyReview).toContainText("策略版本 v1 → v2");
  await expect(dailyReview).toContainText("20");
  await expect(dailyReview).toContainText("40.0%");
  await expect(dailyReview).toContainText("不会自动下单");
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

test("K 线失败时仍按成功的行情快照显示后端已连接", async ({ page }) => {
  await page.route("**/api/v1/market/BTC/candles**", async (route) => {
    await route.fulfill({ status: 504, json: { detail: "测试 K 线超时" } });
  });
  await page.reload();

  await expect(page.locator(".source-status")).toContainText("实时数据");
  await expect(page.locator(".source-status")).not.toContainText("后端未连接");
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
  await expect(page.getByRole("tab").filter({ hasText: "ETH" })).toContainText("执行中 · 快照已锁定");
  await page.getByLabel("主导航").getByRole("button", { name: "持仓", exact: true }).click();

  await expect(page.getByText("自动模拟中")).toBeVisible();
  await expect(page.getByText("模拟入场价")).toBeVisible();
  await expect(page.getByRole("button", { name: "连接钱包", exact: true })).toHaveCount(0);
  expect(requestedUrls.some((raw) => /\/settings\/wallet$|\/wallet\/0x|\/trades\/completed|\/reviews|\/executions\/active/.test(new URL(raw).pathname))).toBe(false);
});

test("最多可同时执行三个决策，且只锁定对应币种", async ({ page }) => {
  const savedStates: Array<{ activeTrades?: Array<{ allocatedAmount: number }> }> = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/simulation/wallet/")) {
      savedStates.push(request.postDataJSON() as { activeTrades?: Array<{ allocatedAmount: number }> });
    }
  });
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await page.getByRole("switch", { name: "已关闭" }).click();
  await page.keyboard.press("Escape");

  await page.getByLabel("主导航").getByRole("button", { name: "决策", exact: true }).click();
  const ethDecision = page.getByRole("tab").filter({ hasText: "ETH" });
  const solDecision = page.getByRole("tab").filter({ hasText: "SOL" });
  const dogeDecision = page.getByRole("tab").filter({ hasText: "DOGE" });
  await expect(ethDecision).toContainText("执行中 · 快照已锁定");
  await expect(solDecision).toContainText("执行中 · 快照已锁定");
  await expect(dogeDecision).toContainText("执行中 · 快照已锁定");
  await expect.poll(() => savedStates.some((state) => state.activeTrades?.length === 3)).toBe(true);
  const threeTradeState = [...savedStates].reverse().find((state) => state.activeTrades?.length === 3);
  expect(threeTradeState?.activeTrades?.reduce((sum, trade) => sum + trade.allocatedAmount, 0)).toBe(1_500);

  const hypeDecision = page.getByRole("tab").filter({ hasText: "HYPE" });
  await hypeDecision.click();
  await expect(page.getByRole("button", { name: "已达 3 个执行上限" })).toBeDisabled();
  await expect(page.getByText("已达到最多 3 个同时执行的上限，请先结束一个决策")).toBeVisible();

  await page.getByLabel("主导航").getByRole("button", { name: "持仓", exact: true }).click();
  await expect(page.getByText("3 个执行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "执行中持仓" }).getByRole("tab")).toHaveCount(3);

  await page.getByLabel("主导航").getByRole("button", { name: "决策", exact: true }).click();
  await ethDecision.click();
  await expect(page.getByText("ETH-PERP", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "4h", exact: true })).toBeDisabled();
});

test("切换平台时模拟余额与持仓互不串用", async ({ page }) => {
  await page.getByRole("button", { name: "行情平台设置" }).click();
  await page.getByRole("switch", { name: "已关闭" }).click();
  await page.keyboard.press("Escape");

  await page.getByLabel("主导航").getByRole("button", { name: "决策", exact: true }).click();
  await expect(page.getByRole("tab").filter({ hasText: "ETH" })).toContainText("执行中 · 快照已锁定");
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
