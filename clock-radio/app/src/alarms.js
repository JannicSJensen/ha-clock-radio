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

export function alarmSnapshot(states) {
  const index = new Map(states.map((state) => [state.entity_id, state]));
  const alarms = [1, 2].map((id) => {
    const entities = alarmEntities(id);
    const missing = Object.values(entities).filter((entity) => !index.has(entity) || ["unknown", "unavailable"].includes(index.get(entity).state));
    const value = (key) => index.get(entities[key]);
    return {
      id, missing, available: missing.length === 0,
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
    alarms, player: text("player"), music_source: text("music_source"),
    buzzer_source: text("buzzer_source"), active_player: text("active_player"),
    can_stop: index.has("script.clock_radio_stop") && !["unknown", "unavailable"].includes(index.get("script.clock_radio_stop").state),
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
  if (![1, 2].includes(body.id)) throw new RequestError("Alarm ID must be 1 or 2.");
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
  if (!profile.available) throw new RequestError("The alarm helpers are missing or unavailable. Install the HA alarm package first.", 409);
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
