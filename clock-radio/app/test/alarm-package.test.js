import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const directory = new URL("../../../examples/home-assistant/", import.meta.url);
const read = (file) => YAML.parse(fs.readFileSync(fileURLToPath(new URL(file, directory)), "utf8"));
const config = read("clock_radio_alarms.yaml");

test("alarm package contains independent persistent Music/Buzzer profiles", () => {
  for (const alarm of [1, 2]) {
    const prefix = `clock_radio_alarm_${alarm}`;
    assert.ok(config.input_boolean[`${prefix}_enabled`]);
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
      assert.ok(config.input_boolean[`${prefix}_${day}`]);
    }
    assert.deepEqual(config.input_select[`${prefix}_type`].options, ["Music", "Buzzer"]);
    assert.equal(config.input_number[`${prefix}_hour`].min, 0);
    assert.equal(config.input_number[`${prefix}_hour`].max, 23);
    assert.equal(config.input_number[`${prefix}_minute`].max, 59);
    assert.equal(config.input_number[`${prefix}_volume`].max, 100);
    assert.equal(config.input_number[`${prefix}_duration`].min, 1);
    assert.equal(config.timer[prefix].restore, true);
    assert.ok(config.template[0].sensor.some((sensor) => sensor.unique_id === `${prefix}_wake_time`));
  }
  for (const domain of ["input_boolean", "input_number", "input_select", "input_text"]) {
    for (const helper of Object.values(config[domain])) {
      assert.ok(!Object.hasOwn(helper, "initial"), "User choices must survive restarts");
    }
  }
});

test("initialization is guarded, schedules use weekdays and HH:MM, and timer/startup cleanup is wired", () => {
  const initialization = config.script.clock_radio_initialize.sequence;
  assert.deepEqual(initialization[0], { condition: "state", entity_id: "input_boolean.clock_radio_initialized", state: "off" });
  const schedule = config.automation.find((item) => item.id === "clock_radio_schedule");
  assert.equal(schedule.triggers[0].seconds, "0");
  const loop = schedule.actions[0].repeat;
  assert.deepEqual(loop.for_each, ["1", "2"]);
  for (const required of ["_enabled", "weekday", "_hour", "_minute", "is_number"]) {
    assert.ok(loop.sequence[1].if.includes(required));
  }
  assert.equal(config.automation.find((item) => item.id === "clock_radio_auto_stop").actions[0].action, "script.clock_radio_stop");
  assert.equal(config.automation.find((item) => item.id === "clock_radio_startup").actions[1].action, "script.clock_radio_cleanup");
  const play = config.script.clock_radio_play_alarm.sequence;
  assert.ok(play.find((item) => item.action === "timer.start"));
  assert.ok(play.find((item) => item.action === "music_assistant.play_media"));
  assert.ok(play.find((item) => item.wait_template));
  assert.ok(play.at(-1).then.some((item) => item.action === "persistent_notification.create"));
});

test("native alarm cards reference only entities supplied by the package", () => {
  const supplied = new Set();
  for (const domain of ["input_boolean", "input_number", "input_select", "input_text", "timer", "script"]) {
    for (const key of Object.keys(config[domain])) supplied.add(`${domain}.${key}`);
  }
  for (const sensor of config.template[0].sensor) supplied.add(`sensor.${sensor.unique_id}`);
  for (const card of read("alarm-cards.yaml").cards) {
    assert.equal(card.type, "entities");
    for (const row of card.entities) assert.ok(supplied.has(typeof row === "string" ? row : row.entity));
  }
});
