import assert from "node:assert/strict";
import test from "node:test";
import { alarmLabel, alarmSettings, canEditAlarm, repeatLabel } from "../web/js/pages/alarms.js";
import { timeParts, to24Hour } from "../web/js/components/time-picker.js";
import { validateAlarm } from "../src/alarms.js";

const days = (selected) => Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, selected.includes(day)]));

test("wheel selections preserve every hour and minute in 12-hour and 24-hour modes", () => {
  for (const hour12 of [false, true]) {
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const parts = timeParts(hour, minute, hour12);
        assert.equal(to24Hour(parts.hour, parts.period, hour12), hour);
        assert.equal(parts.minute, minute);
      }
    }
  }
  assert.deepEqual(timeParts(0, 0, true), { hour: 12, minute: 0, period: 0 });
  assert.deepEqual(timeParts(12, 0, true), { hour: 12, minute: 0, period: 1 });
  assert.deepEqual(timeParts(23, 59, true), { hour: 11, minute: 59, period: 1 });
});

test("wheel conversions reject invalid values rather than substituting a time", () => {
  for (const [hour, minute] of [[-1, 0], [24, 0], [1.5, 0], [null, 0], [0, -1], [0, 60], [0, "30"]]) {
    assert.throws(() => timeParts(hour, minute));
  }
  for (const [hour, period, hour12] of [[0, 0, true], [13, 0, true], [24, 0, false], [12, 2, true], ["12", 0, true]]) {
    assert.throws(() => to24Hour(hour, period, hour12));
  }
});

test("repeat summaries distinguish disabled schedules from nonexistent one-shot alarms", () => {
  assert.equal(repeatLabel(days([])), "No repeat days");
  assert.equal(repeatLabel(days(["monday", "tuesday", "wednesday", "thursday", "friday"])), "Weekdays");
  assert.equal(repeatLabel(days(["saturday", "sunday"])), "Weekends");
  assert.equal(repeatLabel(days(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])), "Every day");
  assert.equal(repeatLabel(days(["tuesday", "saturday"])), "Tue, Sat");
});

test("alarm labels use time, type and repeat days rather than profile numbers", () => {
  const alarm = { id: 1, hour: 6, minute: 5, type: "Music", days: days(["monday", "tuesday", "wednesday", "thursday", "friday"]) };
  assert.equal(alarmLabel(alarm, false), "06:05 · Music · Weekdays");
  assert.equal(alarmLabel({ ...alarm, id: 42 }, false), alarmLabel(alarm, false));
  assert.equal(alarmLabel(alarm, true), "6:05 AM · Music · Weekdays");
  assert.equal(alarmLabel({ ...alarm, hour: 0 }, true), "12:05 AM · Music · Weekdays");
  assert.equal(alarmLabel({ ...alarm, hour: 12 }, true), "12:05 PM · Music · Weekdays");
  assert.equal(alarmLabel({ ...alarm, hour: 23, minute: 59, type: "Buzzer", days: days(["saturday", "sunday"]) }, true), "11:59 PM · Buzzer · Weekends");
  assert.equal(alarmLabel({ ...alarm, hour: null, type: null }, false), "--:-- · Unavailable · Weekdays");
  assert.equal(alarm.id, 1);
});

test("list switches send only supported settings and preserve every profile value", () => {
  const alarm = {
    id: 3, enabled: false, type: "Buzzer", hour: 23, minute: 59, volume: 0, duration: 120,
    days: days(["tuesday", "saturday"]), available: true, timer: "idle", missing: [],
  };
  const enabled = alarmSettings(alarm, true);
  assert.deepEqual(enabled, {
    id: 3, enabled: true, type: "Buzzer", hour: 23, minute: 59, volume: 0, duration: 120,
    days: alarm.days,
  });
  assert.deepEqual(validateAlarm(enabled), enabled);
  enabled.days.tuesday = false;
  assert.equal(alarm.days.tuesday, true);
  assert.equal(alarm.enabled, false);
  assert.throws(() => validateAlarm(alarmSettings({ ...alarm, days: days([]) }, true)), /weekday/);
});

test("invalid or incomplete HA helpers never become editable control defaults", () => {
  const alarm = { available: true, setup_complete: true, hour: 0, minute: 59, type: "Music", volume: 0, duration: 120 };
  assert.equal(canEditAlarm(alarm), true);
  for (const change of [
    { available: false }, { setup_complete: false }, { deletion_pending: true }, { hour: null }, { hour: 24 },
    { minute: -1 }, { type: "Other" }, { volume: null }, { volume: "50" },
    { volume: 101 }, { volume: 0.5 }, { duration: null }, { duration: 0 }, { duration: 121 },
  ]) assert.equal(canEditAlarm({ ...alarm, ...change }), false);
});
