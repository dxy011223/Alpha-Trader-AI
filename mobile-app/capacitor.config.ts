import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "top.lngzunoma.alphatraderai",
  appName: "Alpha Trader AI",
  webDir: "dist/client",
  server: {
    androidScheme: "https",
  },
  plugins: {
    // APK 使用原生网络栈请求线上接口，避免 WebView 跨域拦截。
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
