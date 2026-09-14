import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiProxyTarget = env.VITE_DEV_API_PROXY_TARGET?.trim()
    || "https://alpha-trader-ai.lngzunoma.top";

  return {
    build: {
      outDir: "dist/client",
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      proxy: {
        // 登录及业务接口均由 Worker 网关统一处理，本地测试窗保持同源访问。
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    plugins: [react()],
  };
});
