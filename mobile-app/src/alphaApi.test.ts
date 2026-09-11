import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAnalysis, loadCandles, loadCapitalSettings, loadMarket, loadNews, loadOpportunities, saveCapitalSettings } from "./alphaApi";

const apiBase = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/$/, "");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Alpha Trader API 适配器", () => {
  it("使用同源地址读取市场快照", async () => {
    const payload = {
      symbol: "BTC",
      price: 100,
      change_24h: 1.2,
      volume: 20,
      volatility: 2,
      funding_rate: 0.01,
      open_interest: 30,
      source: "live",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMarket("BTC")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/market/BTC`, expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
  });

  it("为移动端周期拼接 K 线参数", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await loadCandles("ETH", "5m", 80);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/market/ETH/candles?interval=5m&limit=80`,
      expect.any(Object),
    );
  });

  it("按日期读取全部新闻归档", async () => {
    const archive = { date: "2026-09-11", total: 0, items: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(archive), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadNews("2026-09-11")).resolves.toEqual(archive);
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/news?date=2026-09-11`, expect.any(Object));
  });

  it("提交当前币种和周期生成 AI 分析", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await loadAnalysis("HYPE", "4h");
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/ai/analyze`, expect.objectContaining({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbol: "HYPE", timeframe: "4h" }),
    }));
  });

  it("按周期扫描全部交易机会", async () => {
    const scan = { scanned_markets: 230, eligible_markets: 180, updated_at: "2026-09-11T00:00:00Z", opportunities: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(scan), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadOpportunities("1h")).resolves.toEqual(scan);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/ai/opportunities?timeframe=1h&limit=8`,
      expect.any(Object),
    );
  });

  it("读取并持久化总资金设置", async () => {
    const settings = { total_amount: 25_800, currency: "USDT", updated_at: "2026-09-11T00:00:00Z" };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(settings), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadCapitalSettings()).resolves.toEqual(settings);
    await expect(saveCapitalSettings(25_800)).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${apiBase}/settings/capital`, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${apiBase}/settings/capital`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ total_amount: 25_800, currency: "USDT" }),
    }));
  });

  it("接口异常时抛出可识别错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    await expect(loadMarket("SOL")).rejects.toThrow("行情接口请求失败：503");
  });
});
