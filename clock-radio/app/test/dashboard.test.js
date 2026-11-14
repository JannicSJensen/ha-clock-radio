import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { Dashboard, validateCommand } from "../src/dashboard.js";

const config = parseConfig({
  players: ["media_player.room"],
  stations: [
    { id: "one", name: "One", media_content_id: "https://example.com/live" },
    { id: "ma", name: "MA", source: "music_assistant", media_content_id: "library://radio/123" },
  ],
});
const players = [{ entity_id: "media_player.room", state: "playing" }];
const context = { config, players, readOnly: false };
const base = { entity_id: "media_player.room", action: "media_pause" };

test("policy resolves only server-configured station IDs and exact services", () => {
  assert.deepEqual(validateCommand(base, context), { domain: "media_player", service: "media_pause", data: { entity_id: "media_player.room" } });
  const stream = validateCommand({ ...base, action: "play_station", station_id: "one" }, context);
  assert.deepEqual(stream.data, { entity_id: "media_player.room", media_content_id: "https://example.com/live", media_content_type: "music" });
  const ma = validateCommand({ ...base, action: "play_station", station_id: "ma" }, context);
  assert.deepEqual(ma, { domain: "music_assistant", service: "play_media", data: { entity_id: "media_player.room", media_id: "library://radio/123", media_type: "radio", enqueue: "replace" } });
});

for (const [name, body] of [
  ["null", null], ["list", []], ["unknown service", { ...base, action: "turn_off" }],
  ["other entity", { ...base, entity_id: "media_player.other" }],
  ["multiple targets", { ...base, entity_id: ["media_player.room"] }],
  ["injected data", { ...base, data: { entity_id: "all" } }],
  ["injected URI", { ...base, action: "play_station", station_id: "one", media_content_id: "http://other" }],
  ["unknown station", { ...base, action: "play_station", station_id: "missing" }],
  ["irrelevant station field", { ...base, station_id: "one" }],
  ["irrelevant volume field", { ...base, volume_level: 1 }],
]) {
  test(`policy rejects ${name}`, () => assert.throws(() => validateCommand(body, context)));
}

test("volume boundaries are exact, finite and typed", () => {
  for (const volume of [0, 0.5, 1]) {
    assert.equal(validateCommand({ ...base, action: "volume_set", volume_level: volume }, context).data.volume_level, volume);
  }
  for (const volume of [-0.01, 1.01, NaN, Infinity, "0.5", null, undefined]) {
    assert.throws(() => validateCommand({ ...base, action: "volume_set", volume_level: volume }, context));
  }
});

test("read-only and unavailable players are enforced by server policy", () => {
  assert.throws(() => validateCommand(base, { ...context, readOnly: true }), { status: 403 });
  assert.throws(() => validateCommand(base, { ...context, players: [{ ...players[0], state: "unavailable" }] }), { status: 409 });
});

test("payload is scoped and sanitized; disconnect disables commands and recovery works", async () => {
  let offline = false;
  const calls = [];
  const dashboard = new Dashboard({
    version: "0.1.0",
    configStore: { current: config, error: null, load() {} },
    logger: { warn() {} },
    ha: {
      async states() {
        if (offline) throw new Error("Offline");
        return [
          { ...players[0], attributes: { friendly_name: "Bedroom", entity_picture: "/api/image?token=private", private_data: "secret" } },
          { entity_id: "media_player.other", state: "playing", attributes: {} },
          { entity_id: "sensor.private", state: "secret", attributes: {} },
        ];
      },
      async callService(...args) { calls.push(args); },
    },
  });
  await dashboard.refresh();
  assert.equal(dashboard.payload().connected, true);
  assert.equal(dashboard.payload().players.length, 1);
  const payload = JSON.stringify(dashboard.payload());
  for (const secret of ["token=private", "private_data", "secret", "https://example.com", "library://"]) assert.ok(!payload.includes(secret));
  assert.equal(dashboard.payload().clock_entities[0].entity_id, "sensor.private");
  assert.ok(!Object.hasOwn(dashboard.payload().clock_entities[0], "state"));
  await dashboard.command(base);
  assert.equal(calls.length, 1);
  offline = true;
  await dashboard.refresh();
  assert.equal(dashboard.payload().players.length, 1);
  assert.equal(dashboard.payload().connected, false);
  await assert.rejects(dashboard.command(base), { status: 503 });
  assert.equal(calls.length, 1);
  offline = false;
  await dashboard.refresh();
  assert.equal(dashboard.connected, true);
});

test("discovery allows media players only and reports missing configured players", async () => {
  const store = { current: parseConfig({}), load() {}, error: null };
  const dashboard = new Dashboard({ configStore: store, ha: { states: async () => [{ entity_id: "media_player.one", state: "idle" }, { entity_id: "light.one", state: "on" }] } });
  await dashboard.refresh();
  assert.deepEqual(dashboard.payload().players.map((player) => player.entity_id), ["media_player.one"]);
  store.current = parseConfig({ players: ["media_player.missing"] });
  assert.deepEqual(dashboard.payload().missing_players, ["media_player.missing"]);
  assert.deepEqual(dashboard.payload().players, []);
});
