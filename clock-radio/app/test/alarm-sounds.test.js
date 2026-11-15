import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ALARM_SOUNDS, alarmSoundId, soundFile, soundMediaPath } from "../web/js/lib/alarm-sounds.js";
import { renderSound } from "../dev/generate-sounds.js";
import { publishAlarmSounds } from "../src/alarm-sounds.js";
import { alarmSnapshot, validateAlarm } from "../src/alarms.js";
import { demoStates } from "../dev/fixtures.js";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));

test("all twelve original recordings are reproducible, distinct, unclipped PCM WAVs with quiet loop boundaries", () => {
  const hashes = new Set();
  assert.equal(ALARM_SOUNDS.length, 12);
  for (const { id, name, description } of ALARM_SOUNDS) {
    assert.match(id, /^[a-z]+(?:-[a-z]+)+$/);
    assert.ok(name && description);
    const body = fs.readFileSync(path.join(webRoot, soundFile(id)));
    assert.deepEqual(body, renderSound(id));
    hashes.add(crypto.createHash("sha256").update(body).digest("hex"));
    assert.equal(body.toString("ascii", 0, 4), "RIFF");
    assert.equal(body.toString("ascii", 8, 16), "WAVEfmt ");
    assert.equal(body.readUInt16LE(20), 1);
    assert.equal(body.readUInt16LE(22), 1);
    assert.equal(body.readUInt32LE(24), 24000);
    assert.equal(body.readUInt16LE(34), 16);
    assert.equal(body.readUInt32LE(40), 8 * 24000 * 2);
    assert.equal(body.length, 44 + 8 * 24000 * 2);
    assert.equal(body.readInt16LE(44), 0);
    assert.equal(body.readInt16LE(body.length - 2), 0);
    let peak = 0, power = 0, mean = 0;
    for (let offset = 44; offset < body.length; offset += 2) {
      const sample = body.readInt16LE(offset) / 32768;
      peak = Math.max(peak, Math.abs(sample));
      power += sample ** 2;
      mean += sample;
    }
    assert.ok(peak >= 0.69 && peak <= 0.71);
    assert.ok(Math.sqrt(power / 192000) > 0.025, `${id} must be audible`);
    assert.ok(Math.abs(mean / 192000) < 0.001, `${id} must not have a DC offset`);
    assert.equal(alarmSoundId(`http://ha:8123${soundMediaPath(id)}`), id);
  }
  assert.equal(hashes.size, 12);
  assert.throws(() => renderSound("missing"), /Unknown/);
});

test("sound publishing is idempotent and preserves unrelated HA files and modified originals", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-sounds-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  fs.mkdirSync(path.join(dir, "www"));
  fs.writeFileSync(path.join(dir, "www/user.txt"), "preserve");
  publishAlarmSounds(webRoot, dir);
  publishAlarmSounds(webRoot, dir);
  for (const { id } of ALARM_SOUNDS) {
    assert.deepEqual(fs.readFileSync(path.join(dir, "www/clock-radio", soundFile(id))), renderSound(id));
  }
  assert.equal(fs.readFileSync(path.join(dir, "www/user.txt"), "utf8"), "preserve");
  assert.equal(fs.readFileSync(path.join(dir, "www/clock-radio/sounds/LICENSE"), "utf8"),
    fs.readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8"));
  const conflicting = path.join(dir, "www/clock-radio", soundFile(ALARM_SOUNDS[0].id));
  fs.writeFileSync(conflicting, "user modification");
  assert.throws(() => publishAlarmSounds(webRoot, dir), /differs from the bundled original/);
  assert.equal(fs.readFileSync(conflicting, "utf8"), "user modification");
});

test("sound choices require protocol 7 but missing optional helpers preserve legacy alarm defaults", () => {
  const states = demoStates();
  const version = states.find((state) => state.entity_id === "sensor.clock_radio_alarm_scheduler_version");
  assert.ok(alarmSnapshot(states).alarms.every((alarm) => alarm.can_select_sound));
  version.state = "6";
  assert.ok(alarmSnapshot(states).alarms.every((alarm) => !alarm.can_select_sound));
  version.state = "7";
  states.push({ entity_id: "input_text.clock_radio_alarm_2_buzzer_source", state: "unavailable", attributes: {} });
  const alarm = alarmSnapshot(states).alarms[1];
  assert.equal(alarm.available, true);
  assert.equal(alarm.can_select_sound, false);
  assert.match(alarm.buzzer_source_error, /unavailable/);
  const body = {
    id: 2, enabled: false, type: "Buzzer", hour: 6, minute: 0, volume: 50, duration: 5,
    days: alarm.days,
  };
  for (const buzzer_sound_id of [null, ...ALARM_SOUNDS.map(({ id }) => id)]) {
    assert.equal(validateAlarm({ ...body, buzzer_sound_id }).buzzer_sound_id, buzzer_sound_id);
  }
  for (const buzzer_sound_id of ["", "apple-radar", "../sound", "http://host/tone.wav", 1, {}, undefined]) {
    assert.throws(() => validateAlarm({ ...body, buzzer_sound_id }), /buzzer_sound_id/);
  }
  assert.equal(alarmSoundId("not a URL"), null);
});
