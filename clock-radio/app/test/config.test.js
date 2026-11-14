import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigStore, parseConfig } from "../src/config.js";

test("configuration defaults and explicit clock settings", () => {
  const config = parseConfig({});
  assert.equal(config.clock_24h, true);
  assert.deepEqual(config.players, []);
  assert.deepEqual(config.stations, []);
  assert.equal(parseConfig({ clock_24h: false, show_seconds: true, time_zone: "Europe/Copenhagen" }).show_seconds, true);
});

for (const [name, value] of [
  ["empty document", null], ["list document", []], ["unknown option", { titel: "Clock" }],
  ["invalid time zone", { time_zone: "Not/AZone" }], ["invalid locale", { locale: "not_a_locale" }],
  ["non-boolean clock", { clock_24h: "true" }], ["wrong player domain", { players: ["light.bedroom"] }],
  ["duplicate player", { players: ["media_player.room", "media_player.room"] }],
  ["unlisted default player", { players: ["media_player.room"], default_player: "media_player.other" }],
  ["non-list stations", { stations: {} }], ["non-string default player", { default_player: 123 }],
]) {
  test(`configuration rejects ${name}`, () => assert.throws(() => parseConfig(value)));
}

const station = { id: "jazz", name: "Jazz", media_content_id: "https://example.com/live.mp3" };
test("radio presets normalize source/type and support media source and MA URIs", () => {
  assert.equal(parseConfig({ stations: [station] }).stations[0].source, "home_assistant");
  assert.equal(parseConfig({ stations: [station] }).stations[0].media_content_type, "music");
  for (const uri of ["media-source://radio_browser/test", "http://example.com/live"]) {
    assert.equal(parseConfig({ stations: [{ ...station, media_content_id: uri }] }).stations[0].media_content_id, uri);
  }
  for (const uri of ["library://radio/123", "radiobrowser://123"]) {
    assert.equal(parseConfig({ stations: [{ ...station, source: "music_assistant", media_content_id: uri }] }).stations[0].source, "music_assistant");
  }
});

for (const [name, stations] of [
  ["duplicate IDs", [station, station]],
  ["unknown field", [{ ...station, url: "https://example.com" }]],
  ["missing URI", [{ id: "one", name: "One" }]],
  ["relative URI", [{ ...station, media_content_id: "/local/stream" }]],
  ["unsafe URI", [{ ...station, media_content_id: "javascript:alert(1)" }]],
  ["file URI", [{ ...station, media_content_id: "file:///etc/passwd" }]],
  ["credentials", [{ ...station, media_content_id: "https://user:password@example.com/live" }]],
  ["wrong source", [{ ...station, source: "other" }]],
]) {
  test(`presets reject ${name}`, () => assert.throws(() => parseConfig({ stations })));
}

test("config is seeded once, hot reloads, retains last valid data and recovers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const example = fileURLToPath(new URL("../examples/dashboard.yaml", import.meta.url));
  const warnings = [];
  const store = new ConfigStore({ dir, example, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(store.current.title, "Clock Radio");
  fs.writeFileSync(store.file, "title: My bedroom\n");
  store.load();
  assert.equal(store.current.title, "My bedroom");
  fs.writeFileSync(store.file, "players: [\n");
  store.load();
  store.load();
  assert.match(store.error, /Configuration not applied/);
  assert.equal(warnings.length, 1);
  assert.equal(store.current.title, "My bedroom");
  fs.writeFileSync(store.file, "title: Fixed\n");
  store.load();
  assert.equal(store.error, null);
  assert.equal(new ConfigStore({ dir, example }).current.title, "Fixed");
  fs.writeFileSync(store.file, "players: [\n");
  assert.throws(() => new ConfigStore({ dir, example }));
});
