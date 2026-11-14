import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("demo starts without real credentials, stays connected and shuts down cleanly", { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-demo-"));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = {
    ...process.env, CONFIG_DIR: dir, PORT: String(port), HOST: "127.0.0.1",
    SUPERVISOR_TOKEN: "must-not-use-real-supervisor", HA_URL: "http://127.0.0.1:1", HA_TOKEN: "must-not-use-real-token",
  };
  delete env.OPTIONS_FILE;
  const child = spawn(process.execPath, ["dev/start.js"], { cwd: fileURLToPath(new URL("../", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true });
  });
  for (let count = 0; count < 80 && !output.includes("listening on port"); count++) {
    assert.equal(child.exitCode, null, output);
    await delay(100);
  }
  assert.match(output, /listening on port/);
  const state = async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  const initial = await state();
  assert.equal(initial.demo, true);
  assert.equal(initial.connected, true);
  assert.equal(initial.config.stations.length, 4);
  assert.equal(initial.config.clock.weather_entity, "weather.bedroom");
  assert.equal(initial.clock.weatherConfigured, true);
  assert.equal(initial.clock.weatherHigh, 22);
  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "media_pause", entity_id: "media_player.bedroom" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await state()).players[0].state, "paused");
  for (let count = 0; count < 3; count++) {
    await delay(5100);
    assert.equal((await state()).connected, true, output);
  }
  assert.ok(!output.includes("WARN"), output);
});

test("startup rejects invalid HA weather options before connecting", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-weather-options-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const optionsFile = path.join(dir, "options.json");
  for (const weather_entity of [null, 123, [], {}, "light.room", "weather.", "weather.room,weather.other", "weather.Room", " weather.room"]) {
    fs.writeFileSync(optionsFile, JSON.stringify({ weather_entity }));
    const child = spawnSync(process.execPath, ["src/index.js"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, OPTIONS_FILE: optionsFile, CONFIG_DIR: dir },
      encoding: "utf8", timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /weather_entity must be a single Home Assistant weather entity ID/);
  }
});
