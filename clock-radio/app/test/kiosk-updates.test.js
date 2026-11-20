import assert from "node:assert/strict";
import test from "node:test";
import { KioskAlarms } from "../src/kiosk-alarms.js";
import { KioskUpdates, newerKioskVersion } from "../src/kiosk-updates.js";
import { createKioskDemo, DEMO_KIOSK_TOKEN } from "../dev/kiosk-fixtures.js";
import { Dashboard } from "../src/dashboard.js";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { SnapshotStore, offlineStatus } from "../web/js/core/snapshot.js";
import { kioskUpdateMessage } from "../web/js/pages/settings.js";

async function setup(t, { backend = "home_assistant", readOnly = false } = {}) {
  const fixture = createKioskDemo();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.server.close(); fixture.server.closeAllConnections(); });
  const warnings = [], haCalls = [];
  const logger = { warn: (message) => warnings.push(message) };
  const client = new KioskAlarms({ url: `http://127.0.0.1:${fixture.server.address().port}`, token: DEMO_KIOSK_TOKEN, logger });
  const updater = new KioskUpdates({ client, logger });
  const dashboard = new Dashboard({
    kiosk: backend === "kiosk_satellite" ? client : null, kioskUpdates: updater,
    version: "0.24.0", demo: true, readOnly, logger,
    configStore: { current: parseConfig({ time_zone: "Europe/Copenhagen" }), load() {} },
    ha: { async states() { throw new Error("Fictional HA offline"); }, async callService(...args) { haCalls.push(args); } },
  });
  await dashboard.refresh();
  const server = createServer({ dashboard, webRoot: new URL("../web/", import.meta.url).pathname, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(`${url}/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const offer = () => ({ version: updater.snapshot().available_version, device_id: client.backendId, confirmed: true });
  return { ...fixture, client, updater, dashboard, warnings, haCalls, url, post, offer };
}

test("newer versions follow KS's numeric-triple comparison, not lexicographic order or build suffixes", () => {
  for (const [remote, current] of [
    ["2030.1.2", "2030.1.1+9"], ["0.10.0", "0.9.9"], ["v1.0.0", "0.99.9"], ["1.2.4-beta", "1.2.3"],
  ]) assert.equal(newerKioskVersion(remote, current), true);
  for (const [remote, current] of [
    ["2030.1.1", "2030.1.1+100"], ["1.2.3-beta", "1.2.3"], ["0.9.9", "0.10.0"], ["bad", "1.0.0"], [null, "1.0.0"],
  ]) assert.equal(newerKioskVersion(remote, current), false);
});

test("checks and installation work with either alarm backend while HA is offline, without changing schedules", async (t) => {
  for (const backend of ["home_assistant", "kiosk_satellite"]) await t.test(backend, async (t) => {
    const f = await setup(t, { backend });
    const original = structuredClone(f.alarms);
    assert.equal(f.dashboard.payload().connected, false);
    assert.equal(f.dashboard.payload().alarms.backend, backend);
    assert.equal(f.dashboard.payload().kiosk_update.can_install, true);
    if (backend === "home_assistant") assert.match(offlineStatus(f.dashboard.payload()), /HA controls are read-only.*KS update controls are connected/);
    assert.equal((await f.post("api/kiosk/update/check", {})).status, 200);
    assert.ok(f.updater.snapshot().checked_at);
    assert.equal(f.calls.filter((c) => c.name === "checkUpdateNow").length, 1);
    const response = await f.post("api/kiosk/update/install", f.offer());
    assert.equal(response.status, 200);
    const accepted = await response.json();
    assert.equal(accepted.request_state, "requested");
    assert.notEqual(accepted.request_state, "completed");
    assert.equal(f.updates.progress, 0);
    assert.equal((await f.post("api/kiosk/update/install", f.offer())).status, 409);
    assert.deepEqual(f.calls.filter((c) => c.name === "installUpdate").map((c) => c.data), [{}]);
    f.updates.progress = null;
    f.updates.availableVersion = null;
    f.updates.currentVersion = "2030.1.2+2";
    f.updates.lastOutcome = "silent";
    await f.dashboard.refresh();
    assert.equal(f.updater.snapshot().request_state, "completed");
    assert.equal(f.updater.snapshot().current_version, "2030.1.2+2");
    assert.deepEqual(f.haCalls, []);
    assert.deepEqual(f.alarms, original);
  });
});

test("native update metadata keeps refreshing while an earlier HA refresh is stalled", async (t) => {
  const f = await setup(t);
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  f.dashboard.ha.states = () => stalled;
  const first = f.dashboard.refresh();
  await f.updater.loading;
  f.updates.progress = 0.5;
  const second = f.dashboard.refresh();
  try {
    await f.updater.loading;
    assert.equal(f.updater.snapshot().progress, 0.5);
  } finally {
    release([]);
    await Promise.all([first, second]);
  }
});

test("native alarms, sunrise, snooze, existing downloads and installs block installation", async (t) => {
  const f = await setup(t);
  for (const phase of ["ringing", "sunrise", "snoozed"]) {
    f.mode.phase = phase; f.mode.ids = ["personal-native-alarm"];
    await f.updater.refresh();
    assert.equal(f.updater.snapshot().can_install, false);
    await assert.rejects(f.dashboard.installKioskUpdate(f.offer()), { status: 409 });
  }
  f.mode.phase = "idle"; f.mode.ids = [];
  for (const [progress, installing] of [[0, false], [0.5, false], [null, true]]) {
    f.updates.progress = progress; f.updates.installing = installing;
    await f.updater.refresh();
    assert.equal(f.updater.snapshot().can_install, false);
    await assert.rejects(f.dashboard.installKioskUpdate(f.offer()), { status: 409 });
  }
  assert.ok(!f.calls.some((c) => c.name === "installUpdate"));
});

test("confirmation, current device and offered version are mandatory; arbitrary APK/command fields are refused", async (t) => {
  const f = await setup(t);
  for (const body of [null, [], {}, { ...f.offer(), confirmed: false }, { ...f.offer(), device_id: "b".repeat(16) },
    { ...f.offer(), url: "https://example.com/arbitrary.apk" }, { ...f.offer(), action: "installUploadedApk" }]) {
    assert.equal((await f.post("api/kiosk/update/install", body)).status, 400);
  }
  assert.equal((await f.post("api/kiosk/update/install", { ...f.offer(), version: "2030.1.3" })).status, 409);
  f.updates.availableVersion = null;
  assert.equal((await f.post("api/kiosk/update/install", { version: "2030.1.2", device_id: f.client.backendId, confirmed: true })).status, 409);
  assert.ok(!f.calls.some((c) => c.name === "installUpdate"));
});

test("read-only mode permits metadata checks but refuses installation before making native calls", async (t) => {
  const f = await setup(t, { readOnly: true });
  const before = f.calls.length;
  assert.equal((await f.post("api/kiosk/update/install", f.offer())).status, 403);
  assert.equal(f.calls.length, before);
  assert.equal(f.dashboard.payload().kiosk_update.can_install, false);
  const checked = await f.post("api/kiosk/update/check", {});
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).can_install, false);
  assert.equal((await (await fetch(`${f.url}/api/kiosk/update`)).json()).can_install, false);
  assert.equal(f.dashboard.payload().read_only, true);
});

test("release-source failure disables stale offers until an explicit successful check", async (t) => {
  const f = await setup(t);
  f.mode.updateUnreachable = true;
  assert.equal((await f.post("api/kiosk/update/check", {})).status, 502);
  assert.match(f.updater.snapshot().error, /configured update source/);
  assert.equal(f.updater.snapshot().can_install, false);
  assert.equal((await f.post("api/kiosk/update/install", f.offer())).status, 409);
  f.mode.updateUnreachable = false;
  assert.equal((await f.post("api/kiosk/update/check", {})).status, 200);
  assert.equal(f.updater.snapshot().can_install, true);
});

test("a failed native download requires checking again, without silently retrying installation", async (t) => {
  const f = await setup(t);
  await f.dashboard.installKioskUpdate(f.offer());
  await f.updater.refresh();
  f.updates.progress = null;
  f.updates.lastOutcome = "failed";
  await f.updater.refresh();
  assert.equal(f.updater.snapshot().can_install, false);
  assert.match(f.updater.snapshot().error, /check for updates before manually retrying/);
  await assert.rejects(f.dashboard.installKioskUpdate(f.offer()), { status: 409 });
  assert.equal(f.calls.filter((c) => c.name === "installUpdate").length, 1);
  await f.dashboard.checkKioskUpdate({});
  assert.equal(f.updater.snapshot().can_install, true);
});

test("a native failure discovered after restart also requires an explicit successful recheck", async (t) => {
  const f = await setup(t);
  f.updates.lastOutcome = "failed";
  const restarted = new KioskUpdates({ client: f.client, logger: { warn() {} } });
  await restarted.refresh();
  assert.equal(restarted.snapshot().can_install, false);
  await assert.rejects(restarted.install(f.offer()), { status: 409 });
  await restarted.check();
  await restarted.refresh();
  assert.equal(restarted.snapshot().can_install, true);
  assert.equal(f.calls.filter((c) => c.name === "installUpdate").length, 0);
});

test("missing configuration, unsupported KS and invalid native status are explicit, non-installable states", async (t) => {
  const missing = new KioskUpdates({ configurationError: "Configure both KS address and token." });
  assert.equal(missing.snapshot().configured, false);
  assert.equal(missing.snapshot().can_install, false);
  assert.match(missing.snapshot().error, /address and token/);
  await assert.rejects(missing.check(), { status: 409 });
  const f = await setup(t);
  f.mode.updateUnsupported = true;
  await f.updater.refresh();
  assert.equal(f.updater.snapshot().connected, false);
  assert.ok(f.updater.snapshot().error);
  f.mode.updateUnsupported = false;
  for (const change of [{ progress: 1.01 }, { currentVersion: "unknown" }, { availableVersion: "2030.1.1" }, { installing: "yes" }]) {
    const previous = { ...f.updates };
    Object.assign(f.updates, change);
    await f.updater.refresh();
    assert.equal(f.updater.snapshot().connected, false);
    assert.equal(f.updater.snapshot().can_install, false);
    Object.assign(f.updates, previous);
  }
  assert.ok(f.warnings.length > 0);
  assert.ok(!f.calls.some((c) => c.name === "installUpdate"));
});

test("a lost install acknowledgement is not retried; fresh native progress and installed version resolve it", async (t) => {
  const f = await setup(t);
  const fetchImpl = f.client.fetch;
  f.client.timeoutMs = 100;
  f.client.fetch = async (url, options) => {
    const response = await fetchImpl(url, options);
    if (!url.endsWith("/installUpdate")) return response;
    return new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  await assert.rejects(f.dashboard.installKioskUpdate(f.offer()), /update may already be running/);
  assert.equal(f.updater.snapshot().request_state, "unknown");
  assert.equal(f.updater.snapshot().can_install, false);
  await assert.rejects(f.dashboard.installKioskUpdate(f.offer()), { status: 409 });
  assert.equal(f.calls.filter((c) => c.name === "installUpdate").length, 1);
  await f.updater.refresh();
  assert.equal(f.updater.snapshot().request_state, "requested");
  assert.equal(f.updater.snapshot().progress, 0);
  f.updates.progress = null; f.updates.availableVersion = null; f.updates.currentVersion = "2030.1.2+2";
  await f.updater.refresh();
  assert.equal(f.updater.snapshot().request_state, "completed");
  assert.equal(f.updater.snapshot().error, null);
});

test("a slow pre-install status response cannot overwrite the operation's newer state", async () => {
  const state = { currentVersion: "2030.1.1+1", availableVersion: "2030.1.2", progress: null };
  let lag = false, finish, installs = 0;
  const client = { backendId: "a".repeat(16), async command(name) {
    if (name === "alarmsStatus") return { phase: "idle", ids: [] };
    if (name === "getUpdateStatus") {
      if (lag) { lag = false; return new Promise((resolve) => { finish = resolve; }); }
      return structuredClone(state);
    }
    if (name === "installUpdate") { installs++; state.progress = 0; return true; }
    throw new Error(name);
  } };
  const updater = new KioskUpdates({ client });
  await updater.refresh();
  lag = true;
  const old = updater.refresh();
  await updater.install({ version: "2030.1.2", device_id: client.backendId, confirmed: true });
  finish({ currentVersion: "2000.1.1", availableVersion: "2030.1.2", progress: null });
  await old;
  assert.equal(updater.snapshot().current_version, "2030.1.1+1");
  assert.equal(updater.snapshot().request_state, "requested");
  assert.equal(updater.snapshot().can_install, false);
  assert.equal(installs, 1);
});

test("update HTTP methods, JSON validation and cross-site protections do not expose arbitrary native commands", async (t) => {
  const f = await setup(t);
  assert.equal((await fetch(`${f.url}/api/kiosk/update/install`)).status, 405);
  assert.equal((await fetch(`${f.url}/api/kiosk/update/check`)).status, 405);
  assert.equal((await f.post("api/kiosk/update/check", { url: "https://example.com" })).status, 400);
  assert.equal((await f.post("api/kiosk/update/install", f.offer(), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await f.post("api/kiosk/update/check", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${f.url}/api/kiosk/update?url=x`)).status, 400);
  assert.ok(!f.calls.some((c) => ["checkUpdateNow", "installUpdate"].includes(c.name)));
});

test("credentials, native APK paths/raw errors and update metadata never enter browser snapshots", async (t) => {
  const f = await setup(t, { backend: "kiosk_satellite" });
  f.updates.uploaded = { path: "/private/fictional-update.apk", token: "fictional-secret" };
  f.updates.lastError = "fictional-secret";
  await f.updater.refresh();
  const body = await (await fetch(`${f.url}/api/kiosk/update`)).text();
  assert.doesNotMatch(body, /fictional-secret|fictional-update\.apk|clock-radio-fictional-kiosk/);
  assert.ok(!body.includes(f.client.url));
  const saved = [];
  const snapshots = new SnapshotStore({ storage: () => ({ getItem: () => null, setItem: (_, value) => saved.push(value) }) });
  snapshots.save(f.dashboard.payload());
  assert.equal(saved.length, 1);
  assert.doesNotMatch(saved[0], /kiosk_update|available_version|current_version|fictional-secret|fictional-update\.apk/);
});

test("UI reports native progress/handoff honestly and never treats a cached or unconfirmed offer as installed", () => {
  const base = { configured: true, connected: true, progress: null, installing: false, alarm_phase: "idle",
    available_version: "2030.1.2", current_version: "2030.1.1+1", request_state: "idle" };
  assert.match(kioskUpdateMessage({ ...base, progress: 0 }), /0%/);
  assert.match(kioskUpdateMessage({ ...base, progress: 0.555 }), /56%/);
  assert.match(kioskUpdateMessage({ ...base, installing: true }), /installing/);
  assert.match(kioskUpdateMessage({ ...base, request_state: "requested", last_outcome: "confirm" }), /Confirm installation on the KS device/);
  assert.match(kioskUpdateMessage({ ...base, request_state: "unknown" }), /unconfirmed/);
  assert.match(kioskUpdateMessage({ ...base, request_state: "completed", current_version: "2030.1.2+2" }), /now runs 2030\.1\.2/);
  assert.match(kioskUpdateMessage({ ...base, available_version: null }), /Check for updates to verify/);
  assert.match(kioskUpdateMessage({ ...base, available_version: null, checked_at: "2030-01-01T00:00:00Z" }), /up to date/);
  assert.match(kioskUpdateMessage(base, true), /Offline/);
});
