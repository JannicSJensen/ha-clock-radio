import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config.js";
import { HAClient } from "./ha-client.js";
import { Dashboard } from "./dashboard.js";
import { createServer } from "./server.js";
import { MusicService } from "./music.js";
import { RadioLibrary } from "./radio-library.js";
import { discoverMusicAssistant } from "./discovery.js";
import { publishAlarmSounds } from "./alarm-sounds.js";
import { KioskAlarms, kioskOptions } from "./kiosk-alarms.js";
import { KioskUpdates } from "./kiosk-updates.js";
import { KioskDimming } from "./kiosk-dimming.js";

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
const nativeOptions = kioskOptions(options);
const returnToClockMinutes = options.return_to_clock_minutes === undefined ? 2 : options.return_to_clock_minutes;
if (!Number.isInteger(returnToClockMinutes) || returnToClockMinutes < 0 || returnToClockMinutes > 1440) {
  throw new Error("return_to_clock_minutes must be a whole number from 0 to 1440 (0 disables automatic return).");
}
const mediaPlayer = process.env.MEDIA_PLAYER ?? options.media_player ?? "";
if (typeof mediaPlayer !== "string" || (mediaPlayer && !/^media_player\.[a-z0-9_]+$/.test(mediaPlayer))) throw new Error("media_player must be a single Home Assistant media_player entity ID.");
const weatherEntity = options.weather_entity === undefined ? "" : options.weather_entity;
if (typeof weatherEntity !== "string" || (weatherEntity && !/^weather\.[a-z0-9_]+$/.test(weatherEntity))) throw new Error("weather_entity must be a single Home Assistant weather entity ID.");
const sunEntity = options.sun_entity === undefined || options.sun_entity === "" ? "sun.sun" : options.sun_entity;
if (typeof sunEntity !== "string" || !/^sun\.[a-z0-9_]+$/.test(sunEntity)) throw new Error("sun_entity must be a single Home Assistant sun entity ID.");
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
if ((token || process.env.HA_CONFIG_DIR) && options.read_only !== true && !nativeOptions) {
  publishAlarmSounds(path.join(root, "web"), process.env.HA_CONFIG_DIR ?? "/homeassistant");
  logger.info("Original alarm sounds installed in Home Assistant www/clock-radio/sounds/v1.");
}
const ha = new HAClient({
  url: token ? "http://supervisor/core" : process.env.HA_URL,
  token: token ?? process.env.HA_TOKEN,
});
const configStore = new ConfigStore({
  dir: process.env.CONFIG_DIR ?? "/config",
  example: path.join(root, "examples/dashboard.yaml"),
  logger,
});
let musicUrl = process.env.MA_URL ?? options.music_assistant_url ?? "";
const musicToken = process.env.MA_TOKEN ?? options.music_assistant_token ?? "";
if (typeof musicUrl !== "string" || typeof musicToken !== "string") throw new Error("Music Assistant address and token must be strings.");
if (!musicUrl && token && musicToken) {
  try { musicUrl = await discoverMusicAssistant(token); }
  catch (error) { logger.warn(error.message); }
}
const music = new MusicService({ ha, logger, url: musicUrl, token: musicToken });
const radio = new RadioLibrary({ ha, music, logger });
const kiosk = nativeOptions ? new KioskAlarms({ ...nativeOptions, logger }) : null;
let deviceClient = kiosk;
let deviceConfigurationError = null;
if (!deviceClient && (options.kiosk_satellite_url || options.kiosk_satellite_token || options.kiosk_satellite_password)) {
  try {
    deviceClient = new KioskAlarms({ ...kioskOptions({ ...options, alarm_backend: "kiosk_satellite" }), logger });
  } catch (error) {
    deviceConfigurationError = error.message;
    logger.warn(`KS device controls unavailable: ${error.message}`);
  }
}
const kioskUpdates = new KioskUpdates({ client: deviceClient, configurationError: deviceConfigurationError, logger });
const kioskDimming = new KioskDimming({ client: deviceClient, configurationError: deviceConfigurationError, logger });
if (kiosk) logger.warn("Kiosk alarm backend enabled. Existing HA schedules are untouched. Native Clock Radio alarms remain scheduled after switching back.");
const dashboard = new Dashboard({ ha, configStore, music, radio, kiosk, kioskUpdates, kioskDimming, mediaPlayer, weatherEntity, sunEntity, returnToClockMinutes, readOnly: options.read_only === true, demo: process.env.DEMO === "1", version, logger });
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
