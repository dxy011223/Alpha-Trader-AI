#!/usr/bin/env node
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nestedApk = path.join(root, "dist", "client", "downloads", "alpha-trader-ai.apk");

// APK 内无需再携带网页下载包，避免每次构建递归增大。
rmSync(nestedApk, { force: true });
console.log("已排除 Android 安装包中的嵌套 APK。");
