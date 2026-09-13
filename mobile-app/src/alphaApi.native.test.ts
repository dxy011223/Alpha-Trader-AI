import { beforeEach, describe, expect, it, vi } from "vitest";

const ownerToken = vi.hoisted(() => ({
  getToken: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ownerToken,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  ownerToken.setToken.mockResolvedValue(undefined);
  ownerToken.clearToken.mockResolvedValue(undefined);
});

describe("Android 安全设备会话", () => {
  it("账号密码登录后只保存设备会话", async () => {
    const sessionToken = "ats1.valid.nonce.signature";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authorized: true,
      token: sessionToken,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { loginWithPassword } = await import("./alphaApi");

    await expect(loginWithPassword("owner", "correct-password")).resolves.toBe(sessionToken);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/password\/login$/), expect.objectContaining({
      credentials: "omit",
      body: JSON.stringify({ username: "owner", password: "correct-password", transport: "bearer" }),
    }));
    expect(ownerToken.setToken).toHaveBeenCalledWith({ token: sessionToken });
  });

  it("首次设置不发送主令牌且只保存设备会话", async () => {
    const sessionToken = "ats1.valid.nonce.signature";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authorized: true,
      token: sessionToken,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { setupPassword } = await import("./alphaApi");

    await setupPassword("owner", "correct-password");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/password\/setup$/), expect.objectContaining({
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }));
    expect(ownerToken.setToken).toHaveBeenCalledWith({ token: sessionToken });
  });

  it("启动时验证并清除已失效的设备会话", async () => {
    ownerToken.getToken.mockResolvedValue({ token: "ats1.expired.nonce.signature" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "访问令牌无效" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadApiAccessToken } = await import("./alphaApi");

    await expect(loadApiAccessToken()).resolves.toBe("");
    expect(ownerToken.clearToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/session$/), expect.objectContaining({
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: "Bearer ats1.expired.nonce.signature" }),
    }));
  });

  it("启动时续签并保存通过服务端验证的设备会话", async () => {
    const sessionToken = "ats1.valid.nonce.signature";
    const refreshedToken = "ats1.refreshed.nonce.signature";
    ownerToken.getToken.mockResolvedValue({ token: sessionToken });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authorized: true, token: refreshedToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const { loadApiAccessToken } = await import("./alphaApi");

    await expect(loadApiAccessToken()).resolves.toBe(refreshedToken);
    expect(ownerToken.setToken).toHaveBeenCalledWith({ token: refreshedToken });
    expect(ownerToken.clearToken).not.toHaveBeenCalled();
  });

  it("受保护请求返回 401 时清除会话并提示重新授权", async () => {
    const sessionToken = "ats1.valid.nonce.signature";
    ownerToken.getToken.mockResolvedValue({ token: sessionToken });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorized: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "访问令牌无效" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })));
    const { loadCapitalSettings } = await import("./alphaApi");

    await expect(loadCapitalSettings()).rejects.toThrow("登录已过期，请重新登录");
    expect(ownerToken.clearToken).toHaveBeenCalledOnce();
  });
});
