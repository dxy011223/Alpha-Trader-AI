import { expect, test } from "@playwright/test";

function analysis(symbol: string) {
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
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith("/settings/capital")) {
      await route.fulfill({ json: { total_amount: 10_000, currency: "USDT", updated_at: "2026-09-11T00:00:00Z" } });
      return;
    }
    if (url.pathname.endsWith("/ai/opportunities")) {
      await route.fulfill({ json: {
        scanned_markets: 20,
        eligible_markets: 8,
        updated_at: "2026-09-11T00:00:00Z",
        opportunities: [analysis("ETH"), analysis("SOL"), analysis("DOGE"), analysis("HYPE")],
      } });
      return;
    }
    if (url.pathname.endsWith("/ai/analyze")) {
      const body = request.postDataJSON() as { symbol: string };
      await route.fulfill({ json: analysis(body.symbol) });
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
    } });
  });
  await page.goto("/");
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
