import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(".env.local");
let source = "";

try {
  source = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (!/^OWNER_API_TOKEN=.+$/m.test(source)) {
  const separator = source && !source.endsWith("\n") ? "\n" : "";
  const token = randomBytes(32).toString("base64url");
  await writeFile(envPath, `${source}${separator}OWNER_API_TOKEN=${token}\n`, "utf8");
}

console.log("Sites 所有者令牌已安全写入 .env.local（不会提交到 Git）。");
