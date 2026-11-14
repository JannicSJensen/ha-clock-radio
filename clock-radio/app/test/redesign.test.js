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
  const dashboard = new Dashboard({ ha, configStore: store, music, radio, mediaPlayer: "media_player.bedroom", weatherEntity: "weather.bedroom", logger: quiet, version: "test" });
  await dashboard.refresh();
  const server = createServer({ dashboard, webRoot: path.join(root, "web"), logger: quiet });
  const url = await listen(server);
  t.after(() => close(server));
  const get = async (route) => (await fetch(`${url}/${route}`)).json();
  const post = (route, body, headers = {}) => fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...mock, ha, store, music, radio, dashboard, get, post, url };
}

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
  assert.deepEqual([...html.matchAll(/<section id="page-([^"]+)"/g)].map((match) => match[1]), ["clock", "music", "alarms", "settings"]);
  assert.match(html, /id="page-alarms" class="page settings-page" aria-label="Alarm configuration" hidden/);
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

  const settings = { ...CLOCK_DEFAULTS, layout: "full", full_face: "digital", weather_entity: "weather.bedroom" };
  assert.equal((await app.post("api/settings/clock", settings)).status, 200);
  const reopened = new ConfigStore({ dir: path.dirname(app.store.file), example: path.join(root, "examples/dashboard.yaml"), logger: quiet });
  assert.equal(reopened.current.clock.full_face, "digital");
  assert.equal(reopened.current.stations.length, app.store.current.stations.length);
  assert.equal((await app.get("api/state")).clock.weatherHigh, 22);
});

test("every new mutation rejects read-only and cross-site requests before touching HA or YAML", async (t) => {
  const app = await setup(t);
  const routes = ["api/settings/clock", "api/settings/alarm", "api/settings/alarm-playback", "api/alarm/stop", "api/radio/play", "api/music/play", "api/alarm/create"];
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
  }
  assert.equal(app.helperRequests.length, 30);
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

test("partial helper creation is visible, disabled and resumable without duplicate entities", async (t) => {
  const app = await setup(t);
  const original = app.ha.requestWs.bind(app.ha);
  app.ha.requestWs = async (message) => {
    if (message.type === "input_number/create") throw new Error("Helper creation denied");
    return original(message);
  };
  assert.equal((await app.post("api/alarm/create", {})).status, 502);
  const partial = (await app.get("api/state")).alarms.alarms[2];
  assert.equal(partial.enabled, false);
  assert.equal(partial.setup_complete, false);
  assert.equal(partial.available, false);
  assert.equal((await app.post("api/alarm/create", {})).status, 409);
  app.ha.requestWs = original;
  assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 200);
  assert.equal(app.helperRequests.length, 15);
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
  assert.equal((await app.post("api/alarm/create", { id: 3 })).status, 200);
  assert.equal((await app.get("api/state")).alarms.alarms[2].volume, 40);
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
