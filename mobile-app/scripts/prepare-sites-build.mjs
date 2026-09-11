#!/usr/bin/env node
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const workerApp = path.join(root, "worker", "app.js");
const hosting = path.join(root, ".openai", "hosting.json");
const drizzle = path.join(root, "drizzle");

for (const file of [index, worker, workerApp, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "base.js"));
const appSource = readFileSync(workerApp, "utf8").replace(
  'from "./index.js"',
  'from "./base.js"',
);
writeFileSync(path.join(dist, "server", "index.js"), appSource);
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));
if (existsSync(drizzle)) {
  cpSync(drizzle, path.join(dist, ".openai", "drizzle"), { recursive: true });
}

console.log("Prepared Sites build: unified Worker entry and Sites metadata");
