import assert from "node:assert/strict";
import test from "node:test";
import { alarmSnapshot } from "../src/alarms.js";
import { createDemoAPI, demoStates } from "../dev/fixtures.js";
import { alarmKey, ringingTime } from "../web/js/components/alarm-screen.js";
import { completesStop, STOP_THRESHOLD } from "../web/js/components/slide-to-stop.js";

test("ordinary music, idle timers and a stale speaker alone never count as a ringing alarm", () => {
  const states = demoStates();
  assert.equal(states[0].state, "playing");
  assert.equal(alarmSnapshot(states).active, null);
  states.find((state) => state.entity_id === "input_text.clock_radio_active_player").state = "media_player.bedroom";
  assert.equal(alarmSnapshot(states).active, null);
});

test("captured type survives edits/replacement, and incomplete cleanup stays visible until HA clears it", () => {
  const demo = createDemoAPI();
  demo.startAlarm(2);
  let snapshot = alarmSnapshot(demo.states);
  assert.equal(snapshot.active.type, "Buzzer");
  assert.equal(snapshot.active.id, 2);
  assert.equal(snapshot.can_snooze, true);
  const key = alarmKey(snapshot.active);
  assert.notEqual(alarmKey({ ...snapshot.active, id: 42 }), key);
  demo.states.find((state) => state.entity_id === "input_select.clock_radio_alarm_2_type").state = "Music";
  assert.equal(alarmSnapshot(demo.states).active.type, "Buzzer");
  demo.startAlarm(1);
  snapshot = alarmSnapshot(demo.states);
  assert.equal(snapshot.active.type, "Music");
  assert.notEqual(alarmKey(snapshot.active), key);
  assert.equal(snapshot.alarms.filter((alarm) => alarm.timer === "active").length, 1);
  demo.states.find((state) => state.entity_id === "timer.clock_radio_alarm_1").state = "idle";
  assert.equal(alarmSnapshot(demo.states).active.id, 1, "A cancelled timer is not confirmation of successful sound/volume cleanup");
  assert.equal(alarmSnapshot(demo.states).can_snooze, false);
  demo.states.find((state) => state.entity_id === "input_text.clock_radio_active_alarm").state = "";
  demo.states.find((state) => state.entity_id === "input_text.clock_radio_active_player").state = "";
  assert.equal(alarmSnapshot(demo.states).active, null);
  demo.startAlarm(2);
  demo.advanceAlarms(Date.parse(alarmSnapshot(demo.states).active.finishes_at));
  assert.equal(alarmSnapshot(demo.states).active, null, "Wake timer expiry must run alarm cleanup");
});

test("legacy packages still show the ringing screen but cannot offer snooze", () => {
  const demo = createDemoAPI();
  demo.startAlarm(1);
  const states = demo.states.filter((state) => state.entity_id !== "input_text.clock_radio_active_alarm");
  assert.equal(alarmSnapshot(states).active.type, "Music");
  assert.equal(alarmSnapshot(states).can_snooze, false);
  states.find((state) => state.entity_id === "timer.clock_radio_alarm_2").state = "active";
  assert.equal(alarmSnapshot(states).active, null, "Do not guess between multiple legacy timers");
});

test("packages with fractional-deadline bugs retain Stop but cannot create new snoozes", () => {
  const demo = createDemoAPI();
  demo.startAlarm(2);
  const version = demo.states.find((state) => state.entity_id === "sensor.clock_radio_alarm_scheduler_version");
  for (const old of ["3", "4", "5", "unknown"]) {
    version.state = old;
    const snapshot = alarmSnapshot(demo.states);
    assert.equal(snapshot.active.type, "Buzzer");
    assert.equal(snapshot.can_stop, true);
    assert.equal(snapshot.can_snooze, false);
  }
  version.state = "6";
  assert.equal(alarmSnapshot(demo.states).can_snooze, true);
});

test("exact and recovery triggers resume legacy fractional snoozes once for either captured type", () => {
  for (const [id, type, delay] of [[1, "Music", 4], [2, "Buzzer", 4], [1, "Music", 60004], [2, "Buzzer", 60004]]) {
    const demo = createDemoAPI();
    demo.startAlarm(id);
    const entity = (name) => demo.states.find((state) => state.entity_id === name);
    entity("input_text.clock_radio_snoozed_alarm").state = entity("input_text.clock_radio_active_alarm").state;
    entity("input_text.clock_radio_active_alarm").state = "";
    entity("input_text.clock_radio_active_player").state = "";
    entity(`timer.clock_radio_alarm_${id}`).state = "idle";
    entity(`input_select.clock_radio_alarm_${id}_type`).state = type === "Music" ? "Buzzer" : "Music";
    const timestamp = Date.parse("2030-01-01T06:10:00.875Z") / 1000;
    entity("input_datetime.clock_radio_snooze_until").attributes.timestamp = timestamp;
    const triggerAt = Math.floor(timestamp) * 1000 + delay;
    demo.advanceAlarms(Math.floor(timestamp) * 1000 - 1);
    assert.equal(alarmSnapshot(demo.states).active, null);
    demo.advanceAlarms(triggerAt);
    const resumed = alarmSnapshot(demo.states);
    assert.equal(resumed.active.type, type);
    assert.equal(resumed.snoozed, null);
    demo.advanceAlarms(triggerAt + 100);
    assert.deepEqual(alarmSnapshot(demo.states).active, resumed.active);
  }
});

test("invalid captured context/deadlines surface errors and unavailable snooze helpers block commands", () => {
  const demo = createDemoAPI();
  demo.startAlarm(1);
  const captured = demo.states.find((state) => state.entity_id === "input_text.clock_radio_active_alarm");
  for (const invalid of ["{broken", "null", '{"id":0,"type":"Music"}', '{"id":1,"type":"Other"}']) {
    captured.state = invalid;
    const snapshot = alarmSnapshot(demo.states);
    assert.equal(snapshot.active, null);
    assert.equal(snapshot.can_snooze, false);
    assert.match(snapshot.active_error, /Invalid/);
  }
  demo.startAlarm(1);
  demo.states.find((state) => state.entity_id === "script.clock_radio_snooze").state = "unavailable";
  assert.equal(alarmSnapshot(demo.states).can_snooze, false);
  demo.states.find((state) => state.entity_id === "input_text.clock_radio_snoozed_alarm").state = '{"id":1,"type":"Music"}';
  demo.states.find((state) => state.entity_id === "input_datetime.clock_radio_snooze_until").attributes.timestamp = Infinity;
  assert.match(alarmSnapshot(demo.states).active_error, /deadline/);
  assert.equal(alarmSnapshot(demo.states).snoozed, null);
});

test("slide completion requires the explicit 90% threshold and ringing time follows clock locale/zone", () => {
  assert.equal(STOP_THRESHOLD, 90);
  for (const value of [0, 50, 89.99, NaN, Infinity]) assert.equal(completesStop(value), false);
  for (const value of [90, 99, 100]) assert.equal(completesStop(value), true);
  const now = new Date("2026-11-14T15:35:00Z");
  assert.deepEqual(ringingTime({ locale: "en-GB", timeZone: "Europe/Copenhagen", timeFormat: "24-hour" }, now), { time: "16:35", period: "" });
  assert.deepEqual(ringingTime({ locale: "en-US", timeZone: "Europe/Copenhagen", timeFormat: "12-hour" }, now), { time: "04:35", period: "PM" });
  assert.deepEqual(ringingTime({ locale: "en-US", timeZone: "UTC", timeFormat: "12-hour" }, new Date("2026-11-14T00:00:00Z")), { time: "12:00", period: "AM" });
});
