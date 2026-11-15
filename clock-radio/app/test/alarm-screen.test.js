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
