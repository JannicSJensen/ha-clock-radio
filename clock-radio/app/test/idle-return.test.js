import assert from "node:assert/strict";
import test from "node:test";
import { IdleReturn } from "../web/js/core/idle-return.js";

test("the default timeout expires at exactly two minutes, not during polling", () => {
  const idle = new IdleReturn();
  assert.equal(idle.expired({}, 0), false);
  for (let now = 5000; now < 120_000; now += 5000) assert.equal(idle.expired({}, now), false);
  assert.equal(idle.expired({}, 119_999), false);
  assert.equal(idle.expired({}, 120_000), true);
});

test("user activity and page navigation restart the full inactivity countdown", () => {
  const idle = new IdleReturn();
  idle.expired({}, 0);
  for (const now of [119_999, 239_998, 359_997]) {
    idle.reset(now);
    assert.equal(idle.expired({}, now + 119_999), false);
  }
  assert.equal(idle.expired({}, 479_997), true);
});

test("dialogs, held pointers, saves and the clock pause the timeout until unblocked", () => {
  const idle = new IdleReturn();
  idle.expired({}, 0);
  assert.equal(idle.expired({ paused: true }, 119_000), false);
  assert.equal(idle.expired({ paused: true }, 900_000), false);
  assert.equal(idle.expired({}, 950_000), false);
  assert.equal(idle.expired({}, 1_069_999), false);
  assert.equal(idle.expired({}, 1_070_000), true);
});

test("zero disables automatic return and re-enabling starts a fresh countdown", () => {
  const idle = new IdleReturn();
  idle.expired({}, 0);
  assert.equal(idle.expired({ minutes: 0 }, 120_000), false);
  assert.equal(idle.expired({ minutes: 0 }, 86_400_000), false);
  assert.equal(idle.expired({ minutes: 1 }, 86_400_000), false);
  assert.equal(idle.expired({ minutes: 1 }, 86_459_999), false);
  assert.equal(idle.expired({ minutes: 1 }, 86_460_000), true);
});

test("timeout changes restart the countdown and delayed callbacks use elapsed time", () => {
  const idle = new IdleReturn();
  idle.expired({ minutes: 1 }, 0);
  assert.equal(idle.expired({ minutes: 3 }, 59_999), false);
  assert.equal(idle.expired({ minutes: 3 }, 239_998), false);
  assert.equal(idle.expired({ minutes: 3 }, 239_999), true);
  idle.reset(240_000);
  assert.equal(idle.expired({ minutes: 3 }, 600_000), true);
});
