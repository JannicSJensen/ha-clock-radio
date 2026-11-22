import assert from "node:assert/strict";
import test from "node:test";
import { weatherHeading, weatherTemperatureSize } from "../web/clock/weather-layout.js";

test("weather heading uses the clock's local day and locale alongside the place", () => {
  const now = new Date("2026-11-22T23:59:00Z");
  assert.equal(weatherHeading(now, "da-DK", "Hjem"), "Hjem · 22. nov. 2026");
  assert.equal(weatherHeading(now, "en-GB", ""), "22 Nov 2026");
  assert.equal(weatherHeading(new Date("2026-11-23T00:00:00Z"), "en-GB", "Home"), "Home · 23 Nov 2026");
});

test("weather temperature tracks the clock digits in each split clock view", () => {
  assert.equal(weatherTemperatureSize(36, 200), 36);
  assert.equal(weatherTemperatureSize(23, 216), 23 * 200 / 216);
  assert.equal(weatherTemperatureSize(54, 200), 54);
  assert.equal(weatherTemperatureSize(66, 200), 66);
});
