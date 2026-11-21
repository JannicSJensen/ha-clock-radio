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
import { kioskAlarmMusicOptions } from "../web/js/components/kiosk-alarm-picker.js";

async function setup(t) {
  const fixture = createKioskDemo();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const url = `http://127.0.0.1:${fixture.server.address().port}`;
  const kiosk = new KioskAlarms({ url, token: DEMO_KIOSK_TOKEN, logger });
  t.after(async () => {
    const closed = once(fixture.server, "close");
    fixture.server.close(); fixture.server.closeAllConnections();
    await closed;
  });
  let haOffline = false;
  const haCalls = [];
  const dashboard = new Dashboard({
    kiosk, version: "0.20.0", demo: true, mediaPlayer: "media_player.different",
    configStore: { current: parseConfig({ time_zone: "Europe/Copenhagen" }), load() {} }, logger,
    ha: {
      async states() { if (haOffline) throw new Error("Fictional HA offline"); return demoStates(); },
      async callService(...args) { haCalls.push(args); },
    },
  });
  await dashboard.refresh();
  return { ...fixture, kiosk, dashboard, haCalls, warnings, url, offline: () => { haOffline = true; } };
}

test("configuration is opt-in, validates before connecting, and does not embed credentials in URLs", () => {
  assert.equal(kioskOptions({}), null);
  assert.equal(kioskOptions({ alarm_backend: "home_assistant" }), null);
  const valid = { alarm_backend: "kiosk_satellite", kiosk_satellite_url: "http://192.0.2.1:2324", kiosk_satellite_token: "fictional" };
  assert.deepEqual(kioskOptions(valid), { url: valid.kiosk_satellite_url, token: "fictional" });
  assert.deepEqual(kioskOptions({ ...valid, kiosk_satellite_alarm_ui: "clock" }), { url: valid.kiosk_satellite_url, token: "fictional", alarmUi: "clock" });
  assert.throws(() => kioskOptions({ ...valid, kiosk_satellite_alarm_ui: "automatic" }), /must be native or clock/);
  for (const change of [
    { alarm_backend: "" }, { alarm_backend: "automatic" }, { kiosk_satellite_url: "" },
    { kiosk_satellite_url: "file:///tmp/kiosk" }, { kiosk_satellite_url: "http://user:pass@192.0.2.1/" },
    { kiosk_satellite_url: "http://192.0.2.1/api" }, { kiosk_satellite_url: "http://192.0.2.1/?token=x" },
    { kiosk_satellite_token: "" }, { kiosk_satellite_token: "token\nsecret" }, { kiosk_satellite_token: null },
  ]) assert.throws(() => kioskOptions({ ...valid, ...change }));
});

test("ringing capabilities are opt-in and old KS versions retain native controls", async (t) => {
  const f = await setup(t);
  f.kiosk.alarmUi = "clock";
  let snapshot = f.kiosk.snapshot();
  assert.deepEqual(snapshot.presentation, { requested: true, supported: false, enabled: false, device: null });
  f.mode.presentation = { version: 1, device: "a".repeat(32), enabled: true };
  await f.kiosk.refresh();
  snapshot = f.kiosk.snapshot();
  assert.equal(snapshot.presentation.supported, true);
  assert.equal(snapshot.presentation.enabled, true);
  assert.equal(snapshot.presentation.device, "a".repeat(32));
  assert.equal(snapshot.active, null, "Server status is never evidence of local UI readiness");
  assert.equal(snapshot.can_stop, false, "Unscoped remote controls remain blocked");
  f.mode.presentation.version = 2;
  await f.kiosk.refresh();
  assert.equal(f.kiosk.snapshot().presentation.supported, false);
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

test("Music can inherit Kiosk's default without forcing a source or speaker; Buzzer forces the native tone", async (t) => {
  const f = await setup(t);
  f.offline();
  await f.dashboard.createAlarm({});
  const alarm = f.kiosk.snapshot().alarms[0];
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm, true), type: "Music" });
  let native = f.alarms.find(({ id }) => id === alarm.id);
  assert.equal(Object.hasOwn(native, "music"), false, "Missing music follows Kiosk's live default, not none or a copied pick");
  assert.equal(Object.hasOwn(f.calls.findLast(({ name }) => name === "alarmSave").data.alarm, "music"), false);
  assert.equal(native.tone, "builtin");
  assert.equal(native.speak, false);
  assert.equal(f.kiosk.snapshot().alarms[0].music_station_name, "Kiosk Alarm music default");
  assert.equal(f.kiosk.snapshot().alarms[0].can_select_radio, true);
  assert.deepEqual(f.kiosk.snapshot().radio_stations, []);
  assert.equal(f.kiosk.snapshot().radio_error, null);
  await f.dashboard.saveAlarm(alarmSettings(f.kiosk.snapshot().alarms[0], false));
  native = f.alarms.find(({ id }) => id === alarm.id);
  assert.equal(Object.hasOwn(native, "music"), false, "Toggling keeps inheritance");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Buzzer" });
  assert.equal(f.alarms.find(({ id }) => id === alarm.id).music, "none");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music" });
  assert.equal(Object.hasOwn(f.alarms.find(({ id }) => id === alarm.id), "music"), false);
  assert.ok(f.calls.every(({ name }) => ["alarmsStatus", "alarmSave"].includes(name)), "Do not read a radio catalog or modify Kiosk's global music settings");
  assert.equal(f.haCalls.length, 0);
  const payload = JSON.stringify(f.dashboard.payload());
  for (const secret of [DEMO_KIOSK_TOKEN, "fictional-secret", "library://radio/1", f.url]) assert.ok(!payload.includes(secret), secret);
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: "ks-radio-0123456789abcdef" }), /Select an available native music/);
});

test("schedule saves and toggles preserve native music; default inheritance is an explicit choice", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const native = f.alarms.find(({ id }) => id === f.kiosk.snapshot().alarms[0].id);
  native.music = { source: "ma", item: { id: "library://radio/1", title: "Previous station" }, shuffle: false, speaker: "previous-speaker", speakerName: "Previous speaker" };
  const before = structuredClone(native);
  await f.dashboard.refresh();
  assert.deepEqual(native, before, "Polling must not migrate existing schedules");
  assert.equal(f.kiosk.snapshot().alarms[0].music_station_name, "Previous station");
  f.mode.ignoreSaves = true;
  await assert.rejects(f.dashboard.saveAlarm(alarmSettings(f.kiosk.snapshot().alarms[0], true)), /not confirmed/);
  assert.deepEqual(f.alarms.find(({ id }) => id === native.id), before);
  f.mode.ignoreSaves = false;
  await f.dashboard.saveAlarm(alarmSettings(f.kiosk.snapshot().alarms[0], true));
  const saved = f.alarms.find(({ id }) => id === native.id);
  assert.deepEqual(saved, { ...before, on: true }, "Toggling must preserve every saved native music field");
  assert.equal(f.kiosk.snapshot().alarms[0].type, "Music");
  assert.equal(f.kiosk.snapshot().alarms[0].music_station_name, "Previous station");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: null });
  assert.equal(Object.hasOwn(f.alarms.find(({ id }) => id === native.id), "music"), false);
  assert.equal(f.kiosk.snapshot().alarms[0].music_station_name, "Kiosk Alarm music default");
});

test("native catalogs expose opaque choices, page radios, and save the explicitly selected speaker", async (t) => {
  const f = await setup(t);
  f.offline();
  await f.dashboard.createAlarm({});
  const catalog = await f.kiosk.musicOptions();
  assert.equal(catalog.source, "ma");
  assert.equal(catalog.items[0].name, "Morning Radio");
  assert.equal(catalog.more, true);
  const external = catalog.speakers.find(({ name }) => name === "Bedroom speaker");
  const local = catalog.speakers.find(({ name }) => name.includes("Sendspin"));
  assert.equal(catalog.speaker, external.id, "Do not force Kiosk's local Sendspin renderer");
  const second = await f.kiosk.musicOptions({ source: "ma", speaker: external.id, category: "radio", offset: String(catalog.offset) });
  assert.equal(second.items[0].name, "Evening Radio");
  assert.equal(second.more, false);
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0], true), type: "Music", music_station_id: second.items[0].id });
  let saved = f.alarms.find(({ id }) => id === f.kiosk.snapshot().alarms[0].id);
  assert.equal(saved.music.speaker, "ma:bedroom");
  assert.equal(saved.music.item.id, "library://radio/2");
  assert.equal(saved.music.item.raw.uri, "library://radio/2");
  assert.equal(f.kiosk.snapshot().alarms[0].music_station_id, second.items[0].id);
  const own = await f.kiosk.musicOptions({ source: "ma", speaker: local.id, category: "radio" });
  assert.notEqual(own.items[0].id, catalog.items[0].id, "Music choices are bound to their source and speaker");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: own.items[0].id });
  saved = f.alarms.find(({ id }) => id === saved.id);
  assert.equal(saved.music.speaker, "");
  const payload = JSON.stringify({ catalog, second, own, state: f.dashboard.payload() });
  for (const secret of [DEMO_KIOSK_TOKEN, "library://radio/", "ma:bedroom", f.url]) assert.ok(!payload.includes(secret), secret);
  assert.equal(f.haCalls.length, 0);
  assert.ok(f.calls.every(({ name }) => !/Play|Start|Preview/.test(name)), "Browsing and saving never play audio");
});

test("the streamlined KS picker saves show-01 music without changing existing picks during browsing", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const ha = await f.kiosk.musicOptions({ source: "ha" });
  const legacy = await f.kiosk.musicOptions({ source: "ha", speaker: ha.speaker, category: "browse", parent: ha.items[0].id });
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music", music_station_id: legacy.items[0].id });
  const id = f.kiosk.snapshot().alarms[0].id;
  const native = () => f.alarms.find((alarm) => alarm.id === id);
  const before = structuredClone(native().music);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (typeof url !== "string" || !url.startsWith("./api/alarm/music?")) return originalFetch(url, options);
    const query = Object.fromEntries(new URL(url, "http://localhost").searchParams);
    return { ok: true, json: () => f.kiosk.musicOptions(query) };
  });
  const catalog = await kioskAlarmMusicOptions();
  assert.equal(catalog.source, "ma");
  assert.equal(catalog.speakers.find(({ id }) => id === catalog.speaker).name, "show-01");
  assert.deepEqual(native().music, before);
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), minute: 17 });
  assert.deepEqual(native().music, before, "Time edits retain saved source/speaker/music");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: catalog.items[0].id });
  assert.equal(native().music.source, "ma");
  assert.equal(native().music.speaker, "ma:show-01");
  assert.equal(native().music.speakerName, "show-01");
  assert.equal(f.kiosk.snapshot().alarms[0].music_speaker_name, "show-01");
  assert.equal(f.haCalls.length, 0);
  assert.ok(f.calls.every(({ name }) => !/Play|Start|Preview/.test(name)));
});

test("native music can browse HA folders, Sonos favorites and MA playlists without exposing source records", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const ha = await f.kiosk.musicOptions({ source: "ha" });
  assert.equal(ha.category, "browse");
  assert.equal(ha.items[0].playable, false);
  assert.equal(ha.items[0].expandable, true);
  const child = await f.kiosk.musicOptions({ source: "ha", speaker: ha.speaker, parent: ha.items[0].id, category: "browse" });
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music", music_station_id: child.items[0].id });
  assert.equal(f.alarms.at(-1).music.source, "ha");
  assert.equal(f.alarms.at(-1).music.speaker, "ha:media_player.kitchen");
  assert.equal(f.alarms.at(-1).music.item.raw.media_content_id, "media-source://radio/1");
  const sonos = await f.kiosk.musicOptions({ source: "sonos" });
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: sonos.items[0].id });
  assert.equal(f.alarms.at(-1).music.source, "sonos");
  const ma = await f.kiosk.musicOptions({ source: "ma", category: "playlists" });
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), music_station_id: ma.items[0].id });
  assert.equal(f.alarms.at(-1).music.item.kind, "playlist");
  const opened = await f.kiosk.musicOptions({ source: "ma", speaker: ma.speaker, category: "playlists", parent: ma.items[0].id });
  assert.equal(opened.items[0].kind, "track");
});

test("native tones save independently, preserve omitted choices and verify exact device results", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const options = await f.kiosk.soundOptions();
  const chosen = options.sounds.find(({ name }) => name === "Gentle Bells.ogg");
  let alarm = f.kiosk.snapshot().alarms[0];
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm), buzzer_sound_id: chosen.id });
  alarm = f.kiosk.snapshot().alarms[0];
  assert.equal(alarm.buzzer_sound_id, chosen.id);
  assert.equal(alarm.buzzer_sound_name, "Gentle Bells.ogg");
  assert.equal(f.alarms.at(-1).tone, "Gentle Bells.ogg");
  await f.dashboard.saveAlarm({ ...alarmSettings(alarm), minute: 17 });
  assert.equal(f.alarms.at(-1).tone, "Gentle Bells.ogg");
  f.mode.ignoreTone = true;
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), buzzer_sound_id: "builtin" }), /not confirmed/);
  f.mode.ignoreTone = false;
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), buzzer_sound_id: null });
  assert.equal(f.alarms.at(-1).tone, "");
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), buzzer_sound_id: "builtin" });
  assert.equal(f.alarms.at(-1).tone, "builtin");
});

test("expired, unavailable and malformed native choices fail before writing; saved schedules remain editable", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const music = await f.kiosk.musicOptions();
  const tones = await f.kiosk.soundOptions();
  const body = { ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music" };
  const count = () => f.calls.filter(({ name }) => name === "alarmSave").length;
  const before = count();
  for (const extra of [{ music_station_id: "invented" }, { music_station_id: {} }, { buzzer_sound_id: "../alarm.ogg" }, { buzzer_sound_id: undefined }]) {
    await assert.rejects(f.dashboard.saveAlarm({ ...body, ...extra }), /Select an available native/);
  }
  f.mode.speakerUnavailable = true;
  await assert.rejects(f.dashboard.saveAlarm({ ...body, music_station_id: music.items[0].id }), /speaker is unavailable/);
  f.mode.speakerUnavailable = false;
  f.sounds.splice(0, 1);
  await assert.rejects(f.dashboard.saveAlarm({ ...body, buzzer_sound_id: tones.sounds[2].id }), /no longer available/);
  assert.equal(count(), before);
  f.mode.musicUnavailable = true;
  f.mode.soundUnavailable = true;
  await assert.rejects(f.kiosk.musicOptions(), /Configure a Music Assistant/);
  await assert.rejects(f.kiosk.soundOptions(), /rejected listNotificationSounds/);
  await f.dashboard.saveAlarm({ ...body, minute: 19 });
  assert.equal(f.kiosk.connected, true);
  assert.equal(f.kiosk.snapshot().alarms[0].minute, 19);
  for (const params of [{ source: "plugin" }, { source: "ma", speaker: "invented" }, { source: "ma", parent: "invented" }, { offset: "-1" }, { offset: "1.5" }, { command: "playSound" }]) {
    await assert.rejects(f.kiosk.musicOptions(params), { name: "Error" });
  }
});

test("native choices survive server restart by retaining the saved source and speaker identity", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const catalog = await f.kiosk.musicOptions();
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music", music_station_id: catalog.items[0].id });
  const restarted = new KioskAlarms({ url: f.url, token: DEMO_KIOSK_TOKEN, logger: { warn() {} } });
  await restarted.refresh();
  const saved = restarted.snapshot().alarms[0];
  const refreshed = await restarted.musicOptions({ source: saved.music_source, speaker: saved.music_speaker_id });
  assert.equal(refreshed.speaker, saved.music_speaker_id);
  assert.equal(refreshed.items[0].id, saved.music_station_id);
  f.mode.ignoreMusic = true;
  await assert.rejects(restarted.save({ ...alarmSettings(saved), music_station_id: null }), /not confirmed/);
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
  await assert.rejects(f.dashboard.saveAlarm({ ...alarmSettings(alarm), buzzer_sound_id: "classic" }), /Select an available native buzzer/);
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
  const choices = await f.kiosk.soundOptions();
  await f.dashboard.saveAlarm({ ...alarmSettings(f.kiosk.snapshot().alarms[0]), buzzer_sound_id: choices.sounds[2].id });
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
  assert.equal(restored.alarms.alarms[0].buzzer_sound_id, choices.sounds[2].id);
  assert.equal(restored.alarms.alarms[0].buzzer_sound_name, "Gentle Bells.ogg");
  assert.equal(restored.alarms.alarms[0].can_select_sound, false);
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

test("native catalog HTTP routes validate reads and expose no raw records or playback commands", async (t) => {
  const f = await setup(t);
  const server = createServer({ dashboard: f.dashboard, webRoot: "", logger: { warn() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const get = (path) => fetch(`http://127.0.0.1:${server.address().port}/api/alarm/${path}`);
  f.offline();
  f.dashboard.readOnly = true;
  for (const path of ["music", "sounds"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    const text = JSON.stringify(await response.json());
    for (const secret of [DEMO_KIOSK_TOKEN, "library://", "ma:bedroom", f.url]) assert.ok(!text.includes(secret), secret);
  }
  for (const path of ["music?source=ma&source=ha", "music?source=invalid", "music?offset=-1", "sounds?command=playSound"]) {
    assert.equal((await get(path)).status, 400, path);
  }
  const original = f.dashboard.kiosk;
  f.dashboard.kiosk = null;
  assert.equal((await get("music")).status, 409);
  f.dashboard.kiosk = original;
  assert.ok(f.calls.every(({ name }) => !/Play|Start|Preview/.test(name)));
});

test("malformed catalogs, vanished sources and a ring during validation cannot mutate an alarm", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const catalog = await f.kiosk.musicOptions();
  const original = f.kiosk.command.bind(f.kiosk);
  const body = { ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music", music_station_id: catalog.items[0].id };
  const before = f.calls.filter(({ name }) => name === "alarmSave").length;
  f.kiosk.command = async (name, ...args) => name === "libraryPickerSource"
    ? { source: "ha", sources: ["ha"], speakers: [], categories: [] } : original(name, ...args);
  await assert.rejects(f.kiosk.musicOptions({ source: "ma" }), /invalid or unsupported/);
  await assert.rejects(f.dashboard.saveAlarm(body), /source or speaker is unavailable/);
  f.kiosk.command = async (name, ...args) => name === "listNotificationSounds" ? { sounds: ["../alarm.wav"] } : original(name, ...args);
  await assert.rejects(f.kiosk.soundOptions(), /invalid sound catalog/);
  f.kiosk.command = async (name, ...args) => {
    const result = await original(name, ...args);
    if (name === "libraryPickerSource") { f.mode.phase = "ringing"; f.mode.ids = [body.id]; }
    return result;
  };
  await assert.rejects(f.dashboard.saveAlarm(body), /Stop this alarm/);
  assert.equal(f.calls.filter(({ name }) => name === "alarmSave").length, before);
});

test("losing native status after catalog validation cannot write using stale alarm definitions", async (t) => {
  const f = await setup(t);
  await f.dashboard.createAlarm({});
  const catalog = await f.kiosk.musicOptions();
  const original = f.kiosk.command.bind(f.kiosk);
  f.kiosk.command = async (name, ...args) => {
    const result = await original(name, ...args);
    if (name === "libraryPickerSource") f.mode.unavailable = true;
    return result;
  };
  await assert.rejects(f.dashboard.saveAlarm({
    ...alarmSettings(f.kiosk.snapshot().alarms[0]), type: "Music", music_station_id: catalog.items[0].id,
  }), { status: 503 });
  assert.equal(f.calls.filter(({ name }) => name === "alarmSave").length, 1, "Only the initial disabled draft may have been written");
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
