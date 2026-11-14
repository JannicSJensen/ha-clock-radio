import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDemoAPI, DEMO_HA_TOKEN, DEMO_MA_TOKEN } from "./fixtures.js";

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
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: root, stdio: "inherit",
  env: {
    ...process.env, SUPERVISOR_TOKEN: "", OPTIONS_FILE: optionsFile,
    HA_URL: `http://127.0.0.1:${mock.address().port}`, HA_TOKEN: DEMO_HA_TOKEN,
    MA_URL: `http://127.0.0.1:${mock.address().port}/ma`, MA_TOKEN: DEMO_MA_TOKEN,
    CONFIG_DIR: configDir, MEDIA_PLAYER: "media_player.bedroom", DEMO: "1", HOST: process.env.HOST ?? "127.0.0.1",
  },
});
child.on("error", (error) => { console.error(error); ws.close(); mock.close(); process.exitCode = 1; });
child.on("exit", (code) => { ws.close(); mock.close(); mock.closeIdleConnections(); process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
