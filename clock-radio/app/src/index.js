import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config.js";
import { HAClient } from "./ha-client.js";
import { Dashboard } from "./dashboard.js";
import { createServer } from "./server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
let options = {};
try {
  options = JSON.parse(fs.readFileSync(process.env.OPTIONS_FILE ?? "/data/options.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT" || process.env.OPTIONS_FILE) throw error;
}
if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("App options must be a JSON object.");
if (options.read_only !== undefined && typeof options.read_only !== "boolean") throw new Error("read_only must be a boolean.");
const levels = { debug: 0, info: 1, warning: 2, error: 3 };
const level = options.log_level ?? "info";
if (!Object.hasOwn(levels, level)) throw new Error("Invalid log_level.");
const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((name) => [
  name, (message) => {
    if (levels[name === "warn" ? "warning" : name] >= levels[level]) {
      console[name === "debug" ? "log" : name](`[${new Date().toISOString()}] ${name.toUpperCase()} ${message}`);
    }
  },
]));
const port = Number(process.env.PORT ?? 8100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
const token = process.env.SUPERVISOR_TOKEN || undefined;
const ha = new HAClient({
  url: token ? "http://supervisor/core" : process.env.HA_URL,
  token: token ?? process.env.HA_TOKEN,
});
const configStore = new ConfigStore({
  dir: process.env.CONFIG_DIR ?? "/config",
  example: path.join(root, "examples/dashboard.yaml"),
  logger,
});
const dashboard = new Dashboard({ ha, configStore, readOnly: options.read_only === true, demo: process.env.DEMO === "1", version, logger });
const server = createServer({ dashboard, webRoot: path.join(root, "web"), logger });
await dashboard.refresh();
const timer = setInterval(() => dashboard.refresh(), 5000);
server.requestTimeout = 15_000;
server.on("error", (error) => {
  logger.error(`HTTP server failed: ${error.message}`);
  clearInterval(timer);
  process.exitCode = 1;
});
server.listen(port, process.env.HOST ?? "0.0.0.0", () => logger.info(`Clock Radio ${version} listening on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(timer);
    server.close();
    server.closeIdleConnections();
  });
}
