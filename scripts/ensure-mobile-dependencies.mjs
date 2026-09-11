import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const installedMarker = resolve("mobile-app", "node_modules", "vite", "package.json");

if (!existsSync(installedMarker)) {
  console.log("正在安装移动端构建依赖……");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["ci", "--prefix", "mobile-app"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  console.log("移动端依赖已存在，跳过重复安装。");
}
