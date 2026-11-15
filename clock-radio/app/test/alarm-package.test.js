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
  for (const domain of ["input_boolean", "input_number", "input_select", "input_text", "input_datetime"]) {
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
  assert.match(loop.for_each, /states.input_boolean/);
  assert.match(loop.for_each, /sort/);
  assert.equal(config.script.clock_radio_play_alarm.mode, "restart");
  assert.deepEqual(config.script.clock_radio_play_alarm.fields.alarm.selector, { text: { multiline: false } },
    "HA package merging must retain the selector type instead of dropping an empty mapping");
  assert.match(config.script.clock_radio_cleanup.sequence[0].target.entity_id, /states.timer/);
  assert.equal(config.template[0].sensor.find((sensor) => sensor.unique_id === "clock_radio_alarm_scheduler_version").state, "7");
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

test("Music playback uses each profile's restoring source, falling back only when absent or empty", () => {
  for (const id of [1, 2]) {
    const helper = config.input_text[`clock_radio_alarm_${id}_music_source`];
    assert.equal(helper.max, 255);
    assert.ok(!Object.hasOwn(helper, "initial"));
  }
  const source = config.script.clock_radio_play_alarm.sequence.find((step) => step.variables?.source).variables.source;
  assert.match(source, /prefix ~ '_music_source'/);
  assert.match(source, /selected\[0\].state != ''/);
  assert.match(source, /clock_radio_music_source/);
  assert.match(source, /clock_radio_buzzer_source/);
  assert.match(source, /prefix ~ '_buzzer_source'/);
  assert.ok(!config.script.clock_radio_initialize.sequence.some((step) => JSON.stringify(step).includes("_music_source")));
});

test("ringing context is captured, 10-minute snooze survives restart and stop/new alarms cancel it", () => {
  for (const helper of ["clock_radio_active_alarm", "clock_radio_snoozed_alarm"]) assert.equal(config.input_text[helper].max, 255);
  assert.deepEqual(config.input_datetime.clock_radio_snooze_until, {
    name: "Clock Radio snooze until", has_date: true, has_time: true,
  });
  const play = config.script.clock_radio_play_alarm.sequence;
  const capture = play.find((step) => step.target?.entity_id === "input_text.clock_radio_active_alarm");
  assert.match(capture.data.value, /'id': alarm/);
  assert.match(capture.data.value, /'type': kind/);
  assert.match(capture.data.value, /started_at/);
  assert.ok(play.indexOf(capture) > play.findIndex((step) => step.action === "timer.start"));
  const snooze = config.script.clock_radio_snooze.sequence;
  assert.equal(snooze.find((step) => step.action === "script.clock_radio_cleanup").action, "script.clock_radio_cleanup");
  assert.equal(snooze.find((step) => step.action === "input_datetime.set_datetime").data.timestamp, "{{ (as_timestamp(now()) + 600) | round(0, 'ceil') | int }}");
  assert.equal(snooze.at(-1).target.entity_id, "input_text.clock_radio_snoozed_alarm");
  assert.match(snooze[1].if, /'active'/);
  assert.equal(snooze[1].then[0].error, true);
  const resume = config.script.clock_radio_resume_snooze.sequence;
  assert.match(resume[1].value_template, /timestamp'\) \| int\) <= as_timestamp\(now\(\)\)/);
  assert.equal(resume.at(-1).data.variables.alarm_type, "{{ snoozed['type'] }}");
  assert.ok(resume.some((step) => step.target?.entity_id === "input_text.clock_radio_snoozed_alarm"));
  const finished = config.automation.find((item) => item.id === "clock_radio_snooze_finished");
  assert.equal(finished.triggers[0].at, "input_datetime.clock_radio_snooze_until");
  assert.deepEqual(finished.triggers[1], { trigger: "time_pattern", minutes: "/1", seconds: "0" });
  assert.match(finished.conditions[0].value_template, /not in \['', 'unknown', 'unavailable'\]/);
  assert.equal(config.automation.find((item) => item.id === "clock_radio_startup").actions.at(-1).action, "script.clock_radio_resume_snooze");
  const clearsPending = (step) => step.target?.entity_id === "input_text.clock_radio_snoozed_alarm" && step.data?.value === "";
  assert.ok(config.script.clock_radio_stop.sequence.some(clearsPending));
  assert.ok(play.some(clearsPending));
  assert.ok(!config.script.clock_radio_cleanup.sequence.some(clearsPending), "Startup cleanup must preserve a future snooze");
  assert.match(config.automation.find((item) => item.id === "clock_radio_auto_stop").conditions[0].value_template, /clock_radio_active_alarm/);
});

test("deletion freezes a profile before cleanup and preserves a recoverable HA-backed marker", () => {
  assert.equal(config.input_text.clock_radio_deleting_alarm.max, 20);
  for (const id of [1, 2]) assert.ok(config.input_boolean[`clock_radio_alarm_${id}_deleted`]);
  const prepare = config.script.clock_radio_prepare_delete.sequence;
  const freeze = prepare.findIndex((step) => step.target?.entity_id === "input_text.clock_radio_deleting_alarm");
  const wait = prepare.findIndex((step) => step.wait_template);
  assert.ok(freeze >= 0 && freeze < wait);
  assert.equal(prepare[wait].continue_on_timeout, false);
  assert.match(prepare[wait].wait_template, /clock_radio_play_alarm/);
  assert.match(prepare[wait].wait_template, /clock_radio_snooze/);
  assert.match(prepare[wait].wait_template, /clock_radio_resume_snooze/);
  assert.ok(prepare.some((step) => step.if?.includes("active.get") && step.then.some((action) => action.action === "script.clock_radio_cleanup")));
  assert.ok(!prepare.some((step) => step.action === "script.clock_radio_stop"), "Deleting another profile must not stop an unrelated alarm");
  const schedule = config.automation.find((item) => item.id === "clock_radio_schedule").actions[0].repeat.sequence[1].if;
  assert.match(schedule, /clock_radio_deleting_alarm/);
  assert.match(schedule, /_deleted/);
  const guarded = config.script.clock_radio_play_alarm.sequence.filter((step) => step.if?.includes("clock_radio_deleting_alarm"));
  assert.equal(guarded.length, 2, "Recheck deletion after asynchronous speaker cleanup");
  const resume = config.script.clock_radio_resume_snooze.sequence;
  const invalidDeletion = resume.findIndex((step) => step.if?.includes("has_value('input_text.clock_radio_deleting_alarm')"));
  const clearSnooze = resume.findIndex((step) => step.target?.entity_id === "input_text.clock_radio_snoozed_alarm");
  assert.ok(invalidDeletion >= 0 && invalidDeletion < clearSnooze, "Invalid deletion helpers must not discard a pending snooze");
  assert.equal(resume[invalidDeletion].then[0].error, true);
  assert.ok(!config.script.clock_radio_initialize.sequence.some((step) => JSON.stringify(step).includes("_deleted")));
  assert.ok(!config.script.clock_radio_cleanup.sequence.some((step) => JSON.stringify(step).includes("clock_radio_deleting_alarm")), "Startup cleanup must not lose a partial deletion");
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
