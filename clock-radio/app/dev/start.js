import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDemoAPI, DEMO_HA_TOKEN, DEMO_MA_TOKEN } from "./fixtures.js";
import { createKioskDemo, DEMO_KIOSK_TOKEN } from "./kiosk-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.CONFIG_DIR ?? path.join(root, "dev/config");
fs.mkdirSync(configDir, { recursive: true });
const optionsFile = process.env.OPTIONS_FILE ?? path.join(configDir, "options.json");
if (!process.env.OPTIONS_FILE && !fs.existsSync(optionsFile)) fs.writeFileSync(optionsFile, '{"weather_entity":"weather.bedroom"}\n');
const file = path.join(configDir, "dashboard.yaml");
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, `title: Clock Radio
locale: en-GB
time_zone: Europe/Copenhagen
clock:
  weather_name: Copenhagen
players: [media_player.bedroom, media_player.kitchen]
default_player: media_player.bedroom
stations:
  - id: morning
    name: Morning Jazz
    media_content_id: https://example.com/morning.mp3
  - id: slow
    name: Slow Sundays
    media_content_id: https://example.com/slow.mp3
  - id: classical
    name: Classical Calm
    media_content_id: https://example.com/classical.mp3
  - id: night
    name: After Hours
    media_content_id: https://example.com/night.mp3
`);
}
const demo = createDemoAPI();
if (process.env.DEMO_ALARM) {
  if (!["Music", "Buzzer"].includes(process.env.DEMO_ALARM)) throw new Error("DEMO_ALARM must be Music or Buzzer.");
  demo.startAlarm(process.env.DEMO_ALARM === "Music" ? 1 : 2);
}
const { server: mock, ws } = demo;
// Keep mock connections alive longer than the dashboard's five-second poll.
mock.keepAliveTimeout = 60_000;
mock.headersTimeout = 65_000;
await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(0, "127.0.0.1", resolve);
});
let runtimeOptions = optionsFile;
let kioskDemo = null;
let kioskTemp = null;
if (JSON.parse(fs.readFileSync(optionsFile, "utf8")).alarm_backend === "kiosk_satellite") {
  kioskDemo = createKioskDemo();
  await new Promise((resolve, reject) => {
    kioskDemo.server.once("error", reject);
    kioskDemo.server.listen(0, "127.0.0.1", resolve);
  });
  kioskTemp = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-kiosk-demo-"));
  runtimeOptions = path.join(kioskTemp, "options.json");
  fs.writeFileSync(runtimeOptions, JSON.stringify({
    ...JSON.parse(fs.readFileSync(optionsFile, "utf8")),
    kiosk_satellite_url: `http://127.0.0.1:${kioskDemo.server.address().port}`, kiosk_satellite_token: DEMO_KIOSK_TOKEN,
  }));
}
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: root, stdio: "inherit",
  env: {
    ...process.env, SUPERVISOR_TOKEN: "", OPTIONS_FILE: runtimeOptions,
    HA_URL: `http://127.0.0.1:${mock.address().port}`, HA_TOKEN: DEMO_HA_TOKEN,
    MA_URL: `http://127.0.0.1:${mock.address().port}/ma`, MA_TOKEN: DEMO_MA_TOKEN,
    CONFIG_DIR: configDir, MEDIA_PLAYER: "media_player.bedroom", DEMO: "1", HOST: process.env.HOST ?? "127.0.0.1",
  },
});
function closeDemo() {
  ws.close(); mock.close(); mock.closeIdleConnections();
  kioskDemo?.server.close();
  kioskDemo?.server.closeAllConnections();
  if (kioskTemp) fs.rmSync(kioskTemp, { recursive: true });
}
child.on("error", (error) => { console.error(error); closeDemo(); process.exitCode = 1; });
child.on("exit", (code) => { closeDemo(); process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
