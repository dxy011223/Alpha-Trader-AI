import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("mobile-app", "dist");
const target = resolve("dist");

if (!existsSync(source)) {
  throw new Error("缺少移动端 Sites 构建产物");
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

console.log("已将移动端构建产物同步到仓库根目录 dist。");
