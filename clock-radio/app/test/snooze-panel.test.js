import assert from "node:assert/strict";
import test from "node:test";
import { snoozeKey, snoozeSeconds } from "../web/js/components/snooze-panel.js";

test("snooze countdown follows the absolute HA deadline without rounding early or going negative", () => {
  const now = Date.parse("2026-11-15T17:00:00Z");
  const until = new Date(now + 600000).toISOString();
  for (const [elapsed, seconds] of [[0, 600], [1, 600], [1000, 599], [599000, 1], [599999, 1], [600000, 0], [700000, 0]]) {
    assert.equal(snoozeSeconds(until, now + elapsed), seconds);
  }
  assert.throws(() => snoozeSeconds("invalid", now), /Invalid snooze deadline/);
});

test("snooze identity distinguishes replacement alarms, types and new deadlines", () => {
  const alarm = { id: 1, type: "Music", until: "2026-11-15T17:10:00.000Z" };
  assert.equal(snoozeKey(null), null);
  assert.equal(snoozeKey({ ...alarm }), snoozeKey(alarm));
  for (const change of [{ id: 2 }, { type: "Buzzer" }, { until: "2026-11-15T17:20:00.000Z" }]) {
    assert.notEqual(snoozeKey({ ...alarm, ...change }), snoozeKey(alarm));
  }
});
