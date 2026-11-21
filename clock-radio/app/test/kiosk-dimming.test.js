import assert from "node:assert/strict";
import test from "node:test";
import { KioskAlarms } from "../src/kiosk-alarms.js";
import { KioskDimming } from "../src/kiosk-dimming.js";
import { createKioskDemo, DEMO_KIOSK_TOKEN } from "../dev/kiosk-fixtures.js";
import { Dashboard } from "../src/dashboard.js";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { SnapshotStore, offlineStatus } from "../web/js/core/snapshot.js";
import { kioskDimmingMessage } from "../web/js/pages/settings.js";

async function setup(t, { backend = "home_assistant", readOnly = false } = {}) {
  const fixture = createKioskDemo();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.server.close(); fixture.server.closeAllConnections(); });
  const warnings = [], haCalls = [];
  const logger = { warn: (message) => warnings.push(message) };
  const client = new KioskAlarms({ url: `http://127.0.0.1:${fixture.server.address().port}`, token: DEMO_KIOSK_TOKEN, logger });
  const dimming = new KioskDimming({ client, logger });
  const dashboard = new Dashboard({
    kiosk: backend === "kiosk_satellite" ? client : null, kioskDimming: dimming,
    version: "0.25.0", demo: true, readOnly, logger,
    configStore: { current: parseConfig({ time_zone: "Europe/Copenhagen" }), load() {} },
    ha: { async states() { throw new Error("Fictional HA offline"); }, async callService(...args) { haCalls.push(args); } },
  });
  await dashboard.refresh();
  const server = createServer({ dashboard, webRoot: new URL("../web/", import.meta.url).pathname, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${url}/api/kiosk/dimming/save`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const body = (enabled = true) => ({ enabled, device_id: client.backendId, revision: dimming.snapshot().revision });
  return { ...fixture, client, dimming, dashboard, warnings, haCalls, url, post, body };
}

test("both alarm backends configure exact native 600-second/10% dimming without changing brightness or alarms", async (t) => {
  for (const backend of ["home_assistant", "kiosk_satellite"]) await t.test(backend, async (t) => {
    const f = await setup(t, { backend });
    const alarms = structuredClone(f.alarms), settings = { ...f.settings };
    const response = await f.post(f.body());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ready, true);
    assert.equal(f.settings["screensaver.timeout_seconds"], 600);
    assert.equal(f.settings["screensaver.dim_level"], 0.1);
    assert.equal(f.settings["screensaver.screen_off_minutes"], 0);
    assert.equal(f.settings["screensaver.mode"], "dim");
    for (const key of ["screensaver.enabled", "screensaver.dismiss_on_proximity", "screensaver.postpone_on_proximity"]) assert.equal(f.settings[key], true);
    assert.equal(f.settings["screensaver.dismiss_on_proximity_screen_off_only"], false);
    for (const key of ["screen.default_brightness", "screen.adaptive_brightness", "screensaver.saved_brightness", "ha.password"]) assert.equal(f.settings[key], settings[key]);
    assert.deepEqual(f.alarms, alarms);
    assert.deepEqual(f.haCalls, []);
    assert.equal(f.dashboard.payload().alarms.backend, backend);
    assert.equal(f.calls.filter((call) => call.name === "patchSettings").length, 1);
    assert.ok(!f.calls.some((call) => ["setBrightness", "screenOff"].includes(call.name)));
    if (backend === "home_assistant") assert.match(offlineStatus(f.dashboard.payload()), /HA controls are read-only.*KS proximity dimming controls are connected/);
  });
});

test("disabling native Dim leaves restoration to KS; other screensaver modes are not disabled", async (t) => {
  const f = await setup(t);
  f.settings["screensaver.enabled"] = true;
  await f.dimming.refresh(true);
  await f.dashboard.saveKioskDimming(f.body(false));
  assert.equal(f.settings["screensaver.enabled"], true);
  assert.ok(!f.calls.some((call) => call.name === "patchSettings"));
  await f.dashboard.saveKioskDimming(f.body());
  await f.dashboard.saveKioskDimming(f.body(false));
  assert.deepEqual(f.calls.filter((call) => call.name === "patchSettings").at(-1).data, { "screensaver.enabled": false });
  assert.equal(f.settings["screen.default_brightness"], 0.65);
  assert.equal(f.settings["screensaver.saved_brightness"], -1);
  assert.equal(f.dimming.snapshot().enabled, false);
});

test("device identity, revision and boolean enable are required; arbitrary native fields are rejected", async (t) => {
  const f = await setup(t);
  for (const body of [null, [], {}, { ...f.body(), enabled: "true" }, { ...f.body(), device_id: "b".repeat(16) },
    { ...f.body(), revision: null }, { ...f.body(), brightness: 1 }, { ...f.body(), settings: { "ha.password": "bad" } }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.ok(!f.calls.some((call) => call.name === "patchSettings"));
});

test("read-only mode blocks native writes before calls and advertises non-configurable metadata", async (t) => {
  const f = await setup(t, { readOnly: true });
  const calls = f.calls.length;
  assert.equal((await f.post(f.body())).status, 403);
  assert.equal(f.calls.length, calls);
  assert.equal(f.dashboard.payload().kiosk_dimming.can_configure, false);
  assert.equal((await (await fetch(`${f.url}/api/kiosk/dimming`)).json()).can_configure, false);
});

test("alarm phases, native schedules and lockdown block configuration instead of being overwritten", async (t) => {
  const f = await setup(t);
  for (const phase of ["ringing", "sunrise", "snoozed"]) {
    f.mode.phase = phase; f.mode.ids = ["personal-native-alarm"];
    await f.dimming.refresh(true);
    assert.equal(f.dimming.snapshot().can_configure, false);
    assert.equal((await f.post(f.body())).status, 409);
  }
  f.mode.phase = "idle"; f.mode.ids = [];
  for (const key of ["screensaver.schedule_enabled", "lockdown.enabled"]) {
    f.settings[key] = true;
    await f.dimming.refresh(true);
    assert.equal(f.dimming.snapshot().can_configure, false);
    assert.equal((await f.post(f.body())).status, 409);
    assert.equal(f.settings[key], true);
    f.settings[key] = false;
  }
  assert.ok(!f.calls.some((call) => call.name === "patchSettings"));
});

test("unsupported sensors cannot enable dimming but can turn an existing native Dim mode off", async (t) => {
  const f = await setup(t);
  f.mode.proximitySupported = false;
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().can_configure, false);
  assert.equal((await f.post(f.body())).status, 409);
  f.settings["screensaver.enabled"] = true; f.settings["screensaver.mode"] = "dim";
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().can_configure, true);
  assert.equal((await f.post(f.body(false))).status, 200);
  assert.equal(f.settings["screensaver.enabled"], false);
});

test("changed settings require reloading; equivalent schema order does not invalidate the revision", async (t) => {
  const f = await setup(t);
  const old = f.body();
  f.settings["screensaver.dim_level"] = 0.3;
  assert.equal((await f.post(old)).status, 409);
  assert.ok(!f.calls.some((call) => call.name === "patchSettings"));
  await f.dimming.refresh(true);
  const revision = f.dimming.snapshot().revision;
  const settings = f.client.settings.bind(f.client);
  f.client.settings = async (values = null) => {
    const result = await settings(values);
    if (values === null) result.settings.reverse();
    return result;
  };
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().revision, revision);
  assert.equal((await f.post(f.body())).status, 200);
});

test("partial rejections and unretained settings are explicit failures, never automatically retried", async (t) => {
  for (const change of [{ rejectDimmingKey: "screensaver.mode" }, { ignoreDimmingSaves: true }]) await t.test(JSON.stringify(change), async (t) => {
    const f = await setup(t);
    Object.assign(f.mode, change);
    const response = await f.post(f.body());
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /settings|retain/);
    assert.equal(f.dimming.snapshot().ready, false);
    assert.equal(f.calls.filter((call) => call.name === "patchSettings").length, 1);
    assert.ok(f.warnings.length > 0);
  });
});

test("a lost patch acknowledgement is not retried and can be resolved by freshly reading native settings", async (t) => {
  const f = await setup(t);
  const original = f.client.fetch;
  f.client.timeoutMs = 100;
  f.client.fetch = async (url, options) => {
    const response = await original(url, options);
    if (options.method !== "PATCH") return response;
    return new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  await assert.rejects(f.dashboard.saveKioskDimming(f.body()), /Some display settings may have changed/);
  assert.equal(f.calls.filter((call) => call.name === "patchSettings").length, 1);
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().ready, true);
});

test("missing/unsupported/malformed native settings are explicit and schema polling is bounded", async (t) => {
  const missing = new KioskDimming();
  assert.equal(missing.snapshot().configured, false);
  assert.equal(missing.snapshot().can_configure, false);
  const f = await setup(t);
  const reads = f.calls.filter((call) => call.name === "getSettings").length;
  await f.dimming.refresh();
  assert.equal(f.calls.filter((call) => call.name === "getSettings").length, reads);
  delete f.settings["screensaver.postpone_on_proximity"];
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().connected, false);
  assert.ok(f.dimming.snapshot().error);
  f.mode.dimmingUnsupported = true;
  await f.dimming.refresh(true);
  assert.equal(f.dimming.snapshot().can_configure, false);
});

test("methods, strict JSON and cross-site guards scope requests; metadata and secrets are excluded from snapshots", async (t) => {
  const f = await setup(t, { backend: "kiosk_satellite" });
  assert.equal((await fetch(`${f.url}/api/kiosk/dimming/save`)).status, 405);
  assert.equal((await fetch(`${f.url}/api/kiosk/dimming?settings=x`)).status, 400);
  assert.equal((await f.post(f.body(), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const status = await (await fetch(`${f.url}/api/kiosk/dimming`)).text();
  assert.doesNotMatch(status, /fictional-secret|ha\.password|clock-radio-fictional-kiosk/);
  const saved = [];
  const store = new SnapshotStore({ storage: () => ({ getItem: () => null, setItem: (_, value) => saved.push(value) }) });
  store.save(f.dashboard.payload());
  assert.equal(saved.length, 1);
  assert.doesNotMatch(saved[0], /kiosk_dimming|fictional-secret/);
});

test("dimming messages distinguish configured, incomplete, unavailable and offline states", () => {
  const state = { configured: true, connected: true, ready: true, enabled: true, alarm_phase: "idle" };
  assert.match(kioskDimmingMessage(state), /10% after 10 minutes/);
  assert.match(kioskDimmingMessage({ ...state, ready: false }), /different native Dim configuration/);
  assert.match(kioskDimmingMessage({ ...state, connected: false, error: "Native offline" }), /Native offline/);
  assert.match(kioskDimmingMessage(state, true), /saved behavior continues on KS/);
});
