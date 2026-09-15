import { useEffect, useState } from "react";
import "./download.css";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function ProductMark() {
  return (
    <div className="download-product-mark" aria-hidden="true">
      <span>A</span>
      <svg viewBox="0 0 72 28" role="presentation">
        <path d="M2 23 17 15l10 5L43 4l10 10 17-9" />
      </svg>
    </div>
  );
}

export default function DownloadLanding() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [notice, setNotice] = useState("");
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Service Worker 失败不影响 Web 版使用。
      });
    }

    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", capturePrompt);
    return () => window.removeEventListener("beforeinstallprompt", capturePrompt);
  }, []);

  const installApp = async () => {
    if (isStandalone) {
      window.location.assign("/app");
      return;
    }
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setNotice(choice.outcome === "accepted" ? "安装已开始，可在桌面找到 Alpha Trader AI。" : "已取消安装，你仍可直接使用 Web 版。");
      if (choice.outcome === "accepted") setInstallPrompt(null);
      return;
    }
    setNotice(isIos
      ? "请点击浏览器底部的分享按钮，再选择“添加到主屏幕”。"
      : "请打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。");
  };

  return (
    <main className="download-page">
      <div className="download-glow" aria-hidden="true" />
      <section className="download-shell" aria-labelledby="download-title">
        <header className="download-brand">
          <ProductMark />
          <div>
            <strong>Alpha Trader AI</strong>
            <span>市场分析与决策辅助</span>
          </div>
        </header>

        <div className="download-copy">
          <p className="download-eyebrow">Android APK 已发布</p>
          <h1 id="download-title">把市场决策装进口袋</h1>
          <p className="download-summary">实时行情、自由 K 线与四项决策币种，在手机桌面一键打开。</p>
        </div>

        <div className="download-preview" aria-label="应用能力预览">
          <div className="download-chart" aria-hidden="true">
            <span className="candle c1" /><span className="candle c2" /><span className="candle c3" />
            <span className="candle c4" /><span className="candle c5" /><span className="candle c6" />
          </div>
          <div className="download-metric"><span>BTC / USDT</span><strong>实时 K 线</strong></div>
          <div className="download-badges"><span>自由选币</span><span>4 项决策</span><span>模拟交易</span></div>
        </div>

        <div className="download-actions">
          <a className="download-install" href="/downloads/alpha-trader-ai.apk?v=1.4.11" download>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg>
            下载 Android APK
          </a>
          <button type="button" className="download-pwa" onClick={installApp}>
            {isStandalone ? "打开 Alpha Trader AI" : "安装网页版"}
          </button>
          <a className="download-web" href="/app">直接使用 Web 版</a>
        </div>

        {notice && <p className="download-notice" role="status">{notice}</p>}
        <p className="download-footnote">Android 7 及以上 · v1.4.11 已签名发布版 · 支持账号登录与自动续签</p>
      </section>
    </main>
  );
}
