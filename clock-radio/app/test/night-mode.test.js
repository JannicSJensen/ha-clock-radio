import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { ClockData, NIGHT_OVERRIDE_ENTITY } from "../src/clock-data.js";
import { parseConfig } from "../src/config.js";
import { CLOCK_CHOICES } from "../web/js/lib/clock-options.js";

const quiet = { warn() {} };
const settings = (night_mode = "sun") => parseConfig({
  time_zone: "Europe/Copenhagen",
  clock: { night_mode, night_entity: "sensor.room_light", night_threshold: 10, night_color: "#772211", night_brightness: 40 },
});
const sources = () => [
  { entity_id: "sun.sun", state: "above_horizon" },
  { entity_id: "sensor.room_light", state: "30" },
];
const helper = (state) => ({ entity_id: NIGHT_OVERRIDE_ENTITY, state });
const clock = () => new ClockData({ ha: {}, logger: quiet });
const payload = (data, config, states) => data.payload(config, { alarms: [] }, states, "Europe/Copenhagen");

test("the optional HA dropdown defaults to Auto and restores choices instead of resetting on restart", () => {
  const yaml = YAML.parse(fs.readFileSync(new URL("../../../examples/home-assistant/clock_radio_night_mode.yaml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(yaml), ["input_select"]);
  assert.deepEqual(Object.keys(yaml.input_select), [NIGHT_OVERRIDE_ENTITY.split(".")[1]]);
  const definition = Object.values(yaml.input_select)[0];
  assert.equal(definition.name, "Clock Radio night override");
  assert.deepEqual(definition.options, ["Auto", "Day", "Night"]);
  assert.equal(definition.icon, "mdi:theme-light-dark");
  assert.ok(!Object.hasOwn(definition, "initial"));
});

for (const mode of CLOCK_CHOICES.night_mode) {
  test(`Day/Night override ${mode}, and Auto restores the exact original renderer options`, async () => {
    const config = settings(mode);
    const original = JSON.stringify(config);
    const states = sources();
    const data = clock();
    await data.refresh(config, states, config.time_zone);
    const automatic = payload(data, config, states);
    assert.equal(data.override, null, "The helper is optional on existing installations");
    const control = helper("Auto");
    states.push(control);
    await data.refresh(config, states, config.time_zone);
    assert.deepEqual(payload(data, config, states), automatic);
    for (const [value, night, active] of [["Night", "always", true], ["Day", "off", false]]) {
      control.state = value;
      await data.refresh(config, states, config.time_zone);
      const actual = payload(data, config, states);
      assert.equal(actual.night, night);
      assert.equal(actual.nightActive, active);
      assert.equal(actual.nightColor, "#772211");
      assert.equal(actual.nightBrightness, 40);
      assert.equal(actual.night_error, null);
    }
    control.state = "Auto";
    await data.refresh(config, states, config.time_zone);
    assert.deepEqual(payload(data, config, states), automatic);
    assert.equal(JSON.stringify(config), original);
  });
}

test("invalid or missing installed helpers retain the last override, warn explicitly and recover", async () => {
  const config = settings();
  const data = clock();
  await data.refresh(config, [...sources(), helper("Night")], config.time_zone);
  for (const value of [undefined, "unknown", "unavailable", "", "night", "on", "0", "Auto "]) {
    const states = value === undefined ? sources() : [...sources(), helper(value)];
    await data.refresh(config, states, config.time_zone);
    const actual = payload(data, config, states);
    assert.equal(actual.night, "always");
    assert.equal(actual.nightActive, true);
    assert.equal(data.override.available, false);
    assert.match(actual.night_error, /input_select.clock_radio_night_override.*last valid override \(Night\)/);
  }
  const states = [...sources(), helper("Day")];
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).night, "off");
  assert.equal(payload(data, config, states).night_error, null);
  assert.equal(data.override.available, true);
  const restarted = clock();
  await restarted.refresh(config, states, config.time_zone);
  assert.equal(payload(restarted, config, states).night, "off");
});

test("an invalid helper on first start uses Auto with an explicit warning; an absent optional helper does not warn", async () => {
  const config = settings();
  const states = [...sources(), helper("unknown")];
  states[0].state = "below_horizon";
  const data = clock();
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).night, "entity");
  assert.equal(payload(data, config, states).nightActive, true);
  assert.match(payload(data, config, states).night_error, /last valid override \(Auto\)/);
  const absent = clock();
  await absent.refresh(config, sources(), config.time_zone);
  assert.equal(payload(absent, config, sources()).night_error, null);
});

test("automatic illuminance hysteresis continues independently while manual overrides are active", async () => {
  const config = settings("illuminance");
  const states = sources();
  const control = helper("Day");
  states.push(control);
  states[1].state = "9";
  const data = clock();
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).nightActive, false);
  states[1].state = "11";
  control.state = "Auto";
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).nightActive, true);
  control.state = "Night";
  states[1].state = "13";
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).nightActive, true);
  states[1].state = "11";
  control.state = "Auto";
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).nightActive, false);
});

test("manual overrides ignore an unavailable configured Sun source, and Auto resumes its warnings", async () => {
  const config = { ...settings(), sun_entity: "sun.bedroom" };
  const control = helper("Night");
  const states = [...sources(), control];
  const data = clock();
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).night_error, null);
  control.state = "Auto";
  await data.refresh(config, states, config.time_zone);
  assert.match(payload(data, config, states).night_error, /sun.bedroom/);
  states.push({ entity_id: "sun.bedroom", state: "below_horizon" });
  await data.refresh(config, states, config.time_zone);
  assert.equal(payload(data, config, states).night_error, null);
  assert.equal(payload(data, config, states).nightActive, true);
});
