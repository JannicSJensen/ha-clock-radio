import assert from "node:assert/strict";
import test from "node:test";
import { KioskAlarmUI, validNativeRing } from "../web/js/core/kiosk-alarm-ui.js";
import { alarmKey } from "../web/js/components/alarm-screen.js";

const device = "a".repeat(32);
const id = `clock-radio-${"b".repeat(32)}`;
function setup(options = {}) {
  const calls = [], warnings = [];
  const model = {
    connected: false, read_only: false, alarms: {
      backend: "kiosk_satellite", connected: true,
      presentation: { requested: true, supported: true, enabled: true, device },
      active: null, snoozed: null, can_stop: false, can_snooze: false,
    },
  };
  const f = {
    model, calls, warnings, visible: true, painted: true,
    data: {
      ok: true, version: 1, device, snoozeMinutes: 15,
      context: { phase: "ringing", ids: [id], at: "2030-01-01T07:00:00Z", snoozedUntil: null, generation: 1 },
      alarms: [{ id, label: "Morning", type: "Music", station: "Morning Radio", speaker: "This device" }],
    },
  };
  const bridge = { async alarmUi(action, context) {
    calls.push({ action, context: structuredClone(context) });
    if (f.override) return f.override(action, context);
    if (["present", "stop", "snooze"].includes(action) && JSON.stringify(context) !== JSON.stringify(f.data.context)) return { ok: false, error: "alarm_context_changed" };
    if (action === "snooze") f.data.context = { ...f.data.context, phase: "snoozed", snoozedUntil: "2030-01-01T07:15:00Z", generation: 2 };
    if (action === "stop") {
      f.data.context = { ...f.data.context, phase: "idle", ids: [], generation: 3 };
      f.data.alarms = [];
    }
    return structuredClone(f.data);
  } };
  f.ui = new KioskAlarmUI({
    getModel: () => model, render: () => { f.view = f.ui.apply(model); },
    bridge: () => bridge, visible: () => f.visible, afterPaint: async () => f.painted,
    warn: (message) => warnings.push(message), ...options,
  });
  return f;
}

test("native handoff waits for rendered controls and works without HA", async () => {
  const f = setup();
  await f.ui.refresh();
  assert.deepEqual(f.calls.map((c) => c.action), ["status", "present"]);
  assert.equal(f.view.alarms.active.label, "Morning");
  assert.equal(f.view.alarms.active.station, "Morning Radio");
  assert.equal(f.view.alarms.can_stop, true);
  assert.equal(f.view.alarms.can_snooze, true);
  assert.equal(f.model.connected, false);
  await f.ui.refresh();
  assert.equal(f.calls.filter((c) => c.action === "present").length, 2, "A new heartbeat renews the native lease");
});

test("native Snooze and Stop use exact contexts and immediately confirm native state", async () => {
  const f = setup();
  await f.ui.refresh();
  const before = structuredClone(f.view.alarms.active.native_context);
  await f.ui.control("snooze", before);
  assert.equal(f.view.alarms.active, null);
  assert.equal(f.view.alarms.snoozed.until, "2030-01-01T07:15:00Z");
  await assert.rejects(f.ui.control("stop", before), /changed/);
  await f.ui.control("stop", f.view.alarms.snoozed.native_context);
  assert.equal(f.view.alarms.snoozed, null);
  assert.equal(f.calls.filter((c) => c.action === "stop").length, 1);
});

test("old KS, disabled trust, native mode, read-only, snapshots and hidden pages cannot lease", async () => {
  for (const change of [
    (f) => { f.model.alarms.presentation.supported = false; },
    (f) => { f.model.alarms.presentation.enabled = false; },
    (f) => { f.model.alarms.presentation.requested = false; },
    (f) => { f.model.read_only = true; },
    (f) => { f.model.offline_snapshot = true; },
    (f) => { f.model.alarms.connected = false; },
    (f) => { f.visible = false; },
  ]) {
    const f = setup(); change(f);
    await f.ui.refresh();
    assert.deepEqual(f.calls, []);
    assert.equal(f.view.alarms.active, null);
  }
  const f = setup({ bridge: () => null });
  await f.ui.refresh();
  assert.equal(f.calls.length, 0);
});

test("unpainted UI, wrong devices, malformed state and unrelated alarm groups retain native UI", async () => {
  for (const change of [
    (f) => { f.painted = false; },
    (f) => { f.data.device = "c".repeat(32); },
    (f) => { f.data.context.ids.push("personal-alarm"); },
    (f) => { f.data.context.at = "unknown"; },
    (f) => { f.data.snoozeMinutes = 0; },
    (f) => { f.data.alarms[0].label = null; },
  ]) {
    const f = setup(); change(f);
    await f.ui.refresh();
    assert.ok(!f.calls.some((c) => c.action === "present"));
    assert.equal(f.ui.state, null);
    assert.ok(f.warnings.length > 0);
  }
});

test("connection/visibility loss releases an existing lease", async () => {
  const f = setup();
  await f.ui.refresh();
  f.model.alarms.connected = false;
  await f.ui.refresh();
  assert.equal(f.calls.at(-1).action, "release");
  assert.equal(f.view.alarms.active, null);
  assert.equal(f.ui.lease, null);
});

test("disabled or missing ringing controls release an existing presentation", async () => {
  const f = setup();
  await f.ui.refresh();
  f.painted = false;
  await f.ui.refresh();
  assert.equal(f.calls.filter((c) => c.action === "present").length, 1);
  assert.equal(f.calls.at(-1).action, "release");
  assert.equal(f.ui.state, null);
  assert.match(f.ui.error, /usable ringing controls/);
});

test("context rejection and hung writes fail explicitly and are never automatically retried", async () => {
  const f = setup({ timeoutMs: 5 });
  await f.ui.refresh();
  f.override = (action) => action === "stop" ? new Promise(() => {}) : structuredClone(f.data);
  await assert.rejects(f.ui.control("stop", f.ui.state.context), /timed out/);
  assert.equal(f.calls.filter((c) => c.action === "stop").length, 1);
  assert.equal(f.ui.state, null);
  assert.match(f.ui.error, /timed out/);
});

test("a page disappearing while status is in flight cannot subsequently take presentation", async () => {
  const f = setup();
  let finish;
  f.override = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.ui.refresh();
  await f.ui.release();
  finish(structuredClone(f.data));
  await pending;
  assert.ok(!f.calls.some((c) => c.action === "present"));
});

test("native UI identity distinguishes generations and complete simultaneous groups", () => {
  const f = setup();
  assert.equal(validNativeRing(f.data), true);
  const alarm = { id, type: "Music", player: "", native_context: f.data.context };
  assert.notEqual(alarmKey(alarm), alarmKey({ ...alarm, native_context: { ...f.data.context, generation: 2 } }));
  assert.notEqual(alarmKey(alarm), alarmKey({ ...alarm, native_context: { ...f.data.context, ids: [id, `clock-radio-${"d".repeat(32)}`] } }));
});
