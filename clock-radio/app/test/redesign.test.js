import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDemoAPI, DEMO_HA_TOKEN, DEMO_MA_TOKEN } from "../dev/fixtures.js";
import { HAClient } from "../src/ha-client.js";
import { ConfigStore, parseConfig } from "../src/config.js";
import { MusicService, validPlayUri } from "../src/music.js";
import { imageSource, pickImage } from "../src/ma-api.js";
import { RadioLibrary } from "../src/radio-library.js";
import { Dashboard } from "../src/dashboard.js";
import { createServer, staticAsset } from "../src/server.js";
import { alarmSnapshot, saveAlarm, validateAlarm, validatePlaybackSettings } from "../src/alarms.js";
import { CLOCK_DEFAULTS, parseClockOptions } from "../web/js/lib/clock-options.js";
import { ClockData, alarmEntityAt, nextAlarmAt, nightEntityActive } from "../src/clock-data.js";
import { makeTranslator, format } from "../web/js/lib/i18n.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const quiet = { warn() {}, debug() {} };
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

async function setup(t, options = {}) {
  const mock = createDemoAPI(options);
  const haUrl = await listen(mock.server);
  t.after(async () => {
    for (const client of mock.ws.clients) client.terminate();
    mock.ws.close();
    await close(mock.server);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-redesign-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const store = new ConfigStore({ dir, example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  const ha = new HAClient({ url: haUrl, token: DEMO_HA_TOKEN });
  const music = new MusicService({ ha, logger: quiet, url: `${haUrl}/ma`, token: DEMO_MA_TOKEN });
  const radio = new RadioLibrary({ ha, music, logger: quiet });
  const dashboard = new Dashboard({ ha, configStore: store, music, radio, mediaPlayer: "media_player.bedroom", weatherEntity: "weather.bedroom", sunEntity: options.sunEntity, logger: quiet, version: "test" });
  await dashboard.refresh();
  const server = createServer({ dashboard, webRoot: path.join(root, "web"), logger: quiet });
  const url = await listen(server);
  t.after(() => close(server));
  const get = async (route) => (await fetch(`${url}/${route}`)).json();
  const post = (route, body, headers = {}) => fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...mock, ha, store, music, radio, dashboard, get, post, url };
}

test("Delete removes native profiles, preserves unrelated helpers and persistently hides both bundled alarms", async (t) => {
  const app = await setup(t);
  for (const id of [3, 4]) assert.equal((await (await app.post("api/alarm/create", {})).json()).alarm_id, id);
  await app.ha.requestWs({ type: "input_boolean/create", name: "Unrelated switch" });
  const other = (await app.get("api/state")).alarms.alarms.find((alarm) => alarm.id === 4);
  const ordinaryPlayer = JSON.stringify(app.states.find((state) => state.entity_id === "media_player.bedroom"));
  for (const id of [1, 2, 3]) {
    const response = await app.post("api/alarm/delete", { id });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deleted_alarm_id: id });
    assert.ok(!(await app.get("api/state")).alarms.alarms.some((alarm) => alarm.id === id));
  }
  assert.equal(app.helperDeletions.length, 16);
  assert.ok(app.helperDeletions.every((request) => Object.values(request).some((value) => typeof value === "string" && /^clock_radio_alarm_3(?:_|$)/.test(value))));
  assert.ok(app.states.some((state) => state.entity_id === "input_boolean.unrelated_switch"));
  assert.deepEqual((await app.get("api/state")).alarms.alarms.find((alarm) => alarm.id === 4), other);
  assert.equal(JSON.stringify(app.states.find((state) => state.entity_id === "media_player.bedroom")), ordinaryPlayer);
  for (const id of [1, 2]) {
    assert.equal(app.states.find((state) => state.entity_id === `input_boolean.clock_radio_alarm_${id}_deleted`).state, "on");
    assert.ok(app.states.some((state) => state.entity_id === `input_number.clock_radio_alarm_${id}_hour`));
  }
  assert.ok(!alarmSnapshot(JSON.parse(JSON.stringify(app.states))).alarms.some((alarm) => alarm.id <= 2), "Deletion survives a fresh HA snapshot, not just browser state");
  assert.equal((await app.post("api/alarm/delete", { id: 4 })).status, 200);
  assert.deepEqual((await app.get("api/state")).alarms.alarms, []);
  const added = await (await app.post("api/alarm/create", {})).json();
  assert.equal(added.alarm_id, 3, "Adding after deleting every profile still uses a valid, unoccupied native ID");
  const fresh = (await app.get("api/state")).alarms.alarms[0];
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.hour, 6);
  assert.equal(fresh.volume, 50);
});

test("deleting ringing Music and Buzzer alarms restores the speaker and removes their timers", async (t) => {
  const app = await setup(t);
  const player = app.states.find((state) => state.entity_id === "media_player.bedroom");
  const previous = { volume: player.attributes.volume_level, repeat: player.attributes.repeat };
  for (const type of ["Music", "Buzzer"]) {
    const id = (await (await app.post("api/alarm/create", {})).json()).alarm_id;
    app.startAlarm(id, type);
    await app.dashboard.refresh();
    assert.equal((await app.get("api/state")).alarms.active.type, type);
    assert.equal((await app.post("api/alarm/delete", { id })).status, 200);
    assert.equal(player.state, "idle");
    assert.equal(player.attributes.volume_level, previous.volume);
    assert.equal(player.attributes.repeat, previous.repeat);
    const state = await app.get("api/state");
    assert.equal(state.alarms.active, null);
    assert.equal(state.alarms.snoozed, null);
    assert.ok(!app.states.some((item) => item.entity_id === `timer.clock_radio_alarm_${id}`));
    assert.throws(() => app.startAlarm(id, type), /Invalid demo alarm/);
  }
});

test("deleting a snoozed alarm cancels its deadline while deleting another profile leaves ringing/snoozed alarms alone", async (t) => {
  const app = await setup(t);
  let id = (await (await app.post("api/alarm/create", {})).json()).alarm_id;
  app.startAlarm(id);
  await app.dashboard.refresh();
  assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
  assert.equal((await app.post("api/alarm/delete", { id })).status, 200);
  app.advanceAlarms(Date.now() + 700000);
  assert.equal(alarmSnapshot(app.states).active, null);
  assert.equal(alarmSnapshot(app.states).snoozed, null);
  id = (await (await app.post("api/alarm/create", {})).json()).alarm_id;
  app.startAlarm(1);
  await app.dashboard.refresh();
  const ringing = JSON.stringify(alarmSnapshot(app.states).active);
  assert.equal((await app.post("api/alarm/delete", { id })).status, 200);
  assert.equal(JSON.stringify(alarmSnapshot(app.states).active), ringing);
  assert.equal(app.states.find((state) => state.entity_id === "media_player.bedroom").state, "playing");
  id = (await (await app.post("api/alarm/create", {})).json()).alarm_id;
  assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
  const snoozed = JSON.stringify(alarmSnapshot(app.states).snoozed);
  assert.equal((await app.post("api/alarm/delete", { id })).status, 200);
  assert.equal(JSON.stringify(alarmSnapshot(app.states).snoozed), snoozed);
  app.advanceAlarms(Date.now() + 700000);
  assert.equal(alarmSnapshot(app.states).active.id, 1);
});

test("partial native helper deletion stays visible and disabled, blocks resurrection and resumes without re-deleting helpers", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  const saved = (await app.get("api/state")).alarms.alarms.find((alarm) => alarm.id === 3);
  const ws = app.ha.requestWs.bind(app.ha);
  let requests = 0;
  app.ha.requestWs = async (message) => {
    if (message.type.endsWith("/delete") && ++requests === 3) throw new Error("Simulated native helper deletion failure");
    return ws(message);
  };
  const failed = await app.post("api/alarm/delete", { id: 3 });
  assert.equal(failed.status, 502);
  const error = (await failed.json()).error;
  assert.match(error, /^Alarm deletion failed:/);
  assert.match(error, /retry Delete/);
  let state = await app.get("api/state");
  const pending = state.alarms.alarms.find((alarm) => alarm.id === 3);
  assert.equal(state.alarms.deleting, 3);
  assert.equal(pending.deletion_pending, true);
  assert.equal(pending.enabled, false);
  assert.equal(pending.available, false);
  assert.equal(state.alarms.can_create, false);
  const values = { id: 3, enabled: true, type: saved.type, hour: saved.hour, minute: saved.minute, volume: saved.volume, duration: saved.duration, days: saved.days };
  assert.equal((await app.post("api/settings/alarm", values)).status, 409);
  assert.equal((await app.post("api/alarm/create", {})).status, 409);
  assert.equal((await app.post("api/alarm/delete", { id: 1 })).status, 409);
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 200);
  state = await app.get("api/state");
  assert.equal(state.alarms.deleting, null);
  assert.ok(!state.alarms.alarms.some((alarm) => alarm.id === 3));
  assert.equal(app.helperDeletions.length, 16, "Only the remaining helpers are deleted on retry");
});

test("Delete will not remove helpers after incomplete speaker cleanup or a success-shaped no-op preparation", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  app.startAlarm(3);
  await app.dashboard.refresh();
  const call = app.ha.callService.bind(app.ha);
  let failure = "cleanup";
  app.ha.callService = async (...args) => {
    if (args[0] === "script" && args[1] === "clock_radio_prepare_delete") {
      assert.deepEqual(args[3], { timeout: 60000 }, "The bounded HA preparation wait must not inherit the ordinary eight-second HTTP timeout");
      if (failure === "cleanup") {
        app.states.find((state) => state.entity_id === "input_text.clock_radio_deleting_alarm").state = "3";
        app.states.find((state) => state.entity_id === "timer.clock_radio_alarm_3").state = "idle";
        throw new Error("Speaker cleanup failed");
      }
      if (failure === "noop") return [];
    }
    return call(...args);
  };
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 502);
  assert.equal(app.helperDeletions.length, 0);
  assert.equal((await app.get("api/state")).alarms.active.id, 3, "Idle timer is not proof that the speaker was stopped");
  failure = "noop";
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 502);
  assert.equal(app.helperDeletions.length, 0);
  failure = null;
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 200);
  assert.equal(app.helperDeletions.length, 16);
});

test("a failed bundled deletion commit remains recoverable even after its deleted flag was set", async (t) => {
  const app = await setup(t);
  const call = app.ha.callService.bind(app.ha);
  let fail = true;
  app.ha.callService = (...args) => {
    if (fail && args[0] === "input_text" && args[2].entity_id === "input_text.clock_radio_deleting_alarm" && args[2].value === "") {
      fail = false;
      throw new Error("Could not finish deletion");
    }
    return call(...args);
  };
  assert.equal((await app.post("api/alarm/delete", { id: 1 })).status, 502);
  const pending = (await app.get("api/state")).alarms.alarms.find((alarm) => alarm.id === 1);
  assert.equal(pending.deletion_pending, true);
  assert.equal(app.states.find((state) => state.entity_id === "input_boolean.clock_radio_alarm_1_deleted").state, "on");
  assert.equal((await app.post("api/alarm/delete", { id: 1 })).status, 200);
  assert.ok(!(await app.get("api/state")).alarms.alarms.some((alarm) => alarm.id === 1));
});

test("native deletion uses registry storage IDs rather than guessing IDs from entity names", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  const ws = app.ha.requestWs.bind(app.ha);
  const seen = [];
  app.ha.requestWs = async (message) => {
    if (message.type.endsWith("/delete")) {
      const domain = message.type.split("/")[0];
      const key = `${domain}_id`;
      seen.push(message[key]);
      return ws({ ...message, [key]: message[key].slice("storage-".length) });
    }
    const result = await ws(message);
    if (message.type === "config/entity_registry/list") return result.map((entry) => entry.entity_id.includes("clock_radio_alarm_3") ? { ...entry, unique_id: `storage-${entry.unique_id}` } : entry);
    if (message.type.endsWith("/list") && message.type !== "config/entity_registry/list") return result.map((item) => ({ ...item, id: `storage-${item.id}` }));
    return result;
  };
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 200);
  assert.equal(seen.length, 16);
  assert.ok(seen.every((id) => id.startsWith("storage-")));
});

test("Delete validates IDs/methods, gates old packages and rejects malformed helper metadata before mutation", async (t) => {
  const app = await setup(t);
  assert.equal((await fetch(`${app.url}/api/alarm/delete`)).status, 405);
  for (const body of [{}, [], null, { id: 0 }, { id: -1 }, { id: "1" }, { id: 1.5 }, { id: 1, extra: true }, { id: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal((await app.post("api/alarm/delete", body)).status, 400);
  assert.equal((await app.post("api/alarm/delete", { id: 999 })).status, 404);
  const version = app.states.find((state) => state.entity_id === "sensor.clock_radio_alarm_scheduler_version");
  version.state = "3";
  assert.equal((await app.post("api/alarm/delete", { id: 1 })).status, 409);
  version.state = "4";
  app.states.find((state) => state.entity_id === "input_text.clock_radio_deleting_alarm").state = "invalid";
  const invalid = await app.post("api/alarm/delete", { id: 1 });
  assert.equal(invalid.status, 409);
  assert.match((await invalid.json()).error, /deletion state/);
  app.states.find((state) => state.entity_id === "input_text.clock_radio_deleting_alarm").state = "";
  await app.post("api/alarm/create", {});
  const ws = app.ha.requestWs.bind(app.ha);
  for (const items of [[{}], [null]]) {
    app.ha.requestWs = (message) => message.type === "input_boolean/list" ? Promise.resolve(items) : ws(message);
    const invalid = await app.post("api/alarm/delete", { id: 3 });
    assert.equal(invalid.status, 502);
    assert.match((await invalid.json()).error, /invalid input_boolean helper list/);
  }
  app.ha.requestWs = (message) => message.type === "config/entity_registry/list" ? Promise.resolve([null]) : ws(message);
  const registry = await app.post("api/alarm/delete", { id: 3 });
  assert.equal(registry.status, 502);
  assert.match((await registry.json()).error, /invalid entity registry/);
  assert.equal(app.helperDeletions.length, 0);
  assert.equal(app.states.find((state) => state.entity_id === "input_text.clock_radio_deleting_alarm").state, "");
});

test("Delete serializes against edits, creation, shared playback and stop/snooze commands", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  const call = app.ha.callService.bind(app.ha);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  app.ha.callService = async (...args) => {
    if (args[1] === "clock_radio_prepare_delete") {
      assert.deepEqual(args[3], { timeout: 60000 });
      entered();
      await gate;
    }
    return call(...args);
  };
  const refresh = app.dashboard.refresh.bind(app.dashboard);
  let checkedFinalRefresh = false;
  app.dashboard.refresh = () => {
    if (app.helperDeletions.length === 16) {
      assert.ok(app.dashboard.alarmWrites.has("delete"), "Deletion remains locked through the final fresh snapshot");
      checkedFinalRefresh = true;
    }
    return refresh();
  };
  const operation = app.post("api/alarm/delete", { id: 3 });
  await started;
  try {
    for (const [route, body] of [["api/alarm/delete", { id: 1 }], ["api/alarm/create", {}], ["api/alarm/stop", {}], ["api/alarm/snooze", {}]]) assert.equal((await app.post(route, body)).status, 409);
    const alarm = (await app.get("api/state")).alarms.alarms[0];
    const values = { id: alarm.id, enabled: false, type: alarm.type, hour: alarm.hour, minute: alarm.minute, volume: alarm.volume, duration: alarm.duration, days: alarm.days };
    assert.equal((await app.post("api/settings/alarm", values)).status, 409);
    assert.equal((await app.post("api/settings/alarm-playback", { player: "media_player.bedroom", music_source: "library://radio/1", buzzer_source: "https://example.com/beep.mp3" })).status, 409);
  } finally { release(); }
  assert.equal((await operation).status, 200);
  assert.equal(checkedFinalRefresh, true);
  assert.equal(app.dashboard.alarmWrites.size, 0);
});

test("all clock layouts and options validate; legacy YAML stays compatible", () => {
  for (const face of ["analog", "analog-round", "digital"]) {
    for (const widget of ["calendar", "weather", "date", "date-calendar", "none"]) {
      const clock = parseClockOptions({ face, widget });
      assert.equal(clock.face, face);
      assert.equal(clock.widget, widget);
    }
  }
  for (const full_face of ["analog", "digital"]) assert.equal(parseClockOptions({ layout: "full", full_face }).full_face, full_face);
  const legacy = parseConfig({ show_seconds: false, clock_24h: false });
  assert.equal(legacy.clock.seconds, false);
  assert.equal(legacy.clock.time_format, "12-hour");
  for (const bad of [{ layout: "unknown" }, { face: "other" }, { seconds: "true" }, { night_brightness: 19 }, { night_brightness: 101 }, { night_start: 24 }, { night_threshold: -1 }, { primary: "red" }, { weather_entity: "light.room" }, { unknown: 1 }]) {
    assert.throws(() => parseClockOptions(bad));
  }
});

test("alarm radio choices come only from MA, include preset duplicates, and work without MA browsing credentials", async (t) => {
  const app = await setup(t);
  app.music.client.baseUrl = "";
  app.music.client.token = "";
  app.radio.updatedAt = 0;
  await app.dashboard.refresh();
  app.store.current.stations.push({ id: "same-as-ma", name: "Configured duplicate", media_content_id: app.radio.stations[0].uri });
  const state = app.dashboard.payload();
  assert.equal(state.music.library, false);
  assert.equal(state.alarms.radio_error, null);
  assert.equal(state.alarms.radio_stations.length, app.library.radio.length);
  assert.ok(!state.music.stations.some((station) => station.id === app.radio.stations[0].id), "The music page deduplicates presets; alarm selection must still include that MA radio");
  assert.deepEqual(state.alarms.radio_stations.map((station) => station.id), app.radio.stations.map((station) => station.id));
  assert.ok(state.alarms.radio_stations.every((station) => /^ma-[a-f0-9]{16}$/.test(station.id)));
  assert.ok(state.alarms.radio_stations.every((station) => !Object.hasOwn(station, "uri") && station.image.startsWith("api/music/image/")));
  const { id, type, hour, minute, volume, duration, days } = state.alarms.alarms[0];
  const settings = { id, type, hour, minute, volume, duration, days, enabled: false, music_station_id: state.alarms.radio_stations[1].id };
  assert.equal((await app.post("api/settings/alarm", settings)).status, 200);
});

test("each alarm saves its own station without playing music, and retains it through Buzzer, switches and shared-source edits", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  const base = (id) => {
    const { type, hour, minute, volume, duration, days } = app.dashboard.payload().alarms.alarms.find((alarm) => alarm.id === id);
    return { id, enabled: true, type, hour, minute, volume, duration, days };
  };
  const [first, second] = app.radio.stations;
  const before = app.calls.length;
  for (const [id, station] of [[1, first], [2, second], [3, second]]) {
    assert.equal((await app.post("api/settings/alarm", { ...base(id), type: "Music", music_station_id: station.id })).status, 200);
  }
  assert.ok(!app.calls.slice(before).some((call) => call.domain === "media_player" || call.domain === "script" || call.domain === "music_assistant"), "Saving must never preview/play a radio");
  let state = await app.get("api/state");
  assert.deepEqual(state.alarms.alarms.map((alarm) => alarm.music_station_id), [first.id, second.id, second.id]);
  assert.equal(state.alarms.music_source, "library://radio/1", "The shared source is not rewritten");
  assert.equal(app.states.find((s) => s.entity_id === "input_text.clock_radio_alarm_3_music_source").state, second.uri);
  assert.equal((await app.post("api/settings/alarm", { ...base(2), type: "Buzzer" })).status, 200);
  app.startAlarm(2);
  assert.equal(app.states.find((s) => s.entity_id === "media_player.bedroom").attributes.media_content_id, state.alarms.buzzer_source);
  assert.equal((await app.post("api/settings/alarm", { ...base(2), type: "Music", enabled: false })).status, 200);
  await app.ha.callService("input_text", "set_value", { entity_id: "input_text.clock_radio_music_source", value: first.uri });
  app.startAlarm(2);
  assert.equal(app.states.find((s) => s.entity_id === "media_player.bedroom").attributes.media_content_id, second.uri);
  await app.dashboard.refresh();
  state = await app.get("api/state");
  assert.equal(state.alarms.alarms[1].music_station_id, second.id);
  assert.ok(!Object.hasOwn(state.alarms.alarms[1], "music_source"), "Raw per-alarm sources stay server-side");
  assert.equal((await app.post("api/settings/alarm", { ...base(2), music_station_id: null })).status, 200);
  assert.equal((await app.get("api/state")).alarms.alarms[1].music_source_set, false);
  app.startAlarm(2);
  assert.equal(app.states.find((s) => s.entity_id === "media_player.bedroom").attributes.media_content_id, first.uri);
});

test("Snooze and native helper deletion use the selected station without rewriting another profile", async (t) => {
  const app = await setup(t);
  await app.post("api/alarm/create", {});
  const alarm = (await app.get("api/state")).alarms.alarms[2];
  const { id, type, hour, minute, volume, duration, days } = alarm;
  const selected = app.radio.stations[1];
  assert.equal((await app.post("api/settings/alarm", { id, type, hour, minute, volume, duration, days, enabled: false, music_station_id: selected.id })).status, 200);
  app.startAlarm(3);
  assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
  app.advanceAlarms(Date.now() + 601000);
  assert.equal(app.states.find((s) => s.entity_id === "media_player.bedroom").attributes.media_content_id, selected.uri);
  assert.equal((await app.post("api/alarm/delete", { id: 3 })).status, 200);
  assert.ok(app.helperDeletions.some((request) => request.type === "input_text/delete" && request.input_text_id === "clock_radio_alarm_3_music_source"));
  assert.equal(app.states.find((s) => s.entity_id === "input_text.clock_radio_alarm_1_music_source").state, "");
});

test("old packages preserve existing edits and sources but cannot save per-alarm stations", async (t) => {
  const app = await setup(t);
  const { id, type, hour, minute, volume, duration, days } = app.dashboard.payload().alarms.alarms[0];
  const settings = { id, type, hour, minute, volume, duration, days, enabled: false };
  const version = app.states.find((s) => s.entity_id === "sensor.clock_radio_alarm_scheduler_version");
  for (const value of ["2", "3", "4"]) {
    version.state = value;
    const before = app.calls.length;
    assert.equal((await app.post("api/settings/alarm", { ...settings, music_station_id: app.radio.stations[0].id })).status, 409);
    assert.equal(app.calls.length, before);
    assert.equal((await app.post("api/settings/alarm", settings)).status, 200);
    assert.equal((await app.get("api/state")).alarms.alarms[0].can_select_radio, false);
  }
  await app.post("api/alarm/create", {});
  assert.equal(app.helperRequests.length, 15, "Legacy helper creation is unchanged");
  assert.ok(!app.states.some((s) => s.entity_id === "input_text.clock_radio_alarm_3_music_source"));
  version.state = "5";
  const native = (await app.get("api/state")).alarms.alarms[2];
  const values = { ...settings, id: 3, days: native.days, music_station_id: app.radio.stations[1].id };
  assert.equal((await app.post("api/settings/alarm", values)).status, 200);
  assert.equal(app.helperRequests.length, 16, "An old native profile gets its missing source helper on first selection");
  assert.equal(app.helperRequests.at(-1).type, "input_text/create");
  assert.equal((await app.post("api/settings/alarm", values)).status, 200);
  assert.equal(app.helperRequests.length, 16, "Retry never duplicates the helper");
});

test("station validation rejects stale IDs, arbitrary URIs, unsupported sources and unavailable helpers before writes", async (t) => {
  const app = await setup(t);
  const { id, type, hour, minute, volume, duration, days } = app.dashboard.payload().alarms.alarms[0];
  const settings = { id, type, hour, minute, volume, duration, days, enabled: false };
  const before = app.calls.length;
  for (const invalid of ["https://example.com", "", [], {}, 1, true]) {
    assert.equal((await app.post("api/settings/alarm", { ...settings, music_station_id: invalid })).status, 400);
  }
  assert.equal((await app.post("api/settings/alarm", { ...settings, music_station_id: "ma-0000000000000000" })).status, 409);
  const station = app.radio.stations[0];
  const original = station.uri;
  for (const uri of ["javascript:alert(1)", "https://[bad", "https://example.com/" + "x".repeat(256), "https://user:pass@example.com/"]) {
    station.uri = uri;
    assert.equal((await app.post("api/settings/alarm", { ...settings, music_station_id: station.id })).status, 400);
  }
  station.uri = original;
  app.states.find((s) => s.entity_id === "input_text.clock_radio_alarm_1_music_source").state = "unavailable";
  const response = await app.post("api/settings/alarm", { ...settings, music_station_id: station.id });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /radio helper.*unavailable/);
  assert.equal(app.calls.length, before);
});

test("radio-library failures remain explicit but do not prevent unrelated alarm edits or clearing an override", async (t) => {
  const app = await setup(t);
  const { id, type, hour, minute, volume, duration, days } = app.dashboard.payload().alarms.alarms[0];
  const settings = { id, type, hour, minute, volume, duration, days, enabled: false };
  app.states.find((s) => s.entity_id === "input_text.clock_radio_alarm_1_music_source").state = "library://radio/deleted";
  app.radio.error = "Radio library unavailable: demo offline";
  const blocked = await app.post("api/settings/alarm", { ...settings, music_station_id: app.radio.stations[0].id });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /demo offline/);
  assert.equal((await app.post("api/settings/alarm", settings)).status, 200);
  const saved = (await app.get("api/state")).alarms;
  assert.equal(saved.radio_error, app.radio.error);
  assert.equal(saved.alarms[0].music_source_set, true);
  assert.equal(saved.alarms[0].music_station_id, null);
  assert.equal((await app.post("api/settings/alarm", { ...settings, music_station_id: null })).status, 200);
  assert.equal(app.states.find((s) => s.entity_id === "input_text.clock_radio_alarm_1_music_source").state, "");
});

test("radio writes fail explicitly with a disabled schedule, and native migration requires admin permission", async (t) => {
  const app = await setup(t);
  const { type, hour, minute, volume, duration, days } = app.dashboard.payload().alarms.alarms[0];
  const settings = { id: 1, type, hour, minute, volume, duration, days, enabled: true, music_station_id: app.radio.stations[1].id };
  const call = app.ha.callService.bind(app.ha);
  app.ha.callService = (...args) => {
    if (args[2]?.entity_id === "input_text.clock_radio_alarm_1_music_source") throw new Error("Radio helper denied");
    return call(...args);
  };
  assert.equal((await app.post("api/settings/alarm", settings)).status, 502);
  assert.equal((await app.get("api/state")).alarms.alarms[0].enabled, false);
  app.ha.callService = call;
  app.states.find((s) => s.entity_id === "sensor.clock_radio_alarm_scheduler_version").state = "4";
  await app.post("api/alarm/create", {});
  app.states.find((s) => s.entity_id === "sensor.clock_radio_alarm_scheduler_version").state = "5";
  const request = app.ha.requestWs.bind(app.ha);
  app.ha.requestWs = (message) => {
    if (message.type === "input_text/create") throw new Error("Native helper creation denied");
    return request(message);
  };
  const failed = await app.post("api/settings/alarm", { ...settings, id: 3 });
  assert.equal(failed.status, 502);
  assert.equal((await app.get("api/state")).alarms.alarms[2].enabled, false);
  assert.ok(!app.states.some((s) => s.entity_id === "input_text.clock_radio_alarm_3_music_source"));
  app.ha.requestWs = request;
  assert.equal((await app.post("api/settings/alarm", { ...settings, id: 3 })).status, 200);
});

test("night entity thresholds use hysteresis and retain state while unavailable", () => {
  const settings = { night_threshold: 10, night_mode: "illuminance" };
  assert.equal(nightEntityActive({ state: "9" }, settings, false), true);
  assert.equal(nightEntityActive({ state: "11" }, settings, false), false);
  assert.equal(nightEntityActive({ state: "11" }, settings, true), true);
  assert.equal(nightEntityActive({ state: "13" }, settings, true), false);
  assert.equal(nightEntityActive({ state: "unavailable" }, settings, true), true);
  assert.equal(nightEntityActive(undefined, settings, false), false);
  assert.equal(nightEntityActive({ state: "on" }, settings), true);
  assert.equal(nightEntityActive({ state: "below_horizon" }, settings), true);
  assert.equal(nightEntityActive({ state: "off" }, settings, true), false);
});

test("Sun mode only follows HA horizon states and retains its last state on invalid data", () => {
  const settings = { night_mode: "sun", night_threshold: 10000 };
  assert.equal(parseClockOptions({ night_mode: "sun" }).night_entity, "");
  assert.equal(nightEntityActive({ state: "below_horizon" }, settings), true);
  assert.equal(nightEntityActive({ state: "above_horizon" }, settings, true), false);
  for (const state of [undefined, { state: "unavailable" }, { state: "unknown" }, { state: "" }, { state: "on" }, { state: "0" }]) {
    assert.equal(nightEntityActive(state, settings, true), true);
    assert.equal(nightEntityActive(state, settings, false), false);
  }
});

test("Sun night mode saves without an entity selector, survives restart and follows live HA horizon changes", async (t) => {
  const app = await setup(t);
  const state = await app.get("api/state");
  const settings = { ...state.config.clock, night_mode: "sun", night_entity: "input_boolean.bedroom_night", night_color: "#772211", night_brightness: 40 };
  assert.equal((await app.post("api/settings/clock", settings)).status, 200);
  const sun = app.states.find((entity) => entity.entity_id === "sun.sun");
  const payload = () => app.dashboard.payload().clock;
  assert.equal(payload().night, "entity", "The renderer receives its existing live-entity mode");
  assert.equal(payload().nightActive, false);
  sun.state = "below_horizon";
  await app.dashboard.refresh();
  assert.equal(payload().nightActive, true);
  assert.equal(payload().nightColor, "#772211");
  assert.equal(payload().nightBrightness, 40);
  assert.equal(payload().night_error, null);
  assert.equal(app.states.find((entity) => entity.entity_id === "input_boolean.bedroom_night").state, "off", "Sun mode ignores a previously selected night entity");
  const reopened = new ConfigStore({ dir: path.dirname(app.store.file), example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  assert.equal(reopened.current.clock.night_mode, "sun");
  const restarted = new Dashboard({ ha: app.ha, configStore: reopened, mediaPlayer: "media_player.bedroom", logger: quiet });
  await restarted.refresh();
  assert.equal(restarted.payload().clock.nightActive, true);
  for (const invalid of ["unavailable", "unknown", "on", "0"]) {
    sun.state = invalid;
    await app.dashboard.refresh();
    assert.equal(payload().nightActive, true);
    assert.match(payload().night_error, /sun.sun/);
  }
  app.states.splice(app.states.indexOf(sun), 1);
  await app.dashboard.refresh();
  assert.equal(payload().nightActive, true);
  assert.match(payload().night_error, /Sun integration/);
  app.states.push(sun);
  sun.state = "above_horizon";
  await app.dashboard.refresh();
  assert.equal(payload().nightActive, false);
  assert.equal(payload().night_error, null);
  const missing = new ClockData({ ha: app.ha, logger: quiet });
  const noSun = app.states.filter((entity) => entity.entity_id !== "sun.sun");
  await missing.refresh(reopened.current, noSun, "Europe/Copenhagen");
  assert.equal(missing.payload(reopened.current, { alarms: [] }, noSun, "Europe/Copenhagen").nightActive, false);
});

test("Sun night mode uses the HA app's configured entity across saves and restart without falling back", async (t) => {
  const app = await setup(t, { sunEntity: "sun.bedroom" });
  const custom = { entity_id: "sun.bedroom", state: "below_horizon", attributes: {} };
  app.states.push(custom);
  let state = await app.get("api/state");
  assert.equal(state.config.sun_entity, "sun.bedroom");
  assert.equal((await app.post("api/settings/clock", { ...state.config.clock, night_mode: "sun" })).status, 200);
  state = await app.get("api/state");
  assert.equal(state.clock.nightActive, true, "The configured sun wins over sun.sun's above_horizon state");
  assert.equal(state.clock.night_error, null);
  assert.ok(!fs.readFileSync(app.store.file, "utf8").includes("sun_entity"), "Appearance saves do not persist the HA app option in YAML");
  const before = fs.readFileSync(app.store.file, "utf8");
  assert.equal((await app.post("api/settings/clock", { ...state.config.clock, sun_entity: "sun.sun" })).status, 400);
  assert.equal(fs.readFileSync(app.store.file, "utf8"), before);

  const reopened = new ConfigStore({ dir: path.dirname(app.store.file), example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  const restarted = new Dashboard({ ha: app.ha, configStore: reopened, sunEntity: "sun.bedroom", logger: quiet });
  await restarted.refresh();
  assert.equal(restarted.payload().clock.nightActive, true);
  for (const invalid of ["unknown", "unavailable", "on", "0", ""]) {
    custom.state = invalid;
    await app.dashboard.refresh();
    const clock = app.dashboard.payload().clock;
    assert.equal(clock.nightActive, true);
    assert.match(clock.night_error, /sun.bedroom.*missing, unavailable or invalid/);
    assert.match(clock.night_error, /sun_entity in the HA app configuration/);
  }
  app.states.splice(app.states.indexOf(custom), 1);
  await app.dashboard.refresh();
  assert.equal(app.dashboard.payload().clock.nightActive, true);
  const initialMissing = new Dashboard({ ha: app.ha, configStore: reopened, sunEntity: "sun.bedroom", logger: quiet });
  await initialMissing.refresh();
  assert.equal(initialMissing.payload().clock.nightActive, false);
  assert.match(initialMissing.payload().clock.night_error, /sun.bedroom/);
  app.states.push(custom);
  custom.state = "above_horizon";
  await app.dashboard.refresh();
  assert.equal(app.dashboard.payload().clock.nightActive, false);
  assert.equal(app.dashboard.payload().clock.night_error, null);
});

test("HA's manual color helper overrides live Sun mode without rewriting settings or alarm helpers, including read-only dashboards", async (t) => {
  const app = await setup(t);
  const state = await app.get("api/state");
  assert.equal((await app.post("api/settings/clock", { ...state.config.clock, night_mode: "sun" })).status, 200);
  const yaml = fs.readFileSync(app.store.file, "utf8");
  const alarms = JSON.stringify(app.dashboard.payload().alarms);
  const calls = app.calls.length;
  app.dashboard.readOnly = true;
  for (const [value, night, active] of [["Night", "always", true], ["Day", "off", false], ["Auto", "entity", false]]) {
    await app.ha.callService("input_select", "select_option", { entity_id: "input_select.clock_radio_night_override", option: value });
    await app.dashboard.refresh();
    const actual = await app.get("api/state");
    assert.deepEqual(actual.night_override, { entity_id: "input_select.clock_radio_night_override", value, available: true, error: null });
    assert.equal(actual.config.clock.night_mode, "sun");
    assert.equal(actual.clock.night, night);
    assert.equal(actual.clock.nightActive, active);
    assert.equal(actual.clock.night_error, null);
    assert.equal(JSON.stringify(actual.alarms), alarms);
    assert.equal(fs.readFileSync(app.store.file, "utf8"), yaml);
  }
  assert.equal(app.calls.length - calls, 3);
  assert.ok(app.calls.slice(calls).every(({ domain, service, data }) => domain === "input_select"
    && service === "select_option" && data.entity_id === "input_select.clock_radio_night_override"));
  app.dashboard.readOnly = false;
  await app.ha.callService("input_select", "select_option", { entity_id: "input_select.clock_radio_night_override", option: "Night" });
  await app.dashboard.refresh();
  const beforeSave = app.calls.length;
  assert.equal((await app.post("api/settings/clock", { ...state.config.clock, night_mode: "sun", primary: "#22aa88" })).status, 200);
  const saved = await app.get("api/state");
  assert.equal(saved.night_override.value, "Night");
  assert.equal(saved.config.clock.night_mode, "sun");
  assert.equal(saved.config.clock.primary, "#22aa88");
  assert.equal(saved.clock.night, "always");
  assert.equal(app.calls.length, beforeSave, "Saving appearance must not write the HA override or any alarm helper");
});

test("explicit next-alarm sensors and date/time helpers use the proper epoch", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(alarmEntityAt({ entity_id: "sensor.next_alarm", state: "2026-11-15T05:15:00+01:00" }, "Europe/Copenhagen", now), "2026-11-15T04:15:00.000Z");
  assert.equal(alarmEntityAt({ entity_id: "input_datetime.alarm", state: "06:15:00" }, "Europe/Copenhagen", now), "2026-11-15T05:15:00.000Z");
  assert.equal(alarmEntityAt({ entity_id: "input_datetime.alarm", state: "2026-11-15 06:15:00" }, "Europe/Copenhagen", now), "2026-11-15T05:15:00.000Z");
  assert.throws(() => alarmEntityAt({ entity_id: "sensor.light", state: "not a timestamp" }, "Europe/Copenhagen", now));
});

test("ported music translations include formatted and dynamic labels", () => {
  const t = makeTranslator("en");
  assert.equal(format(t, "on_speaker", { name: "Bedroom" }), "on Bedroom");
  for (const key of ["on_group", "n_tracks", "n_episodes", "resume_at", "tab_playlists", "party_now"]) {
    assert.notEqual(t(key), key);
  }
  assert.equal(makeTranslator("DA-DK")("tab_albums"), makeTranslator("da")("tab_albums"));
});

test("artwork accepts HA's ready-made URLs unchanged while retaining MA image mappings", () => {
  const source = "https://logos.example/imageproxy?path=https%253A%252F%252Flogos.example%252Fradio.png&provider=builtin&size=0";
  assert.equal(pickImage({ image: source }), source);
  assert.equal(imageSource(source, "https://music.example/ma"), source);
  assert.equal(imageSource(source, ""), source);
  assert.equal(imageSource({ path: source, remotely_accessible: true }, ""), source);
  assert.equal(imageSource({ path: "radio.png", proxy_id: "radio/1" }, "https://music.example/ma"),
    "https://music.example/ma/imageproxy/radio%2F1?size=300");
  assert.equal(imageSource({ path: "https://logos.example/radio.png", provider: "radio browser" }, "https://music.example/ma"),
    "https://music.example/ma/imageproxy?path=https%253A%252F%252Flogos.example%252Fradio.png&provider=radio%20browser&size=300");
  for (const invalid of [null, "", "/relative/logo.png", "file:///logo.png", "javascript:alert(1)"]) assert.equal(imageSource(invalid, ""), null);
});

test("public radio artwork works through HA without a Music Assistant browsing URL or token", async () => {
  const requests = [];
  const ha = {
    requestWs: async () => [{ domain: "music_assistant", state: "loaded", entry_id: "test" }],
    callServiceWithResponse: async () => ({ items: [
      { uri: "library://radio/1", name: "Public radio", image: "https://logos.example/radio.png" },
      { uri: "library://radio/2", name: "No logo", image: null },
    ] }),
  };
  const music = new MusicService({ ha, logger: quiet, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response("image", { headers: { "Content-Type": "image/png" } });
  } });
  const radio = new RadioLibrary({ ha, music, logger: quiet });
  assert.equal(music.configured, false);
  await radio.refresh();
  assert.equal(radio.error, null);
  const [station, withoutLogo] = radio.payload({ stations: [] });
  assert.match(station.image, /^api\/music\/image\/[a-f0-9]+$/);
  assert.equal(withoutLogo.image, null);
  assert.equal((await music.image(station.image.split("/").at(-1))).type, "image/png");
  assert.equal(requests[0].url, "https://logos.example/radio.png");
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test("radio logos and player artwork use HA-supplied URLs instead of a failing HA player proxy", async (t) => {
  const app = await setup(t, { playerArtworkStatus: 400 });
  const player = app.states.find((state) => state.entity_id === "media_player.bedroom");
  const upstream = await app.ha.fetch(`${app.ha.url}${player.attributes.entity_picture}`, { headers: { Authorization: `Bearer ${DEMO_HA_TOKEN}` } });
  assert.equal(upstream.status, 400, "Reproduce the original player artwork failure");
  await upstream.arrayBuffer();
  app.artworkRequests.length = 0;
  let state = await app.get("api/state");
  const station = state.music.stations.find((item) => item.uri === "library://radio/1");
  assert.match(station.image, /^api\/music\/image\/[a-f0-9]+$/);
  assert.equal(state.players[0].attributes.entity_picture, station.image);
  assert.ok(!JSON.stringify(state).includes("/radio-logo/"), "Upstream URLs remain server-only");
  const logo = await fetch(`${app.url}/${station.image}`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/svg+xml");
  const body = await logo.text();
  const playerImage = await fetch(`${app.url}/api/player/image/media_player.bedroom`);
  assert.equal(playerImage.status, 200);
  assert.equal(await playerImage.text(), body);
  assert.deepEqual(app.artworkRequests, ["/radio-logo/1"], "Reuse the station artwork cache; never request the failing HA proxy");
  player.state = "idle";
  await app.dashboard.refresh();
  assert.equal(app.dashboard.payload().players[0].attributes.entity_picture, station.image, "Keep reliable radio artwork when HA retains idle metadata");
  assert.equal((await fetch(`${app.url}/api/player/image/media_player.other`)).status, 403);
  player.state = "playing";
  player.attributes.media_content_id = "library://track/1";
  player.attributes.media_title = station.name;
  await app.dashboard.refresh();
  state = await app.get("api/state");
  assert.match(state.players[0].attributes.entity_picture, /^api\/player\/image\//, "A matching title must not replace ordinary track artwork");
  assert.equal((await fetch(`${app.url}/api/player/image/media_player.bedroom`)).status, 502, "Unrelated HA image errors remain explicit, not disguised with a radio logo");
  app.dashboard.radio.stations.find((item) => item.uri === station.uri).image = null;
  player.attributes.media_content_id = station.uri;
  await app.dashboard.refresh();
  assert.match(app.dashboard.payload().players[0].attributes.entity_picture, /^api\/player\/image\//, "Stations without a known logo keep HA artwork");
  assert.equal((await fetch(`${app.url}/api/player/image/media_player.bedroom`)).status, 502);
});

test("next alarm uses HA weekdays and timezone, including DST gaps and repeated hours", () => {
  const alarm = {
    available: true, enabled: true, hour: 6, minute: 15,
    days: Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, !["saturday", "sunday"].includes(day)])),
  };
  assert.equal(nextAlarmAt([alarm], "Europe/Copenhagen", Date.parse("2026-11-13T22:00:00Z")), "2026-11-16T05:15:00.000Z");
  assert.equal(nextAlarmAt([alarm], "Europe/Copenhagen", Date.parse("2026-03-27T22:00:00Z")), "2026-03-30T04:15:00.000Z");
  const daily = { ...alarm, hour: 2, minute: 30, days: Object.fromEntries(Object.keys(alarm.days).map((day) => [day, true])) };
  assert.equal(nextAlarmAt([daily], "Europe/Copenhagen", Date.parse("2026-03-29T00:00:00Z")), "2026-03-30T00:30:00.000Z");
  assert.equal(nextAlarmAt([daily], "Europe/Copenhagen", Date.parse("2026-10-25T00:45:00Z")), "2026-10-25T01:30:00.000Z");
  assert.equal(nextAlarmAt([{ ...alarm, enabled: false }], "Europe/Copenhagen"), null);
});

test("daily weather reads service responses, expires at day boundaries and reports failures", async () => {
  let now = Date.parse("2026-11-14T12:00:00Z");
  let fail = false;
  const config = parseConfig({ clock: { weather_entity: "weather.room" } });
  const states = [{ entity_id: "weather.room", state: "sunny", attributes: { temperature: 17 } }];
  const data = new ClockData({ logger: quiet, now: () => now, ha: { callServiceWithResponse: async () => {
    if (fail) throw new Error("No forecast");
    return { "weather.room": { forecast: [{ datetime: "2026-11-14T12:00:00Z", temperature: 20, templow: 10 }] } };
  } } });
  await data.refresh(config, states, "Europe/Copenhagen");
  assert.equal(data.payload(config, { alarms: [] }, states, "Europe/Copenhagen").weatherHigh, 20);
  now = Date.parse("2026-11-15T01:00:00Z");
  await data.refresh(config, states, "Europe/Copenhagen");
  assert.equal(data.payload(config, { alarms: [] }, states, "Europe/Copenhagen").weatherHigh, null);
  fail = true;
  now += 1800001;
  await data.refresh(config, states, "Europe/Copenhagen");
  assert.match(data.error, /unavailable/);
});

test("alarm input validation is exact, and a failed save leaves the schedule disabled", async () => {
  const mock = createDemoAPI();
  const profile = alarmSnapshot(mock.states).alarms[0];
  const value = { id: 1, enabled: false, type: "Music", hour: 6, minute: 0, volume: 50, duration: 5, days: profile.days };
  assert.equal(validateAlarm(value).id, 1);
  for (const change of [{ id: "1" }, { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { duration: 0 }, { duration: 121 }, { volume: 101 }, { minute: 60 }, { type: "Other" }, { enabled: "true" }, { entity_id: "input_boolean.other" }, { days: {} }, { enabled: true, days: Object.fromEntries(Object.keys(profile.days).map((day) => [day, false])) }]) assert.throws(() => validateAlarm({ ...value, ...change }));
  const calls = [];
  const ha = { async callService(domain, service, data) {
    calls.push({ domain, service, data });
    if (domain === "input_select") throw new Error("Rejected");
  } };
  await assert.rejects(saveAlarm(ha, { ...value, enabled: true }, mock.states, quiet), { status: 502 });
  assert.equal(calls[0].service, "turn_off");
  assert.ok(!calls.some((call) => call.service === "turn_on"));
  await assert.rejects(saveAlarm(ha, value, [], quiet), { status: 409 });
  mock.ws.close();
});

test("four-page HTTP integration browses Dasher music, plays only registered items and edits existing helpers", async (t) => {
  const app = await setup(t);
  const html = await (await fetch(app.url)).text();
  const menus = [...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(menus, []);
  assert.deepEqual([...html.matchAll(/<section id="page-([^"]+)"/g)].map((match) => match[1]), ["clock", "alarms", "music", "settings"]);
  assert.match(html, /id="page-alarms" class="page settings-page" aria-label="Alarm configuration" hidden/);
  const settings = await (await fetch(`${app.url}/js/pages/settings.js`)).text();
  assert.doesNotMatch(settings, /Alarm playback|api\/settings\/alarm-playback/);
  assert.equal((await fetch(`${app.url}/js/pages/alarms.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/js/components/time-picker.js`)).status, 200);
  const state = await app.get("api/state");
  assert.equal(state.connected, true);
  assert.equal(state.alarms.alarms.length, 2);
  assert.equal(state.alarms.alarms[0].enabled, false);
  assert.ok(state.music.tabs.includes("playlists"));
  assert.equal(state.music.error, null);
  assert.ok(state.music.stations.some((item) => item.uri === "library://radio/1"));
  assert.ok(!JSON.stringify(state).includes("demo-artwork-only"));
  assert.ok(!JSON.stringify(state).includes(DEMO_MA_TOKEN));

  const albums = await app.get("api/music/library?tab=albums&sort=name");
  assert.equal(albums.items.length, 3);
  const item = await app.get("api/music/item?type=album&provider=library&id=1");
  assert.equal(item.sections[0].items.length, 2);
  assert.equal((await app.get("api/music/discover")).rows.length, 2);
  assert.equal((await app.get("api/music/search?q=First")).tracks[0].name, "First Light");
  assert.ok(!state.music.tabs.includes("party"));
  assert.deepEqual(state.music.players, ["media_player.bedroom"]);
  assert.equal((await fetch(`${app.url}/${albums.items[0].image}`)).status, 200);
  assert.equal((await fetch(`${app.url}/${state.players[0].attributes.entity_picture}`)).status, 200);

  assert.equal((await app.post("api/music/play", { entity_id: "media_player.bedroom", uri: "library://track/9999", type: "track" })).status, 400);
  assert.equal((await app.post("api/music/play", { entity_id: "media_player.other", uri: item.item.uri, type: "album" })).status, 403);
  assert.equal((await app.post("api/music/play", { entity_id: "media_player.bedroom", uri: item.item.uri, type: "album", startItem: item.sections[0].items[0].uri })).status, 200);
  assert.equal(app.calls.at(-1).data.entity_id, "media_player.bedroom");
  assert.equal((await app.get("api/state")).players[0].title, "First Light");
  assert.equal((await app.post("api/command", { entity_id: "media_player.bedroom", action: "media_seek", seek_position: 100 })).status, 200);
  assert.equal((await app.post("api/command", { entity_id: "media_player.bedroom", action: "media_seek", seek_position: 9999 })).status, 400);
  assert.equal((await app.post("api/command", { entity_id: "media_player.bedroom", action: "repeat_set", repeat: "one" })).status, 200);
  assert.equal((await app.post("api/radio/group", { leader: "media_player.bedroom", add: ["media_player.kitchen"] })).status, 405);
  assert.deepEqual((await app.get("api/state")).players[0].attributes.group_members, []);

  const alarm = state.alarms.alarms[0];
  const save = { id: 1, enabled: false, type: "Music", hour: 7, minute: 25, volume: 35, duration: 12, days: alarm.days };
  assert.equal((await app.post("api/settings/alarm", save)).status, 200);
  const saved = (await app.get("api/state")).alarms.alarms[0];
  assert.equal(saved.hour, 7);
  assert.equal(saved.minute, 25);
  assert.equal(saved.duration, 12);
  assert.equal(saved.enabled, false);
  assert.equal(app.calls.filter((call) => call.domain === "input_number").length, 4);
  assert.equal((await app.get("api/state")).alarms.alarms[1].minute, 15);

  const clockSettings = { ...CLOCK_DEFAULTS, layout: "full", full_face: "digital", weather_entity: "weather.bedroom" };
  assert.equal((await app.post("api/settings/clock", clockSettings)).status, 200);
  const reopened = new ConfigStore({ dir: path.dirname(app.store.file), example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  assert.equal(reopened.current.clock.full_face, "digital");
  assert.equal(reopened.current.stations.length, app.store.current.stations.length);
  assert.equal((await app.get("api/state")).clock.weatherHigh, 22);
});

test("every new mutation rejects read-only and cross-site requests before touching HA or YAML", async (t) => {
  const app = await setup(t);
  const routes = ["api/settings/clock", "api/settings/alarm", "api/settings/alarm-playback", "api/alarm/stop", "api/alarm/snooze", "api/radio/play", "api/music/play", "api/alarm/create", "api/alarm/delete"];
  const before = fs.readFileSync(app.store.file, "utf8");
  const count = app.calls.length;
  app.dashboard.readOnly = true;
  for (const route of routes) assert.equal((await app.post(route, {})).status, 403, route);
  app.dashboard.readOnly = false;
  for (const route of routes) assert.equal((await app.post(route, {}, { "Sec-Fetch-Site": "cross-site" })).status, 403, route);
  assert.equal(app.calls.length, count);
  assert.equal(fs.readFileSync(app.store.file, "utf8"), before);
  assert.equal((await fetch(`${app.url}/api/settings/alarm`)).status, 405);
});

test("ringing alarm API snoozes both types for 600 seconds, exposes the next wake and cancels cleanly", async (t) => {
  const app = await setup(t);
  assert.equal((await app.post("api/alarm/snooze", {})).status, 409);
  for (const [id, type] of [[1, "Music"], [2, "Buzzer"]]) {
    app.startAlarm(id);
    await app.dashboard.refresh();
    const before = Date.now();
    assert.equal((await app.get("api/state")).alarms.active.type, type);
    assert.equal((await app.post("api/alarm/snooze", { minutes: 10 })).status, 400);
    assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
    const state = await app.get("api/state");
    assert.equal(state.alarms.active, null);
    assert.equal(state.alarms.active_player, "");
    assert.equal(state.alarms.snoozed.type, type);
    assert.equal(state.alarms.snoozed.id, id);
    assert.equal(Date.parse(state.alarms.snoozed.until) % 1000, 0, "Persist a whole-second deadline matching HA's time trigger");
    assert.ok(Date.parse(state.alarms.snoozed.until) >= before + 600000);
    assert.ok(Date.parse(state.alarms.snoozed.until) < Date.now() + 601000);
    assert.equal(state.clock.alarm, state.alarms.snoozed.until);
    assert.equal(state.players[0].state, "idle");
    assert.equal(state.players[0].volume_level, 0.3);
    assert.equal(state.players[0].attributes.repeat, "off");
    assert.equal(app.calls.at(-1).service, "clock_radio_snooze");
    const restarted = new Dashboard({ ha: app.ha, configStore: app.store, mediaPlayer: "media_player.bedroom", logger: quiet });
    await restarted.refresh();
    assert.deepEqual(restarted.payload().alarms.snoozed, state.alarms.snoozed);
    app.states.find((item) => item.entity_id === `input_select.clock_radio_alarm_${id}_type`).state = type === "Music" ? "Buzzer" : "Music";
    app.advanceAlarms(Date.parse(state.alarms.snoozed.until));
    await app.dashboard.refresh();
    const resumed = (await app.get("api/state")).alarms;
    assert.equal(resumed.active.type, type, "Snooze resumes the captured type, not an edited profile type");
    assert.equal(resumed.snoozed, null);
    assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
    assert.equal((await app.post("api/alarm/stop", {})).status, 200);
    assert.equal((await app.get("api/state")).alarms.snoozed, null);
  }
  app.startAlarm(1);
  await app.dashboard.refresh();
  assert.equal((await app.post("api/alarm/stop", {})).status, 200);
  const stopped = (await app.get("api/state")).alarms;
  assert.equal(stopped.active, null);
  assert.equal(stopped.active_player, "");
  assert.ok(stopped.alarms.every((alarm) => alarm.timer === "idle"));
});

test("old scheduler packages cannot accept new snoozes but still allow stopping the alarm", async (t) => {
  const app = await setup(t);
  app.startAlarm(2);
  app.states.find((state) => state.entity_id === "sensor.clock_radio_alarm_scheduler_version").state = "5";
  await app.dashboard.refresh();
  const before = app.calls.length;
  assert.equal((await app.get("api/state")).alarms.can_snooze, false);
  const rejected = await app.post("api/alarm/snooze", {});
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /scheduler version 6/);
  assert.equal(app.calls.length, before);
  assert.equal((await app.post("api/alarm/stop", {})).status, 200);
  assert.equal((await app.get("api/state")).alarms.active, null);
});

test("scoped snooze cancellation handles both alarm types without accepting stale targets", async (t) => {
  const app = await setup(t);
  const clock = structuredClone(app.store.current.clock);
  for (const id of [1, 2]) {
    app.startAlarm(id);
    assert.equal((await app.post("api/alarm/snooze", {})).status, 200);
    const snoozed = (await app.get("api/state")).alarms.snoozed;
    const before = app.calls.length;
    for (const invalid of [null, {}, { ...snoozed, id: "1" }, { ...snoozed, type: "Other" }, { ...snoozed, until: "invalid" }, { ...snoozed, extra: true }]) {
      assert.equal((await app.post("api/alarm/stop", { snoozed: invalid })).status, 400);
    }
    for (const changed of [{ id: id + 10 }, { type: snoozed.type === "Music" ? "Buzzer" : "Music" }, { until: new Date(Date.parse(snoozed.until) + 1000).toISOString() }]) {
      assert.equal((await app.post("api/alarm/stop", { snoozed: { ...snoozed, ...changed } })).status, 409);
    }
    app.dashboard.readOnly = true;
    assert.equal((await app.post("api/alarm/stop", { snoozed })).status, 403);
    app.dashboard.readOnly = false;
    assert.equal(app.calls.length, before);
    assert.equal((await app.post("api/alarm/stop", { snoozed })).status, 200);
    assert.equal((await app.get("api/state")).alarms.snoozed, null);
    const stopped = app.calls.length;
    assert.equal((await app.post("api/alarm/stop", { snoozed })).status, 409);
    assert.equal(app.calls.length, stopped);
  }
  assert.deepEqual(app.store.current.clock, clock);
});

test("a stale snooze stop cannot dismiss a new ringing alarm or an expired deadline", async (t) => {
  const app = await setup(t);
  app.startAlarm(1);
  await app.post("api/alarm/snooze", {});
  const snoozed = (await app.get("api/state")).alarms.snoozed;
  app.startAlarm(2);
  let before = app.calls.length;
  assert.equal((await app.post("api/alarm/stop", { snoozed })).status, 409);
  assert.equal(app.calls.length, before);
  assert.equal((await app.get("api/state")).alarms.active.id, 2);
  await app.post("api/alarm/snooze", {});
  app.states.find((state) => state.entity_id === "input_datetime.clock_radio_snooze_until").attributes.timestamp = Math.floor(Date.now() / 1000) - 1;
  const expired = (await app.get("api/state")).alarms.snoozed;
  before = app.calls.length;
  assert.equal((await app.post("api/alarm/stop", { snoozed: expired })).status, 409);
  assert.equal(app.calls.length, before);
});

test("snooze failures and disconnected HA return explicit errors without inventing a successful stop", async (t) => {
  const app = await setup(t);
  app.startAlarm(2);
  await app.dashboard.refresh();
  const original = app.ha.callService.bind(app.ha);
  app.ha.callService = async (domain, service, data) => {
    if (service === "clock_radio_snooze") {
      app.states.find((state) => state.entity_id === "timer.clock_radio_alarm_2").state = "idle";
      throw new Error("Snooze speaker cleanup failed after cancelling the timer");
    }
    return original(domain, service, data);
  };
  const failed = await app.post("api/alarm/snooze", {});
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /could not be snoozed/);
  assert.equal((await app.get("api/state")).alarms.active.type, "Buzzer");
  assert.equal((await app.get("api/state")).alarms.can_snooze, false);
  app.ha.states = async () => { throw new Error("HA offline"); };
  assert.equal((await app.post("api/alarm/snooze", {})).status, 503);
});

test("clock configuration saves preserve comments, unrelated YAML and invalid user edits", async (t) => {
  const app = await setup(t);
  fs.writeFileSync(app.store.file, "# My clock\nplayers: [media_player.bedroom]\nstations: []\n");
  app.store.saveClock({ ...CLOCK_DEFAULTS, face: "digital" });
  assert.match(fs.readFileSync(app.store.file, "utf8"), /^# My clock/);
  assert.deepEqual(app.store.current.players, ["media_player.bedroom"]);
  const invalid = "clock: [broken]\n";
  fs.writeFileSync(app.store.file, invalid);
  assert.throws(() => app.store.saveClock(CLOCK_DEFAULTS));
  assert.equal(fs.readFileSync(app.store.file, "utf8"), invalid);
});

test("weather comes only from HA app options, including after appearance saves and restart", async (t) => {
  const app = await setup(t);
  fs.writeFileSync(app.store.file, "# Legacy weather\nclock:\n  weather_entity: weather.legacy\n");
  await app.dashboard.refresh();
  let state = await app.get("api/state");
  assert.equal(state.config.clock.weather_entity, "weather.bedroom");
  assert.equal(state.clock.weatherConfigured, true);
  assert.equal(state.clock.weatherTemperature, 18);
  assert.equal(state.clock.weatherHigh, 22);
  assert.equal(state.clock.weatherLow, 11);

  const before = fs.readFileSync(app.store.file, "utf8");
  const rejected = await app.post("api/settings/clock", { ...state.config.clock, weather_entity: "weather.legacy" });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Home Assistant app configuration/);
  assert.equal(fs.readFileSync(app.store.file, "utf8"), before);
  assert.equal((await app.post("api/settings/clock", { ...state.config.clock, face: "digital" })).status, 200);
  const reopened = new ConfigStore({ dir: path.dirname(app.store.file), example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  assert.equal(reopened.current.clock.weather_entity, "weather.legacy");
  assert.equal(reopened.current.clock.face, "digital");
  assert.match(fs.readFileSync(app.store.file, "utf8"), /^# Legacy weather/);
  const restarted = new Dashboard({ ha: app.ha, configStore: reopened, weatherEntity: "weather.bedroom", logger: quiet });
  await restarted.refresh();
  assert.equal(restarted.payload().clock.weatherHigh, 22);

  app.dashboard.weatherEntity = "weather.missing";
  await app.dashboard.refresh();
  state = await app.get("api/state");
  assert.equal(state.config.clock.weather_entity, "weather.missing");
  assert.equal(state.clock.weatherTemperature, null);
  assert.match(state.clock.error, /missing or unavailable/);

  app.dashboard.weatherEntity = "";
  await app.dashboard.refresh();
  state = await app.get("api/state");
  assert.equal(state.config.clock.weather_entity, "");
  assert.equal(state.clock.weatherConfigured, false);
  assert.equal(state.clock.weatherHigh, null);
  assert.equal(state.clock.error, null);
});

test("removed Party routes are unavailable", async (t) => {
  const app = await setup(t, { party: false });
  const response = await fetch(`${app.url}/api/music/party`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Not found/);
});

test("asset paths and music URLs cannot escape their allowed surfaces", () => {
  for (const name of ["/clock/index.html", "/clock/fonts/inter-latin.woff2", "/js/core/api.js", "/css/music.css"]) assert.ok(staticAsset(name));
  for (const name of ["/src/index.js", "/clock/../../package.json", "/js/../src/index.js", "/clock/%2e%2e/config.js", "/clock/foo.json"]) assert.equal(staticAsset(name), null);
  for (const uri of ["https://example.com/live", "file://track/1", "data://track/x", "javascript://track/x"]) assert.equal(validPlayUri(uri), false);
  assert.equal(validPlayUri("library://album/1"), true);
  for (const body of [
    { player: "media_player.other", music_source: "library://radio/1", buzzer_source: "https://example.com/a.mp3" },
    { player: "media_player.bedroom", music_source: "https://user:pass@example.com/a", buzzer_source: "https://example.com/a.mp3" },
  ]) assert.throws(() => validatePlaybackSettings(body, ["media_player.bedroom"]));
});

test("artwork credentials stay on the exact MA origin/base path", async () => {
  const requests = [];
  const music = new MusicService({
    ha: {}, logger: quiet, url: "https://music.example/ma", token: "private-test-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response("image", { headers: { "Content-Type": "image/png" } });
    },
  });

  for (const source of ["https://music.example/ma/imageproxy/a", "https://music.example/elsewhere/a.png", "https://music.example.evil.test/ma/a.png"]) {
    const id = music._register(source).split("/").at(-1);
    await music.image(id);
  }
  assert.equal(requests[0].options.headers.Authorization, "Bearer private-test-token");
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[2].options.headers.Authorization, undefined);
  assert.ok(requests.every((request) => request.options.redirect === "error"));
  assert.throws(() => music._register("https://user:password@music.example/a.png"));
});

test("invalid library responses and query bounds are errors, not empty successful pages", async () => {
  const music = new MusicService({ ha: {}, logger: quiet, url: "https://music.example", token: "test" });
  music.client.call = async () => ({ invalid: true });
  await assert.rejects(music.library({ tab: "albums" }), /invalid library/);
  await assert.rejects(music.discover(), /invalid recommendations/);
  for (const options of [{ tab: "constructor" }, { tab: "albums", limit: "10000" }, { tab: "albums", offset: "1.5" }, { tab: "albums", sort: "invalid" }]) await assert.rejects(music.library(options), { status: 400 });
});

test("concurrent requests for one artwork do not double-count cache bytes", async () => {
  const music = new MusicService({
    ha: {}, logger: quiet, url: "https://music.example", token: "test",
    fetchImpl: async () => new Response("image", { headers: { "Content-Type": "image/png" } }),
  });
  const id = music._register("https://music.example/image.png").split("/").at(-1);
  await Promise.all([music.image(id), music.image(id), music.image(id)]);
  assert.equal(music._images.size, 1);
  assert.equal(music._imageBytes, Buffer.byteLength("image"));
});

test("simultaneous edits cannot interleave the same alarm's helper writes", async (t) => {
  const app = await setup(t);
  const profile = app.dashboard.payload().alarms.alarms[0];
  const settings = { id: 1, enabled: false, type: "Music", hour: 6, minute: 0, volume: 50, duration: 5, days: profile.days };
  const original = app.ha.callService.bind(app.ha);
  let release, started;
  const entered = new Promise((resolve) => { started = resolve; });
  app.ha.callService = async (...args) => {
    if (args[0] === "input_boolean" && !release) {
      await new Promise((resolve) => { release = resolve; started(); });
    }
    return original(...args);
  };
  const first = app.dashboard.saveAlarm(settings);
  await entered;
  await assert.rejects(app.dashboard.saveAlarm(settings), { status: 409 });
  release();
  await first;
  assert.equal(app.dashboard.alarmWrites.size, 0);
});

test("shared playback saves pause schedules, preserve enabled states and update helpers", async (t) => {
  const app = await setup(t);
  for (const id of [1, 2]) app.states.find((state) => state.entity_id === `input_boolean.clock_radio_alarm_${id}_enabled`).state = "on";
  const settings = { player: "media_player.bedroom", music_source: "library://radio/2", buzzer_source: "https://example.com/sound.mp3" };
  const before = app.calls.length;
  assert.equal((await app.post("api/settings/alarm-playback", settings)).status, 200);
  assert.deepEqual(app.calls.slice(before).map((call) => call.service), ["turn_off", "turn_off", "set_value", "set_value", "set_value", "turn_on", "turn_on"]);
  const value = (await app.get("api/state")).alarms;
  assert.equal(value.player, settings.player);
  assert.equal(value.music_source, settings.music_source);
  assert.equal(value.buzzer_source, settings.buzzer_source);
  assert.ok(value.alarms.every((alarm) => alarm.enabled));
});

test("failed profile edits refresh actual disabled state before returning the error", async (t) => {
  const app = await setup(t);
  app.states.find((state) => state.entity_id === "input_boolean.clock_radio_alarm_1_enabled").state = "on";
  const original = app.ha.callService.bind(app.ha);
  app.ha.callService = async (...args) => {
    if (args[0] === "input_select") throw new Error("Helper write failed");
    return original(...args);
  };
  const profile = app.dashboard.payload().alarms.alarms[0];
  const settings = { id: 1, enabled: true, type: "Music", hour: 6, minute: 0, volume: 50, duration: 7, days: profile.days };
  assert.equal((await app.post("api/settings/alarm", settings)).status, 502);
  const saved = (await app.get("api/state")).alarms.alarms[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.duration, 7);
});

test("adding alarms provisions scoped persistent helpers and leaves existing profiles untouched", async (t) => {
  const app = await setup(t);
  const original = structuredClone((await app.get("api/state")).alarms.alarms);
  assert.equal((await app.get("api/state")).alarms.can_create, true);
  for (const id of [3, 4]) {
    const response = await app.post("api/alarm/create", {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, alarm_id: id });
    const profile = (await app.get("api/state")).alarms.alarms.find((alarm) => alarm.id === id);
    assert.equal(profile.enabled, false);
    assert.equal(profile.setup_complete, true);
    assert.equal(profile.type, "Music");
    assert.equal(profile.hour, 6);
    assert.equal(profile.minute, 0);
    assert.equal(profile.duration, 5);
    assert.equal(profile.volume, 50);
    assert.equal(profile.days.monday, true);
    assert.equal(profile.days.sunday, false);
    assert.equal(profile.timer, "idle");
    assert.equal(profile.can_select_radio, true);
    assert.equal(app.states.find((state) => state.entity_id === `input_text.clock_radio_alarm_${id}_music_source`).state, "");
  }
  assert.equal(app.helperRequests.length, 32);
  assert.ok(app.helperRequests.every((request) => !Object.hasOwn(request, "initial")));
  assert.ok(app.helperRequests.filter((request) => request.type === "timer/create").every((request) => request.restore === true));
  assert.deepEqual((await app.get("api/state")).alarms.alarms.slice(0, 2), original);
  const third = (await app.get("api/state")).alarms.alarms[2];
  const settings = { id: 3, type: "Buzzer", enabled: false, hour: 8, minute: 43, volume: 35, duration: 9, days: third.days };
  assert.equal((await app.post("api/settings/alarm", settings)).status, 200);
  await app.dashboard.refresh();
  assert.equal(app.dashboard.payload().alarms.alarms[2].duration, 9);
  assert.equal(app.states.find((state) => state.entity_id === "input_select.clock_radio_alarm_3_type").state, "Buzzer");
});

test("legacy schedulers and invalid creation requests cannot create HA helpers", async (t) => {
  const app = await setup(t);
  for (const body of [{ id: 1 }, { id: -1 }, { id: "3" }, { domain: "switch" }]) {
    assert.equal((await app.post("api/alarm/create", body)).status, 400);
  }
  const play = app.states.find((state) => state.entity_id === "script.clock_radio_play_alarm");
  play.state = "unavailable";
  assert.equal((await app.post("api/alarm/create", {})).status, 409);
  assert.equal((await app.get("api/state")).alarms.can_create, false);
  play.state = "off";
  app.states.find((state) => state.entity_id === "sensor.clock_radio_alarm_scheduler_version").state = "1";
  assert.equal((await app.post("api/alarm/create", {})).status, 409);
  assert.equal(app.helperRequests.length, 0);
});

test("native radio text helpers start unknown and initialize before setup completes", async (t) => {
  const app = await setup(t);
  const original = app.ha.callService.bind(app.ha);
  let initialized = 0;
  app.ha.callService = async (domain, service, data) => {
    if (domain === "input_text" && data.entity_id === "input_text.clock_radio_alarm_3_music_source") {
      assert.equal(service, "set_value");
      assert.equal(data.value, "");
      assert.equal(app.states.find((state) => state.entity_id === data.entity_id).state, "unknown");
      assert.equal(app.states.find((state) => state.entity_id === "input_boolean.clock_radio_alarm_3_initialized").state, "off");
      initialized++;
    }
    return original(domain, service, data);
  };
  assert.equal((await app.post("api/alarm/create", {})).status, 200);
  assert.equal(initialized, 1);
  assert.equal((await app.get("api/state")).alarms.alarms[2].can_select_radio, true);
});

test("failed or unconfirmed radio initialization leaves setup disabled and can resume without duplicate helpers", async (t) => {
  for (const failure of ["error", "no-op"]) {
    await t.test(failure, async (t) => {
      const app = await setup(t);
      const original = app.ha.callService.bind(app.ha);
      app.ha.callService = async (domain, service, data) => {
        if (domain === "input_text" && data.entity_id === "input_text.clock_radio_alarm_3_music_source") {
          if (failure === "error") throw new Error("Radio initialization failed");
          return;
        }
        return original(domain, service, data);
      };
      assert.equal((await app.post("api/alarm/create", {})).status, 502);
      const partial = (await app.get("api/state")).alarms.alarms[2];
      assert.equal(partial.setup_complete, false);
      assert.equal(partial.enabled, false);
      assert.equal(partial.can_select_radio, false);
      assert.equal(app.states.find((state) => state.entity_id === "input_text.clock_radio_alarm_3_music_source").state, "unknown");
      app.ha.callService = original;
      await original("input_number", "set_value", { entity_id: "input_number.clock_radio_alarm_3_volume", value: 40 });
      if (failure === "error") {
        const source = app.states.find((state) => state.entity_id === "input_text.clock_radio_alarm_3_music_source");
        source.state = "unavailable";
        const before = app.calls.length;
        assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 502);
        assert.equal(source.state, "unavailable");
        assert.equal(app.calls.length, before);
        source.state = "unknown";
      }
      assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 200);
      const resumed = (await app.get("api/state")).alarms.alarms[2];
      assert.equal(resumed.setup_complete, true);
      assert.equal(resumed.enabled, false);
      assert.equal(resumed.can_select_radio, true);
      assert.equal(resumed.volume, 40);
      assert.equal(app.helperRequests.length, 16);
    });
  }
});

test("partial helper creation is visible, disabled and resumable without duplicate entities", async (t) => {
  const app = await setup(t);
  const original = app.ha.requestWs.bind(app.ha);
  app.ha.requestWs = async (message) => {
    if (message.type === "input_number/create") throw new Error("Helper creation denied");
    return original(message);
  };
  const failed = await app.post("api/alarm/create", {});
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /^Alarm setup failed:/);
  const partial = (await app.get("api/state")).alarms.alarms[2];
  assert.equal(partial.enabled, false);
  assert.equal(partial.setup_complete, false);
  assert.equal(partial.available, false);
  assert.equal((await app.post("api/alarm/create", {})).status, 409);
  app.ha.requestWs = original;
  assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 200);
  assert.equal(app.helperRequests.length, 16);
  assert.equal(new Set(app.states.map((state) => state.entity_id)).size, app.states.length);
});

test("failed initialization cannot be enabled and resuming preserves existing helper edits", async (t) => {
  const app = await setup(t);
  const original = app.ha.callService.bind(app.ha);
  app.ha.callService = async (domain, service, data) => {
    if (data.entity_id === "input_number.clock_radio_alarm_3_volume") throw new Error("Value write failed");
    return original(domain, service, data);
  };
  assert.equal((await app.post("api/alarm/create", {})).status, 502);
  const partial = (await app.get("api/state")).alarms.alarms[2];
  assert.equal(partial.available, true);
  assert.equal(partial.setup_complete, false);
  const settings = { id: 3, enabled: true, type: "Music", hour: 6, minute: 0, duration: 5, volume: 50, days: partial.days };
  settings.days.monday = true;
  assert.equal((await app.post("api/settings/alarm", settings)).status, 409);
  app.ha.callService = original;
  await original("input_number", "set_value", { entity_id: "input_number.clock_radio_alarm_3_volume", value: 40 });
  const station = app.radio.stations[0].uri;
  await original("input_text", "set_value", { entity_id: "input_text.clock_radio_alarm_3_music_source", value: station });
  assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 200);
  assert.equal((await app.get("api/state")).alarms.alarms[2].volume, 40);
  assert.equal(app.states.find((state) => state.entity_id === "input_text.clock_radio_alarm_3_music_source").state, station);
});

test("the configured speaker is the only target and synchronizes all alarm schedules safely", async (t) => {
  const app = await setup(t);
  for (const id of [1, 2]) app.states.find((state) => state.entity_id === `input_boolean.clock_radio_alarm_${id}_enabled`).state = "on";
  app.dashboard.mediaPlayer = "media_player.kitchen";
  const before = app.calls.length;
  await app.dashboard.refresh();
  assert.deepEqual(app.calls.slice(before).map((call) => call.service), ["turn_off", "turn_off", "set_value", "turn_on", "turn_on"]);
  assert.deepEqual(app.dashboard.payload().music.players, ["media_player.kitchen"]);
  assert.equal(app.dashboard.payload().alarms.player, "media_player.kitchen");
  assert.ok(app.dashboard.payload().alarms.alarms.every((alarm) => alarm.enabled));
  assert.equal((await app.post("api/command", { entity_id: "media_player.bedroom", action: "media_pause" })).status, 403);
  app.dashboard.readOnly = true;
  app.dashboard.mediaPlayer = "media_player.bedroom";
  const count = app.calls.length;
  await app.dashboard.refresh();
  assert.equal(app.calls.length, count);
  assert.match(app.dashboard.payload().config_error, /Read-only/);
  app.dashboard.readOnly = false;
  app.dashboard.mediaPlayer = "media_player.missing";
  await app.dashboard.refresh();
  assert.equal(app.dashboard.payload().alarms.player, "media_player.missing");
  assert.deepEqual(app.dashboard.payload().music.players, []);
  assert.deepEqual(app.dashboard.payload().missing_players, ["media_player.missing"]);
});
