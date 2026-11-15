import { RequestError } from "./errors.js";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const settingKeys = new Set(["id", "enabled", "type", "hour", "minute", "days", "volume", "duration", "music_station_id"]);
const prefix = (id) => `clock_radio_alarm_${id}`;
export const alarmMusicSourceEntity = (id) => `input_text.${prefix(id)}_music_source`;
const musicSourceDefinition = (id) => ({
  entity_id: alarmMusicSourceEntity(id), domain: "input_text",
  fields: { name: `Clock Radio Alarm ${id} Music Source`, min: 0, max: 255, mode: "text" },
});
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
    const match = /^(?:input_boolean|input_number|input_select|input_text|timer|sensor)\.clock_radio_alarm_([1-9]\d*)(?:$|_(?:enabled|initialized|type|hour|minute|volume|duration|music_source|monday|tuesday|wednesday|thursday|friday|saturday|sunday|wake_time)$)/.exec(state.entity_id);
    if (match && Number.isSafeInteger(Number(match[1]))) ids.add(Number(match[1]));
  }
  return [...ids].filter((id) => !states.some((state) => state.entity_id === `input_boolean.${prefix(id)}_deleted` && state.state === "on")).sort((a, b) => a - b);
}

export function alarmSnapshot(states) {
  const index = new Map(states.map((state) => [state.entity_id, state]));
  const scriptAvailable = (name) => index.has(`script.clock_radio_${name}`)
    && !["unknown", "unavailable"].includes(index.get(`script.clock_radio_${name}`).state);
  const deletionState = index.get("input_text.clock_radio_deleting_alarm");
  const deletionValid = !deletionState || deletionState.state === ""
    || /^[1-9]\d*$/.test(deletionState.state) && Number.isSafeInteger(Number(deletionState.state));
  const deleting = deletionState && deletionValid && deletionState.state !== "" ? Number(deletionState.state) : null;
  const deleteError = deletionValid ? null : "HA alarm deletion state is invalid or unavailable. Check input_text.clock_radio_deleting_alarm.";
  const alarms = [...new Set([...alarmIds(states), ...(deleting ? [deleting] : [])])].sort((a, b) => a - b).map((id) => {
    const entities = alarmEntities(id);
    const missing = Object.values(entities).filter((entity) => !index.has(entity) || ["unknown", "unavailable"].includes(index.get(entity).state));
    const value = (key) => index.get(entities[key]);
    const source = index.get(alarmMusicSourceEntity(id));
    const sourceError = source && ["unknown", "unavailable"].includes(source.state)
      ? `HA radio helper ${source.entity_id} is unavailable. Restore it before selecting a station.` : null;
    return {
      id, missing, available: missing.length === 0, deletion_pending: deleting === id,
      music_source: source && !sourceError ? source.state : null,
      music_source_error: sourceError,
      can_select_radio: Number(index.get("sensor.clock_radio_alarm_scheduler_version")?.state) >= 5
        && scriptAvailable("play_alarm") && !sourceError && (Boolean(source) || id > 2),
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
  let activeError = null;
  const context = (name) => {
    const value = text(name);
    if (!value) return null;
    let parsed;
    try { parsed = JSON.parse(value); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      activeError = "Invalid running/snoozed alarm data. Check the HA alarm package helpers.";
      return null;
    }
    if (!parsed || !Number.isSafeInteger(parsed.id) || parsed.id < 1 || !["Music", "Buzzer"].includes(parsed.type)) {
      activeError = "Invalid running/snoozed alarm data. Check the HA alarm package helpers.";
      return null;
    }
    return parsed;
  };
  const captured = context("active_alarm");
  const running = alarms.filter((alarm) => alarm.timer === "active");
  // Older packages have no captured context, but an alarm timer plus active speaker is authoritative.
  const legacy = !index.has("input_text.clock_radio_active_alarm") && running.length === 1
    && ["Music", "Buzzer"].includes(running[0].type) ? running[0] : null;
  // Cleanup cancels timers first; captured state clears only after speaker cleanup succeeds.
  const profile = captured ? alarms.find((alarm) => alarm.id === captured.id) : legacy;
  const active = profile && /^media_player\.[a-z0-9_]+$/.test(text("active_player")) ? {
    id: profile.id, type: captured?.type ?? profile.type, player: text("active_player"),
    started_at: typeof captured?.started_at === "string" ? captured.started_at : null,
    finishes_at: profile.finishes_at,
  } : null;
  const snoozedContext = context("snoozed_alarm");
  const snoozeAt = index.get("input_datetime.clock_radio_snooze_until")?.attributes?.timestamp;
  const snoozed = snoozedContext && typeof snoozeAt === "number" && Number.isFinite(snoozeAt)
    && Math.abs(snoozeAt) < 8.64e12 ? {
      id: snoozedContext.id, type: snoozedContext.type, until: new Date(snoozeAt * 1000).toISOString(),
    } : null;
  if (snoozedContext && !snoozed) activeError = "Invalid snooze deadline. Check the HA snooze date/time helper.";
  return {
    scheduler_version: index.get("sensor.clock_radio_alarm_scheduler_version")?.state ?? null,
    alarms, player: text("player"), music_source: text("music_source"),
    buzzer_source: text("buzzer_source"), active_player: text("active_player"),
    active, active_id: captured?.id ?? legacy?.id ?? null, snoozed, active_error: activeError,
    deleting, delete_error: deleteError,
    can_delete: Boolean(Number(index.get("sensor.clock_radio_alarm_scheduler_version")?.state) >= 4
      && deletionState && deletionValid && !deleteError && scriptAvailable("prepare_delete")
      && scriptAvailable("cleanup") && scriptAvailable("play_alarm")
      && [1, 2].every((id) => ["on", "off"].includes(index.get(`input_boolean.${prefix(id)}_deleted`)?.state))),
    can_snooze: Boolean(active && captured && profile.timer === "active" && !activeError && scriptAvailable("snooze")
      && scriptAvailable("resume_snooze") && index.has("input_text.clock_radio_snoozed_alarm")
      && !["unknown", "unavailable"].includes(index.get("input_text.clock_radio_snoozed_alarm").state)
      && typeof snoozeAt === "number" && Number.isFinite(snoozeAt)
      && !["unknown", "unavailable"].includes(index.get("input_datetime.clock_radio_snooze_until")?.state)),
    can_stop: scriptAvailable("stop"),
    can_play: scriptAvailable("play_alarm"),
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
  if (Object.hasOwn(body, "music_station_id") && body.music_station_id !== null
      && (typeof body.music_station_id !== "string" || !/^ma-[a-f0-9]{16}$/.test(body.music_station_id))) {
    throw new RequestError("music_station_id must be a Music Assistant station ID or null for the shared HA default.");
  }
  for (const [key, min, max] of [["hour", 0, 23], ["minute", 0, 59], ["volume", 0, 100], ["duration", 1, 120]]) checkNumber(body[key], key, min, max);
  if (!body.days || typeof body.days !== "object" || Array.isArray(body.days)
      || Object.keys(body.days).length !== 7 || !WEEKDAYS.every((day) => typeof body.days[day] === "boolean")) {
    throw new RequestError("days must contain all seven weekdays as booleans.");
  }
  if (body.enabled && !WEEKDAYS.some((day) => body.days[day])) throw new RequestError("Select at least one weekday before enabling the alarm.");
  return body;
}

export async function saveAlarm(ha, body, states, logger, musicSource) {
  const setting = validateAlarm(body);
  const snapshot = alarmSnapshot(states);
  if (snapshot.delete_error) throw new RequestError(snapshot.delete_error, 409);
  const profile = snapshot.alarms.find((alarm) => alarm.id === setting.id);
  if (profile?.deletion_pending) throw new RequestError("Finish deleting this alarm before changing its settings.", 409);
  if (!profile?.available || !profile.setup_complete) throw new RequestError("The alarm helpers are missing, unavailable or incomplete. Install the HA package or finish setup first.", 409);
  const changesStation = Object.hasOwn(setting, "music_station_id");
  if (changesStation) {
    if (!profile.can_select_radio) throw new RequestError(profile.music_source_error || "Update the HA alarm package to version 5, including its per-alarm Music Source helpers, before selecting a station.", 409);
    if (typeof musicSource !== "string" || musicSource.length > 255
        || (musicSource !== "" && (!/^(https?:\/\/|library:\/\/|radiobrowser:\/\/)\S+$/.test(musicSource)
          || !URL.canParse(musicSource)
          || new URL(musicSource).username || new URL(musicSource).password))) {
      throw new RequestError("This station URI cannot be stored in an HA alarm source helper. Choose another Music Assistant station.");
    }
  }
  const entities = alarmEntities(setting.id);
  const call = (domain, service, entity, data = {}) => ha.callService(domain, service, { entity_id: entity, ...data });
  await call("input_boolean", "turn_off", entities.enabled);
  try {
    if (changesStation) {
      const definition = musicSourceDefinition(setting.id);
      if (!states.some((state) => state.entity_id === definition.entity_id)) {
        const registry = await ha.requestWs({ type: "config/entity_registry/list" });
        if (!Array.isArray(registry) || !registry.every((entry) => entry && typeof entry.entity_id === "string")) throw new Error("HA returned an invalid entity registry.");
        if (registry.some((entry) => entry.entity_id === definition.entity_id)) throw new Error("The radio helper is registered but unavailable. Restore it in HA before saving.");
        await ha.requestWs({ type: "input_text/create", ...definition.fields });
        if (!(await ha.states()).some((state) => state.entity_id === definition.entity_id)) throw new Error("HA did not create the radio helper under its expected entity ID.");
      }
      await call("input_text", "set_value", definition.entity_id, { value: musicSource });
    }
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
  return !snapshot.deleting && !snapshot.delete_error && Number(snapshot.scheduler_version) >= 2 && snapshot.can_stop && snapshot.can_play && !snapshot.playback_missing.length
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
      id = Math.max(2, ...alarmIds([...states, ...registry])) + 1;
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
    if (Number(snapshot.scheduler_version) >= 5) definitions.push(musicSourceDefinition(id));
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
      const source = definitions.find((definition) => definition.entity_id === alarmMusicSourceEntity(id));
      if (source) {
        const state = fresh.find((state) => state.entity_id === source.entity_id).state;
        if (state === "unavailable") throw new Error(`${source.entity_id} is unavailable. Restore it in HA before finishing setup.`);
        if (created.includes(source) || state === "unknown") {
          await ha.callService("input_text", "set_value", { entity_id: source.entity_id, value: "" });
          if ((await ha.states()).find((state) => state.entity_id === source.entity_id)?.state !== "") {
            throw new Error(`HA did not initialize ${source.entity_id}. Use Finish setup to retry.`);
          }
        }
      }
      await ha.callService("input_boolean", "turn_on", { entity_id: initialized });
      const result = alarmSnapshot(await ha.states()).alarms.find((alarm) => alarm.id === id);
      if (!result?.available || !result.setup_complete || result.enabled || result.timer === null) throw new Error("HA alarm setup did not finish.");
      return { alarm_id: id };
    } catch (error) {
      logger.warn(`Alarm ${id} creation failed: ${error.message}`);
      throw new RequestError(`Alarm setup failed: ${error.message} No alarm was enabled. Use Finish setup on the incomplete profile, or inspect its helpers in HA.`, 502);
    }
}

export function validateDeleteAlarm(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
      || !Number.isSafeInteger(body.id) || body.id < 1) throw new RequestError("Delete alarm takes only a positive safe integer id.");
  return body.id;
}

export async function deleteAlarm(ha, states, body, logger) {
  const id = validateDeleteAlarm(body);
  const snapshot = alarmSnapshot(states);
  if (snapshot.delete_error) throw new RequestError(snapshot.delete_error, 409);
  if (!snapshot.can_delete) throw new RequestError("Update the HA alarm package to version 4 and load its deletion helpers/scripts before deleting alarms.", 409);
  if (snapshot.active_error) throw new RequestError(snapshot.active_error, 409);
  if (snapshot.deleting && snapshot.deleting !== id) throw new RequestError("Finish the pending alarm deletion first.", 409);
  if (!snapshot.alarms.some((alarm) => alarm.id === id)) throw new RequestError("This alarm is not configured.", 404);
  const owned = new Set([...Object.values(alarmEntities(id)), alarmMusicSourceEntity(id), `timer.${prefix(id)}`, `input_boolean.${prefix(id)}_initialized`]);
  try {
    const plan = [];
    if (id > 2) {
      const registry = await ha.requestWs({ type: "config/entity_registry/list" });
      if (!Array.isArray(registry) || !registry.every((entry) => entry && typeof entry.entity_id === "string")) throw new Error("HA returned an invalid entity registry.");
      for (const domain of ["input_boolean", "input_number", "input_select", "input_text", "timer"]) {
        const items = await ha.requestWs({ type: `${domain}/list` });
        if (!Array.isArray(items) || !items.every((item) => item && typeof item.id === "string")) throw new Error(`HA returned an invalid ${domain} helper list.`);
        for (const entry of registry.filter((item) => owned.has(item.entity_id) && item.entity_id.startsWith(`${domain}.`))) {
          if (entry.platform !== domain || typeof entry.unique_id !== "string" || !items.some((item) => item.id === entry.unique_id)) {
            throw new Error(`${entry.entity_id} is not a removable native helper. Remove custom YAML definitions in HA instead.`);
          }
          plan.push({ type: `${domain}/delete`, [`${domain}_id`]: entry.unique_id });
        }
      }
    }
    await ha.callService("script", "clock_radio_prepare_delete", { alarm: id }, { timeout: 60000 });
    const preparedStates = await ha.states();
    const prepared = alarmSnapshot(preparedStates);
    if (prepared.deleting !== id || prepared.active_error || prepared.active_id === id || prepared.snoozed?.id === id
        || prepared.alarms.find((alarm) => alarm.id === id)?.enabled
        || preparedStates.some((state) => ["script.clock_radio_play_alarm", "script.clock_radio_snooze", "script.clock_radio_resume_snooze"].includes(state.entity_id) && state.state === "on")
        || prepared.alarms.some((alarm) => alarm.id === id && ["active", "paused"].includes(alarm.timer))) {
      throw new Error("HA did not confirm that this alarm was safely stopped and cancelled.");
    }
    for (const request of plan) await ha.requestWs(request);
    if (id <= 2) await ha.callService("input_boolean", "turn_on", { entity_id: `input_boolean.${prefix(id)}_deleted` });
    else if ((await ha.states()).some((state) => owned.has(state.entity_id))) throw new Error("Some alarm helpers remain in HA. Retry deletion after checking them.");
    await ha.callService("input_text", "set_value", { entity_id: "input_text.clock_radio_deleting_alarm", value: "" });
    if (alarmSnapshot(await ha.states()).alarms.some((alarm) => alarm.id === id)) throw new Error("HA did not confirm alarm deletion.");
    return { deleted_alarm_id: id };
  } catch (error) {
    logger.warn(`Alarm ${id} deletion failed: ${error.message}`);
    throw new RequestError(`Alarm deletion failed: ${error.message} Check HA permissions/helpers and retry Delete; an unfinished deletion stays disabled.`, 502);
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
