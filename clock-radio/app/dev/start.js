import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.CONFIG_DIR ?? path.join(root, "dev/config");
fs.mkdirSync(configDir, { recursive: true });
const optionsFile = process.env.OPTIONS_FILE ?? path.join(configDir, "options.json");
if (!process.env.OPTIONS_FILE && !fs.existsSync(optionsFile)) fs.writeFileSync(optionsFile, "{}\n");
const file = path.join(configDir, "dashboard.yaml");
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, `title: Clock Radio
locale: en-GB
time_zone: Europe/Copenhagen
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
const states = ["bedroom", "kitchen"].map((name) => ({
  entity_id: `media_player.${name}`, state: name === "bedroom" ? "playing" : "idle",
  attributes: { friendly_name: name === "bedroom" ? "Bedroom" : "Kitchen", media_title: name === "bedroom" ? "The quiet side of morning" : "", media_artist: name === "bedroom" ? "Morning Jazz · Live radio" : "", volume_level: 0.3, supported_features: 20997 },
}));
const mock = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== "Bearer clock-radio-demo") {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Invalid demo token." }));
  }
  if (req.method === "GET" && req.url === "/api/states") return res.end(JSON.stringify(states));
  if (req.method === "POST" && req.url.startsWith("/api/services/media_player/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Invalid JSON." }));
    }
    const player = states.find((state) => state.entity_id === data.entity_id);
    if (!player) { res.writeHead(404); return res.end(JSON.stringify({ error: "Unknown player." })); }
    const service = req.url.split("/").at(-1);
    if (service === "play_media") {
      player.state = "playing";
      player.attributes.media_title = "A fresh frequency";
      player.attributes.media_artist = "Demo radio · Live";
    } else if (service === "media_play") player.state = "playing";
    else if (service === "media_pause") player.state = "paused";
    else if (service === "media_stop") player.state = "idle";
    else if (service === "volume_set") player.attributes.volume_level = data.volume_level;
    else { res.writeHead(400); return res.end(JSON.stringify({ error: "Unsupported service." })); }
    return res.end("[]");
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found." }));
});
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
    HA_URL: `http://127.0.0.1:${mock.address().port}`, HA_TOKEN: "clock-radio-demo",
    CONFIG_DIR: configDir, DEMO: "1", HOST: process.env.HOST ?? "127.0.0.1",
  },
});
child.on("error", (error) => { console.error(error); mock.close(); process.exitCode = 1; });
child.on("exit", (code) => { mock.close(); mock.closeIdleConnections(); process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
