import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { KioskAlarms, kioskOptions } from "../src/kiosk-alarms.js";
import { createKioskDemo, DEMO_KIOSK_TOKEN } from "../dev/kiosk-fixtures.js";
import { Dashboard } from "../src/dashboard.js";
import { parseConfig } from "../src/config.js";
import { demoStates } from "../dev/fixtures.js";
import { alarmSettings, canEditAlarm, repeatLabel } from "../web/js/pages/alarms.js";
import { SnapshotStore, offlineStatus } from "../web/js/core/snapshot.js";
import { createServer } from "../src/server.js";

async function setup(t) {
  const fixture = createKioskDemo();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const url = `http://127.0.0.1:${fixture.server.address().port}`;
  const kiosk = new KioskAlarms({ url, token: DEMO_KIOSK_TOKEN, logger });
  t.after(async () => {
    if (kiosk.libraryLoading) await kiosk.libraryLoading;
    const closed = once(fixture.server, "close");
    fixture.server.close(); fixture.server.closeAllConnections();
    await closed;
  });
  let haOffline = false;
  const haCalls = [];
  const dashboard = new Dashboard({
    kiosk, version: "0.19.0", demo: true, mediaPlayer: "media_player.different",
    configStore: { current: parseConfig({ time_zone: "Europe/Copenhagen" }), load() {} }, logger,
    ha: {
      async states() { if (haOffline) throw new Error("Fictional HA offline"); return demoStates(); },
      async callService(...args) { haCalls.push(args); },
    },
  });
  await dashboard.refresh();
  await kiosk.refreshMusic();
  return { ...fixture, kiosk, dashboard, haCalls, warnings, url, offline: () => { haOffline = true; } };
}

test("configuration is opt-in, validates before connecting, and does not embed credentials in URLs", () => {
  assert.equal(kioskOptions({}), null);
  assert.equal(kioskOptions({ alarm_backend: "home_assistant" }), null);
  const valid = { alarm_backend: "kiosk_satellite", kiosk_satellite_url: "http://192.0.2.1:2324", kiosk_satellite_token: "fictional" };
  assert.deepEqual(kioskOptions(valid), { url: valid.kiosk_satellite_url, token: "fictional" });
  for (const change of [
    { alarm_backend: "" }, { alarm_backend: "automatic" }, { kiosk_satellite_url: "" },
    { kiosk_satellite_url: "file:///tmp/kiosk" }, { kiosk_satellite_url: "http://user:pass@192.0.2.1/" },
    { kiosk_satellite_url: "http://192.0.2.1/api" }, { kiosk_satellite_url: "http://192.0.2.1/?token=x" },
    { kiosk_satellite_token: "" }, { kiosk_satellite_token: "token\nsecret" }, { kiosk_satellite_token: null },
  ]) assert.throws(() => kioskOptions({ ...valid, ...change }));
});

test("native status and mutations are independent of HA; existing HA and unrelated native alarms are untouched", async (t) => {
  const f = await setup(t);
  assert.equal(f.haCalls.length, 0, "Native mode must not synchronize the shared HA alarm speaker");
  f.offline();
  await f.dashboard.refresh();
  assert.equal(f.dashboard.payload().connected, false);
  assert.equal(f.dashboard.payload().alarms.connected, true);
  assert.equal(f.dashboard.payload().alarms.alarms.length, 0, "Unrelated native alarms are not imported");
  const original = structuredClone(f.alarms[0]);
  const result = await f.dashboard.createAlarm({});
  assert.match(result.alarm_id, /^clock-radio-[a-f0-9]{32}$/);
  let alarm = f.dashboard.payload().alarms.alarms[0];
  assert.equal(alarm.enabled, false);
  assert.equal(canEditAlarm(alarm), true);
  assert.equal(alarm.volume, null);
  assert.equal(alarm.duration, null);
  assert.ok(!Object.hasOwn(alarmSettings(alarm), "volume"));
  assert.match(offlineStatus(f.dashboard.payload()), /Kiosk alarms are connected and editable/);
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm, true), hour: 8, minute: 25 });
  alarm = f.dashboard.payload().alarms.alarms[0];
  assert.equal(alarm.enabled, true);
  assert.equal(alarm.hour, 8);
  await assert.rejects(f.dashboard.deleteAlarm({ id: alarm.id }), /Disable/);
  await f.dashboard.saveAlarm(alarmSettings(alarm, false));
  await f.dashboard.deleteAlarm({ id: alarm.id });
  assert.deepEqual(f.alarms, [original]);
  assert.equal(f.haCalls.length, 0);
});

test("Music choices come from Kiosk's own library/player, preserve picks on toggles, and keep a local tone fallback", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const alarm = f.kiosk.snapshot().alarms[0];
  const station = f.kiosk.snapshot().radio_stations[0];
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(alarm, true), type: "Music" }), /Choose/);
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm, true), type: "Music", music_station_id: station.id });
  let native = f.alarms.find(({ id }) => id === alarm.id);
  assert.equal(native.music.source, "ma");
  assert.equal(native.music.speaker, "", "Own Sendspin player, not an arbitrary HA speaker");
  assert.equal(native.music.item.raw.uri, "library://radio/1");
  assert.equal(native.music.item.raw.private_data, undefined);
  assert.equal(native.tone, "builtin");
  assert.equal(native.speak, false);
  const pick = structuredClone(native.music);
  f.mode.failMusic = true;
  f.kiosk.libraryAt = -Infinity;
  await f.kiosk.refreshMusic();
  assert.match(f.kiosk.musicError, /Kiosk/);
  await f.dashboard.saveAlarm(alarmSettings(f.kiosk.snapshot().alarms[0], false));
  native = f.alarms.find(({ id }) => id === alarm.id);
  assert.deepEqual(native.music, pick);
  const payload = JSON.stringify(f.dashboard.payload());
  for (const secret of [DEMO_KIOSK_TOKEN, "fictional-secret", "library://radio/1", f.url]) assert.ok(!payload.includes(secret), secret);
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: station.id }), /Kiosk/);
});

test("one-shot native schedules are allowed, and external native fields survive time-only edits", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  let alarm = f.kiosk.snapshot().alarms[0];
  const raw = f.alarms.find(({ id }) => id === alarm.id);
  Object.assign(raw, { sunrise: true, ease: true, phrase: "Native phrase" });
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm, true), days: Object.fromEntries(Object.keys(alarm.days).map((day) => [day, false])) });
  alarm = f.kiosk.snapshot().alarms[0];
  assert.equal(alarm.enabled, true);
  assert.equal(repeatLabel(alarm.days, true), "Once");
  assert.equal(f.alarms.find(({ id }) => id === alarm.id).sunrise, true);
  assert.equal(f.alarms.find(({ id }) => id === alarm.id).phrase, "Native phrase");
});

test("unrelated IDs, unsupported settings, active edits, read-only writes and global native controls are rejected", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const alarm = f.kiosk.snapshot().alarms[0];
  const count = () => f.calls.filter(({ name }) => ["alarmSave", "alarmDelete", "alarmStop", "alarmSnooze"].includes(name)).length;
  const before = count();
  await assert.rejects(f.dashboard.deleteAlarm({ id: "personal-native-alarm" }), { status: 403 });
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(alarm), id: "personal-native-alarm" }), { status: 403 });
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(alarm), volume: 90 }), /Unknown/);
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(alarm), buzzer_sound_id: "classic" }), /Unknown/);
  f.mode.phase = "ringing"; f.mode.ids = [alarm.id, "personal-native-alarm"];
  await assert.rejects(f.dashboard.saveAlarm(alarmSettings(alarm)), /Stop this alarm/);
  await assert.rejects(f.dashboard.deleteAlarm({ id: alarm.id }), /Stop this alarm/);
  await assert.rejects(f.dashboard.stopAlarm({}), /all simultaneous alarms/);
  await assert.rejects(f.dashboard.snoozeAlarm({}), /all simultaneous alarms/);
  f.dashboard.readOnly = true;
  for (const action of [
    () => f.dashboard.createAlarm({}), () => f.dashboard.saveAlarm(alarmSettings(alarm)),
    () => f.dashboard.deleteAlarm({ id: alarm.id }), () => f.dashboard.stopAlarm({}), () => f.dashboard.snoozeAlarm({}),
  ]) await assert.rejects(action(), { status: 403 });
  assert.equal(count(), before);
});

test("confirmed native definitions persist read-only without HA and retain backend/device identity", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  f.offline(); await f.dashboard.refresh();
  let saved = null;
  const storage = () => ({ getItem: () => saved, setItem(key, value) { saved = value; } });
  const cache = new SnapshotStore({ storage });
  cache.save(f.dashboard.payload());
  assert.equal(cache.error, null);
  const restored = new SnapshotStore({ storage }).restore("Offline");
  assert.equal(restored.alarms.backend, "kiosk_satellite");
  assert.equal(restored.alarms.backend_id, f.kiosk.backendId);
  assert.equal(restored.alarms.connected, false);
  assert.equal(restored.read_only, true);
  assert.equal(restored.alarms.alarms[0].backend, "kiosk_satellite");
  assert.equal(canEditAlarm(restored.alarms.alarms[0]), true);
  f.mode.unavailable = true;
  await f.dashboard.refresh();
  cache.save(f.dashboard.payload());
  assert.equal(JSON.parse(saved).alarms.length, 1);
  assert.equal(restored.alarms.native_active, false);
  assert.equal(restored.alarms.active, null);
});

test("HTTP alarm routes confirm saves on the device even during HA outages", async (t) => {
  const f = await setup(t);
  f.offline();
  const server = createServer({ dashboard: f.dashboard, webRoot: "", logger: { warn() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/alarm/create`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(f.alarms.some(({ id, on }) => id === result.alarm_id && on === false), true);
  f.mode.ignoreSaves = true;
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), hour: 12 }), /not confirmed/);
});

test("bad authentication, malformed status and lost write acknowledgements fail explicitly without retries", async (t) => {
  const f = await setup(t);
  const bad = new KioskAlarms({ url: f.url, token: "bad-token", logger: { warn() {} } });
  await bad.refresh();
  assert.equal(bad.connected, false);
  assert.match(bad.error, /refused the API token/);
  const malformed = new KioskAlarms({ url: f.url, token: "x", logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: {} })) });
  await malformed.refresh();
  assert.equal(malformed.connected, false);
  assert.match(malformed.error, /invalid alarm status/);
  const originalFetch = f.kiosk.fetch;
  let writes = 0;
  f.kiosk.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (url.endsWith("/alarmSave")) { writes++; throw new Error(`Do not leak ${DEMO_KIOSK_TOKEN}`); }
    return response;
  };
  await assert.rejects(f.dashboard.createAlarm({}), /may have completed.*Refresh/);
  assert.equal(writes, 1);
  assert.equal(f.kiosk.snapshot().alarms.length, 1, "Refresh reveals an applied operation whose acknowledgement was lost");
  assert.ok(f.warnings.every((message) => !message.includes(DEMO_KIOSK_TOKEN)));
});

test("native deadlines cover stalled response bodies and never retry writes", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const slow = new KioskAlarms({ url: f.url, token: DEMO_KIOSK_TOKEN, timeoutMs: 10,
    fetchImpl: async (url, { signal }) => {
      calls++;
      return { status: 200, ok: true, text: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) };
    } });
  await assert.rejects(slow.command("alarmSave", {}, true), /timed out.*may have completed/);
  assert.equal(calls, 1);
});

test("simultaneous mutations are serialized and a rejected duplicate is not reported as an unknown outcome", async (t) => {
  const f = await setup(t);
  const original = f.kiosk.fetch;
  let release, reached;
  const atSave = new Promise((resolve) => { reached = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  f.kiosk.fetch = async (url, options) => {
    if (url.endsWith("/alarmSave")) { reached(); await hold; }
    return original(url, options);
  };
  const first = f.dashboard.createAlarm({});
  await atSave;
  await assert.rejects(f.dashboard.createAlarm({}), /already in progress/);
  release();
  await first;
  f.kiosk.fetch = original;
  const alarm = f.kiosk.snapshot().alarms[0];
  await assert.rejects(f.dashboard.saveAlarm({
    ...alarmSettings(alarm), hour: 7, minute: 0,
    days: Object.fromEntries(Object.keys(alarm.days).map((day) => [day, ["saturday", "sunday"].includes(day)])),
  }), (error) => /already has that time/.test(error.message) && !/may have completed/.test(error.message));
});
