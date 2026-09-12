import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelExecution, completePosition, createExecution, loadActiveExecution, loadAnalysis, loadCandles, loadCapitalSettings, loadCompletedTrades, loadMarket, loadNews, loadOpportunities, loadPlatformAccount, loadPlatformCredentialStatus, loadReviews, loadSimulationWallet, loadWallet, loadWalletSettings, saveCapitalSettings, savePlatformCredentials, saveSimulationWallet, saveWalletSettings, setApiAccessToken } from "./alphaApi";

const apiBase = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/$/, "");

afterEach(async () => {
  await setApiAccessToken("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Alpha Trader API 适配器", () => {
  it("拒绝通过远程明文 HTTP 提交交易所凭证", () => {
    vi.stubGlobal("isSecureContext", false);

    expect(() => savePlatformCredentials("binance", {
      apiKey: "key",
      secretKey: "secret",
    })).toThrow(/安全页面/);
  });

  it("把会话访问令牌附加到 API 请求", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await setApiAccessToken("test-owner-token");
    await loadCapitalSettings();

    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/settings/capital`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-owner-token" }),
    }));
  });

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
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/market/BTC?platform=hyperliquid`, expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
  });

  it("按匿名设备 ID 读写模拟交易数据库", async () => {
    const state = { enabled: true, balance: 1_025, activeTrades: [], history: [] };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(state), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await loadSimulationWallet("device_test_12345678", "binance");
    await saveSimulationWallet("device_test_12345678", "binance", state);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${apiBase}/simulation/wallet/device_test_12345678?platform=binance`,
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${apiBase}/simulation/wallet/device_test_12345678?platform=binance`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify(state) }),
    );
  });

  it("为移动端周期拼接 K 线参数", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await loadCandles("ETH", "5m", 80);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/market/ETH/candles?interval=5m&limit=80&platform=hyperliquid`,
      expect.any(Object),
    );
  });

  it("按日期读取全部新闻归档", async () => {
    const archive = { date: "2026-09-11", total: 0, items: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(archive), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadNews("2026-09-11")).resolves.toEqual(archive);
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/news?date=2026-09-11&platform=hyperliquid`, expect.any(Object));
  });

  it("提交当前币种和周期生成 AI 分析", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response("{}", { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await loadAnalysis("HYPE", "4h");
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/ai/analyze`, expect.objectContaining({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbol: "HYPE", timeframe: "4h", platform: "hyperliquid" }),
    }));
  });

  it("按周期扫描全部交易机会", async () => {
    const scan = { scanned_markets: 230, eligible_markets: 180, updated_at: "2026-09-11T00:00:00Z", opportunities: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(scan), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadOpportunities("1h")).resolves.toEqual(scan);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/ai/opportunities?timeframe=1h&limit=8&platform=hyperliquid`,
      expect.any(Object),
    );
  });

  it("持久化并恢复执行中的决策", async () => {
    const analysis = { symbol: "BTC" } as never;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response("{}", { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await loadActiveExecution();
    await createExecution(analysis, "4h", 10_000);
    await cancelExecution(12);

    expect(fetchMock).toHaveBeenNthCalledWith(1, `${apiBase}/executions/active`, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${apiBase}/executions`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ analysis, timeframe: "4h", total_amount: 10_000 }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${apiBase}/executions/12/cancel`, expect.objectContaining({ method: "POST" }));
  });

  it("读取真实钱包并按真实成交完成复盘", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const address = "0x1111111111111111111111111111111111111111";

    await loadWalletSettings();
    await saveWalletSettings(address);
    await loadWallet(address);
    await completePosition(7);
    await loadCompletedTrades();
    await loadReviews();

    expect(fetchMock).toHaveBeenNthCalledWith(2, `${apiBase}/settings/wallet`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ address }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${apiBase}/wallet/${address}`, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(4, `${apiBase}/positions/7/complete`, expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, `${apiBase}/trades/completed?platform=hyperliquid`, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(6, `${apiBase}/reviews?platform=hyperliquid`, expect.any(Object));
  });

  it("保存交易所只读凭证并读取平台账户", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ configured: true, api_key_hint: "abcd…wxyz" }), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await loadPlatformCredentialStatus("binance");
    await savePlatformCredentials("binance", { apiKey: "abcd1234", secretKey: "secret-value" });
    await loadPlatformAccount("binance", "BTC");

    expect(fetchMock).toHaveBeenNthCalledWith(1, `${apiBase}/settings/platform/binance`, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${apiBase}/settings/platform/binance`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ api_key: "abcd1234", secret_key: "secret-value", passphrase: null }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${apiBase}/platforms/binance/account?symbol=BTC`, expect.any(Object));
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

  it("后端长时间无响应时结束连接检查", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const result = expect(loadMarket("BTC")).rejects.toThrow("后端连接超时");
    await vi.advanceTimersByTimeAsync(12_000);
    await result;
  });
});
