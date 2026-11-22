import assert from "node:assert/strict";
import test from "node:test";
import { Dashboard } from "../src/dashboard.js";
import { parseConfig } from "../src/config.js";
import { demoStates } from "../dev/fixtures.js";
import { SnapshotStore, offlineStatus } from "../web/js/core/snapshot.js";
import { canEditAlarm } from "../web/js/pages/alarms.js";
import { setUiLanguage } from "../web/js/lib/ui-language.js";

function storage() {
  const values = new Map();
  return {
    values, writes: 0,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); this.writes++; },
  };
}
function store(disk = storage()) {
  const warnings = [];
  return { disk, warnings, cache: new SnapshotStore({ storage: () => disk, logger: { warn: (message) => warnings.push(message) } }) };
}
async function payload(states = demoStates()) {
  const dashboard = new Dashboard({
    configStore: { current: parseConfig({ time_zone: "Europe/Copenhagen", clock: { face: "digital", night_mode: "sun" } }), load() {} },
    ha: { states: async () => states }, logger: { warn() {} },
    version: "0.18.0", demo: false, mediaPlayer: "media_player.bedroom",
  });
  await dashboard.refresh();
  return dashboard.payload();
}

test("a real dashboard snapshot survives reload as a complete, read-only model", async () => {
  const live = await payload();
  const { cache, disk } = store();
  cache.save(live, 0);
  assert.equal(cache.error, null);
  const restored = store(disk).cache.restore("HA unavailable");
  assert.equal(restored.connected, false);
  assert.equal(restored.read_only, true);
  assert.equal(restored.offline_snapshot, true);
  assert.equal(restored.updated_at, live.updated_at);
  assert.equal(restored.connection_error, "HA unavailable");
  assert.deepEqual(restored.config.clock, live.config.clock);
  assert.equal(restored.clock.clock, live.clock.clock);
  assert.equal(restored.clock.timeZone, live.clock.timeZone);
  assert.equal(restored.clock.night, live.clock.night);
  assert.deepEqual(restored.alarms.alarms.map(({ id, hour, minute, days }) => ({ id, hour, minute, days })),
    live.alarms.alarms.map(({ id, hour, minute, days }) => ({ id, hour, minute, days })));
  assert.equal(canEditAlarm(restored.alarms.alarms[0]), true, "Valid schedules remain inspectable");
  assert.match(offlineStatus(restored), /Offline.*saved schedules.*Read-only.*Last synchronized:.*HA alarm execution cannot be confirmed/);
  assert.equal(offlineStatus(live), "");
  restored.config.clock.face = "analog";
  assert.equal(cache.restore("").config.clock.face, "digital", "Views cannot mutate the stored definition");
});

test("offline snapshots preserve shared language and accept legacy snapshots", async () => {
  const live = await payload();
  live.config.clock.app_language = "da";
  const { cache, disk } = store();
  cache.save(live);
  const restored = store(disk).cache.restore("");
  assert.equal(restored.config.clock.app_language, "da");
  assert.equal(restored.clock.locale, "da");
  try {
    setUiLanguage("da");
    assert.match(offlineStatus(restored), /Offline.*gemte tidsplaner.*Skrivebeskyttet.*Senest synkroniseret/);
  } finally {
    setUiLanguage("en");
  }
  const [key, value] = [...disk.values.entries()][0];
  const old = JSON.parse(value);
  delete old.config.clock.app_language;
  disk.values.set(key, JSON.stringify(old));
  assert.equal(store(disk).cache.restore("").config.clock.app_language, "");
});

test("only definitions are persisted; credentials, URLs, live timers and capabilities never return", async () => {
  const live = await payload();
  live.secret = "secret-marker";
  live.config.token = "secret-marker";
  live.config.stations = [{ id: "x", name: "One", media_content_id: "https://secret-marker" }];
  live.players[0].attributes.entity_picture = "/api/image?token=secret-marker";
  Object.assign(live.alarms, { active: { id: 1 }, snoozed: { id: 1 }, music_source: "secret-marker", buzzer_source: "secret-marker" });
  Object.assign(live.alarms.alarms[0], { timer: "active", finishes_at: "secret-marker", music_source: "secret-marker" });
  const { cache, disk } = store();
  cache.save(live);
  const serialized = [...disk.values.values()][0];
  assert.doesNotMatch(serialized, /secret-marker|finishes_at|snoozed|can_play|entity_picture|media_content/);
  const restored = cache.restore("");
  assert.deepEqual(restored.players, []);
  assert.deepEqual(restored.clock_entities, []);
  assert.equal(restored.clock.weatherTemperature, null);
  assert.equal(restored.clock.alarm, null);
  assert.equal(restored.alarms.active, null);
  assert.equal(restored.alarms.snoozed, null);
  assert.equal(restored.alarms.alarms[0].timer, null);
  for (const [key, value] of Object.entries(restored.alarms)) if (key.startsWith("can_")) assert.equal(value, false);
  assert.equal(restored.alarms.alarms[0].can_select_sound, false);
  assert.equal(restored.music.library, false);
  assert.deepEqual(restored.music.stations, []);
});

test("failed, empty disconnected, and deletion-in-progress responses cannot replace a good snapshot", async () => {
  const live = await payload();
  const { cache, disk } = store();
  cache.save(live, 0);
  cache.save({ ...live, connected: false, alarms: { alarms: [] } }, 60_000);
  cache.save({ ...live, alarms: { ...live.alarms, deleting: 1, alarms: [] } }, 60_000);
  cache.save(cache.restore(""), 60_000);
  assert.equal(disk.writes, 1);
  assert.equal(cache.restore("").alarms.alarms.length, 2);
  live.alarms.alarms.splice(0, 1);
  cache.save(live, 1000);
  assert.deepEqual(store(disk).cache.restore("").alarms.alarms.map(({ id }) => id), [2], "Fresh HA state replaces, never merges");
});

test("storage I/O is throttled, while last sync remains current in memory and definition changes persist immediately", async () => {
  const live = await payload();
  const { cache, disk } = store();
  cache.save(live, 0);
  live.updated_at = "2026-11-16T08:00:00.000Z";
  cache.save(live, 59_999);
  assert.equal(disk.writes, 1);
  assert.equal(cache.restore("").updated_at, live.updated_at);
  cache.save(live, 60_000);
  assert.equal(disk.writes, 2);
  live.alarms.alarms[0].hour = 7;
  cache.save(live, 60_001);
  assert.equal(disk.writes, 3);
  assert.equal(store(disk).cache.restore("").alarms.alarms[0].hour, 7);
});

test("storage failures are visible and logged, retain an in-memory snapshot, and recover on the next checkpoint", async () => {
  const live = await payload();
  const { disk, warnings, cache } = store();
  const write = disk.setItem;
  disk.setItem = () => { throw new Error("Quota exceeded"); };
  cache.save(live, 0);
  assert.match(cache.error, /Quota exceeded/);
  assert.equal(warnings.length, 1);
  assert.equal(cache.restore("").alarms.alarms.length, 2);
  cache.save(live, 59_999);
  assert.equal(warnings.length, 1);
  disk.setItem = write;
  cache.save(live, 60_000);
  assert.equal(cache.error, null);
  assert.ok(store(disk).cache.restore(""));
  const denied = new SnapshotStore({ storage() { throw new Error("Storage blocked"); }, logger: { warn() {} } });
  assert.match(denied.error, /Storage blocked/);
  denied.save(live);
  assert.ok(denied.restore(""));
});

test("corrupt, incomplete, duplicate, or unsupported snapshots are rejected without crashing or enabling controls", async () => {
  const { cache, disk } = store();
  cache.save(await payload());
  const [key, value] = [...disk.values][0];
  const valid = JSON.parse(value);
  const corrupt = [
    "{", JSON.stringify({ ...valid, schema: 99 }),
    JSON.stringify({ ...valid, saved_at: "yesterday" }),
    JSON.stringify({ ...valid, config: { ...valid.config, clock: null } }),
    JSON.stringify({ ...valid, alarms: [valid.alarms[0], valid.alarms[0]] }),
    JSON.stringify({ ...valid, alarms: [{ ...valid.alarms[0], hour: "6" }] }),
    JSON.stringify({ ...valid, config: { ...valid.config, clock: { unknown: true } } }),
    JSON.stringify({ ...valid, time_zone: "Invalid/Zone" }),
  ];
  for (const bad of corrupt) {
    disk.values.set(key, bad);
    const loaded = store(disk);
    assert.equal(loaded.cache.restore(""), null);
    assert.match(loaded.cache.error, /Offline snapshot unavailable/);
    assert.equal(loaded.warnings.length, 1);
  }
});

test("clock-only installs and incomplete helpers do not lose their display settings or invent valid schedules", async () => {
  const { cache } = store();
  cache.save(await payload([]));
  assert.equal(cache.error, null);
  assert.equal(cache.restore("").config.clock.face, "digital");
  for (const alarm of cache.restore("").alarms.alarms) {
    assert.equal(alarm.available, false);
    assert.equal(alarm.hour, null);
    assert.equal(canEditAlarm(alarm), false);
  }
  const live = await payload();
  live.alarms.alarms[0].hour = 99;
  live.alarms.alarms[0].buzzer_source_set = true;
  cache.save(live);
  assert.equal(cache.restore("").alarms.alarms[0].hour, 99);
  assert.equal(canEditAlarm(cache.restore("").alarms.alarms[0]), false);
  assert.equal(cache.restore("").alarms.alarms[0].buzzer_source_set, true);
});
