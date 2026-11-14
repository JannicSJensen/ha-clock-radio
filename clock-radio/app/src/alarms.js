import { RequestError } from "./errors.js";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const settingKeys = new Set(["id", "enabled", "type", "hour", "minute", "days", "volume", "duration"]);
const prefix = (id) => `clock_radio_alarm_${id}`;
const numeric = (state) => state && state.state !== "" && !["unknown", "unavailable"].includes(state.state) && Number.isFinite(Number(state.state));

export function alarmEntities(id) {
  const p = prefix(id);
  return {
    enabled: `input_boolean.${p}_enabled`, type: `input_select.${p}_type`,
    hour: `input_number.${p}_hour`, minute: `input_number.${p}_minute`,
    volume: `input_number.${p}_volume`, duration: `input_number.${p}_duration`,
    ...Object.fromEntries(WEEKDAYS.map((day) => [day, `input_boolean.${p}_${day}`])),
  };
}

export function alarmIds(states) {
  const ids = new Set([1, 2]);
  for (const state of states) {
    const match = /^(?:input_boolean|input_number|input_select|timer|sensor)\.clock_radio_alarm_([1-9]\d*)(?:$|_(?:enabled|initialized|type|hour|minute|volume|duration|monday|tuesday|wednesday|thursday|friday|saturday|sunday|wake_time)$)/.exec(state.entity_id);
    if (match && Number.isSafeInteger(Number(match[1]))) ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

export function alarmSnapshot(states) {
  const index = new Map(states.map((state) => [state.entity_id, state]));
  const alarms = alarmIds(states).map((id) => {
    const entities = alarmEntities(id);
    const missing = Object.values(entities).filter((entity) => !index.has(entity) || ["unknown", "unavailable"].includes(index.get(entity).state));
    const value = (key) => index.get(entities[key]);
    return {
      id, missing, available: missing.length === 0,
      setup_complete: id <= 2 || index.get(`input_boolean.${prefix(id)}_initialized`)?.state === "on",
      enabled: value("enabled")?.state === "on",
      type: value("type")?.state ?? null,
      hour: numeric(value("hour")) ? Number(value("hour").state) : null,
      minute: numeric(value("minute")) ? Number(value("minute").state) : null,
      volume: numeric(value("volume")) ? Number(value("volume").state) : null,
      duration: numeric(value("duration")) ? Number(value("duration").state) : null,
      days: Object.fromEntries(WEEKDAYS.map((day) => [day, value(day)?.state === "on"])),
      timer: index.get(`timer.${prefix(id)}`)?.state ?? null,
      finishes_at: index.get(`timer.${prefix(id)}`)?.attributes?.finishes_at ?? null,
    };
  });
  const text = (name) => {
    const value = index.get(`input_text.clock_radio_${name}`)?.state;
    return value && !["unknown", "unavailable"].includes(value) ? value : "";
  };
  return {
    scheduler_version: index.get("sensor.clock_radio_alarm_scheduler_version")?.state ?? null,
    alarms, player: text("player"), music_source: text("music_source"),
    buzzer_source: text("buzzer_source"), active_player: text("active_player"),
    can_stop: index.has("script.clock_radio_stop") && !["unknown", "unavailable"].includes(index.get("script.clock_radio_stop").state),
    can_play: index.has("script.clock_radio_play_alarm") && !["unknown", "unavailable"].includes(index.get("script.clock_radio_play_alarm").state),
    playback_missing: ["player", "music_source", "buzzer_source"].filter((name) => {
      const state = index.get(`input_text.clock_radio_${name}`);
      return !state || ["unknown", "unavailable"].includes(state.state);
    }),
  };
}

function checkNumber(value, key, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RequestError(`${key} must be an integer between ${min} and ${max}.`);
}

export function validateAlarm(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Alarm settings must be an object.");
  if (Object.keys(body).some((key) => !settingKeys.has(key))) throw new RequestError("Unknown alarm setting.");
  if (!Number.isSafeInteger(body.id) || body.id < 1) throw new RequestError("Alarm ID must be a positive safe integer.");
  if (typeof body.enabled !== "boolean") throw new RequestError("enabled must be a boolean.");
  if (!["Music", "Buzzer"].includes(body.type)) throw new RequestError("Alarm type must be Music or Buzzer.");
  for (const [key, min, max] of [["hour", 0, 23], ["minute", 0, 59], ["volume", 0, 100], ["duration", 1, 120]]) checkNumber(body[key], key, min, max);
  if (!body.days || typeof body.days !== "object" || Array.isArray(body.days)
      || Object.keys(body.days).length !== 7 || !WEEKDAYS.every((day) => typeof body.days[day] === "boolean")) {
    throw new RequestError("days must contain all seven weekdays as booleans.");
  }
  if (body.enabled && !WEEKDAYS.some((day) => body.days[day])) throw new RequestError("Select at least one weekday before enabling the alarm.");
  return body;
}

export async function saveAlarm(ha, body, states, logger) {
  const setting = validateAlarm(body);
  const profile = alarmSnapshot(states).alarms.find((alarm) => alarm.id === setting.id);
  if (!profile?.available || !profile.setup_complete) throw new RequestError("The alarm helpers are missing, unavailable or incomplete. Install the HA package or finish setup first.", 409);
  const entities = alarmEntities(setting.id);
  const call = (domain, service, entity, data = {}) => ha.callService(domain, service, { entity_id: entity, ...data });
  await call("input_boolean", "turn_off", entities.enabled);
  try {
    for (const key of ["hour", "minute", "volume", "duration"]) await call("input_number", "set_value", entities[key], { value: setting[key] });
    await call("input_select", "select_option", entities.type, { option: setting.type });
    for (const day of WEEKDAYS) await call("input_boolean", setting.days[day] ? "turn_on" : "turn_off", entities[day]);
    if (setting.enabled) await call("input_boolean", "turn_on", entities.enabled);
  } catch (error) {
    logger.warn(`Alarm ${setting.id} settings failed: ${error.message}`);
    throw new RequestError("Not all alarm settings were saved. The schedule was disabled before editing; check the profile before enabling it.", 502);
  }

}

export function canCreateAlarm(snapshot) {
  return Number(snapshot.scheduler_version) >= 2 && snapshot.can_stop && snapshot.can_play && !snapshot.playback_missing.length
    && snapshot.alarms.filter((alarm) => alarm.id <= 2).every((alarm) => alarm.available);
}

export async function provisionAlarm(ha, states, body, logger) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "id")) throw new RequestError("Add alarm takes an empty object or an existing incomplete alarm ID.");
    const snapshot = alarmSnapshot(states);
    if (!canCreateAlarm(snapshot)) throw new RequestError("Update the HA alarm package to the dynamic scheduler before adding alarms.", 409);
    const registry = await ha.requestWs({ type: "config/entity_registry/list" });
    if (!Array.isArray(registry) || !registry.every((item) => typeof item.entity_id === "string")) throw new RequestError("Home Assistant returned an invalid entity registry.", 502);
    let id = body.id;
    if (id === undefined) {
      if (snapshot.alarms.some((alarm) => alarm.id > 2 && (!alarm.available || !alarm.setup_complete))) throw new RequestError("Finish setting up the incomplete alarm before adding another.", 409);
      id = Math.max(...alarmIds([...states, ...registry])) + 1;
    }
    if (!Number.isSafeInteger(id) || id < 3) throw new RequestError("New alarm ID must be a safe integer greater than 2.");
    const existing = snapshot.alarms.find((alarm) => alarm.id === id);
    if (body.id !== undefined && (!existing || (existing.available && existing.setup_complete) || existing.enabled)) throw new RequestError("Only a disabled incomplete alarm can be resumed.", 409);
    const entities = alarmEntities(id);
    const definitions = Object.entries(entities).map(([key, entity_id]) => {
      const domain = entity_id.split(".")[0];
      const fields = { name: `Clock Radio Alarm ${id} ${key[0].toUpperCase()}${key.slice(1)}` };
      if (domain === "input_number") {
        const ranges = { hour: [0, 23, 6], minute: [0, 59, 0], volume: [0, 100, 50], duration: [1, 120, 5] };
        Object.assign(fields, { min: ranges[key][0], max: ranges[key][1], step: 1, mode: "box" });
        return { key, entity_id, domain, fields, value: ranges[key][2] };
      }
      if (domain === "input_select") fields.options = ["Music", "Buzzer"];
      return { key, entity_id, domain, fields, value: WEEKDAYS.indexOf(key) >= 0 && WEEKDAYS.indexOf(key) < 5 };
    });
    definitions.push({ key: "timer", entity_id: `timer.${prefix(id)}`, domain: "timer", fields: { name: `Clock Radio Alarm ${id}`, duration: "00:05:00", restore: true } });
    const initialized = `input_boolean.${prefix(id)}_initialized`;
    definitions.push({ key: "initialized", entity_id: initialized, domain: "input_boolean", fields: { name: `Clock Radio Alarm ${id} Initialized` }, value: false });
    const created = [];
    try {
      for (const definition of definitions) {
        if (states.some((state) => state.entity_id === definition.entity_id)) continue;
        if (registry.some((entry) => entry.entity_id === definition.entity_id)) throw new Error(`${definition.entity_id} is registered but unavailable. Restore it in HA before finishing setup.`);
        await ha.requestWs({ type: `${definition.domain}/create`, ...definition.fields });
        created.push(definition);
      }
      const fresh = await ha.states();
      if (definitions.some((definition) => !fresh.some((state) => state.entity_id === definition.entity_id))) throw new Error("HA did not expose all helpers under their expected entity IDs.");
      if (fresh.find((state) => state.entity_id === entities.enabled)?.state !== "off") throw new Error("The new alarm must remain disabled during setup.");
      for (const definition of created) {
        if (definition.domain === "input_number") await ha.callService("input_number", "set_value", { entity_id: definition.entity_id, value: definition.value });
        else if (definition.domain === "input_boolean" && definition.key !== "enabled" && definition.value) await ha.callService("input_boolean", "turn_on", { entity_id: definition.entity_id });
      }
      await ha.callService("input_boolean", "turn_on", { entity_id: initialized });
      const result = alarmSnapshot(await ha.states()).alarms.find((alarm) => alarm.id === id);
      if (!result?.available || !result.setup_complete || result.enabled || result.timer === null) throw new Error("HA alarm setup did not finish.");
      return { alarm_id: id };
    } catch (error) {
      logger.warn(`Alarm ${id} creation failed: ${error.message}`);
      throw new RequestError(`Alarm ${id} setup failed: ${error.message} No alarm was enabled. Use Finish setup on the incomplete profile, or inspect its helpers in HA.`, 502);
    }
}

export function validatePlaybackSettings(body, players) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["player", "music_source", "buzzer_source"].includes(key))) throw new RequestError("Invalid alarm playback settings.");
  if (!players.includes(body.player)) throw new RequestError("Choose a speaker available on this dashboard.");
  for (const key of ["music_source", "buzzer_source"]) {
    const value = body[key];
    if (typeof value !== "string" || value.length > 255 || !/^(https?:\/\/|library:\/\/|radiobrowser:\/\/)\S+$/.test(value)) throw new RequestError(`${key} must be a supported absolute music URI or URL.`);
    const url = new URL(value);
    if (url.username || url.password) throw new RequestError("Do not put credentials in alarm source URLs.");
    if (key === "buzzer_source" && !["http:", "https:"].includes(url.protocol)) throw new RequestError("Buzzer sound must use an HTTP(S) URL.");
  }
  return body;
}
