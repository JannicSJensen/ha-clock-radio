import { WEEKDAYS } from "./alarms.js";

const dayFormatters = new Map();
function parts(at, zone) {
  if (!dayFormatters.has(zone)) dayFormatters.set(zone, new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }));
  return Object.fromEntries(dayFormatters.get(zone).formatToParts(new Date(at)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
const wallEpoch = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
const nightEntityId = (settings) => settings.night_mode === "sun" ? "sun.sun" : settings.night_entity;

function wallCandidates(desired, zone) {
  const wall = wallEpoch(desired);
  const offsets = new Set([-86400000, 0, 86400000].map((delta) => wallEpoch(parts(wall + delta, zone)) - (wall + delta)));
  return [...offsets].map((difference) => wall - difference).filter((at) => wallEpoch(parts(at, zone)) === wall);
}

export function nextAlarmAt(alarms, zone, now = Date.now()) {
  if (!zone) return null;
  const today = parts(now, zone);
  const candidates = [];
  for (let offset = 0; offset < 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const day = WEEKDAYS[(date.getUTCDay() + 6) % 7];
    for (const alarm of alarms) {
      if (!alarm.available || !alarm.enabled || !alarm.days[day] || alarm.hour === null || alarm.minute === null) continue;
      const desired = {
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: alarm.hour, minute: alarm.minute, second: 0,
      };
      // Both offsets are needed around a DST transition; impossible wall times are skipped.
      candidates.push(...wallCandidates(desired, zone).filter((at) => at > now));
    }
  }
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}

export function alarmEntityAt(state, zone, now = Date.now()) {
  if (!state || ["unknown", "unavailable"].includes(state.state)) return null;
  if (!state.entity_id.startsWith("input_datetime.")) {
    const at = Date.parse(state.state);
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(state.state) || !Number.isFinite(at)) throw new Error("The next-alarm sensor must contain a timestamp with a time zone.");
    return new Date(at).toISOString();
  }
  if (!zone) throw new Error("Home Assistant's time zone is needed for a date/time alarm helper.");
  const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(state.state);
  const full = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(state.state);
  if (!clock && !full) throw new Error("The next-alarm date/time helper must have a time.");
  const today = parts(now, zone);
  const candidates = [];
  for (let offset = 0; offset < (clock ? 2 : 1); offset++) {
    const date = clock ? new Date(Date.UTC(today.year, today.month - 1, today.day + offset)) : null;
    const desired = clock ? {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0),
    } : { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]), hour: Number(full[4]), minute: Number(full[5]), second: Number(full[6]) };
    candidates.push(...wallCandidates(desired, zone).filter((at) => at > now));
  }
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}

export function nightEntityActive(state, settings, previous = false) {
  if (!state || ["unknown", "unavailable"].includes(state.state)) return previous;
  if (settings.night_mode === "sun") {
    return state.state === "below_horizon" ? true : state.state === "above_horizon" ? false : previous;
  }
  if (state.state.trim() !== "" && Number.isFinite(Number(state.state))) {
    const value = Number(state.state);
    const margin = settings.night_mode === "illuminance" ? settings.night_threshold * 0.25 : Math.max(settings.night_threshold * 0.1, 1);
    return previous ? value <= settings.night_threshold + margin : value <= settings.night_threshold;
  }
  return ["on", "true", "below_horizon"].includes(state.state.toLowerCase());
}

export class ClockData {
  constructor({ ha, logger, now = Date.now }) {
    Object.assign(this, { ha, logger, now });
    this.night = false;
    this.forecast = null;
    this.forecastKey = "";
    this.forecastAt = 0;
    this.error = null;
  }

  async refresh(config, states, zone) {
    const settings = config.clock;
    const index = new Map(states.map((state) => [state.entity_id, state]));
    this.night = nightEntityActive(index.get(nightEntityId(settings)), settings, this.night);
    const weather = index.get(settings.weather_entity);
    if (this.weather?.entity_id !== weather?.entity_id) this.forecast = null;
    this.weather = weather;
    if (!settings.weather_entity) { this.forecast = null; this.error = null; return; }
    if (!weather || ["unknown", "unavailable"].includes(weather.state)) {
      this.error = "The selected weather entity is missing or unavailable.";
      return;
    }
    const date = zone ? parts(this.now(), zone) : null;
    const day = date ? `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` : "";
    const key = `${settings.weather_entity}|${day}`;
    if (key === this.forecastKey && this.now() - this.forecastAt < (this.error || !this.forecast ? 300000 : 1800000)) return;
    this.forecastAt = this.now();
    this.forecastKey = key;
    try {
      const list = weather.attributes?.forecast ?? (await this.ha.callServiceWithResponse("weather", "get_forecasts", { entity_id: settings.weather_entity, type: "daily" }))[settings.weather_entity]?.forecast;
      if (!Array.isArray(list)) throw new Error("Home Assistant returned no daily weather forecast.");
      const current = list.find((entry) => {
        const at = Date.parse(entry.datetime);
        if (!Number.isFinite(at) || !zone) return false;
        const p = parts(at, zone);
        return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` === day;
      });
      this.forecast = current ? { date: day, high: current.temperature, low: current.templow } : null;
      this.error = null;
    } catch (error) {
      this.error = `Weather forecast unavailable: ${error.message}`;
      this.logger.warn(this.error);
    }
  }

  payload(config, alarms, states, haZone) {
    const settings = config.clock;
    const zone = config.time_zone || haZone || "";
    const weather = this.weather;
    const alarmState = states.find((state) => state.entity_id === settings.next_alarm_entity);
    let alarm = null;
    let alarmError = null;
    if (settings.next_alarm_entity) {
      if (!alarmState || ["unknown", "unavailable"].includes(alarmState.state)) alarmError = "The next-alarm entity is missing or unavailable.";
      else {
        try { alarm = alarmEntityAt(alarmState, haZone || zone, this.now()); }
        catch (error) { alarmError = error.message; }
      }
    } else alarm = nextAlarmAt(alarms.alarms, haZone || zone, this.now());
    const snooze = alarms.snoozed?.until;
    if (snooze && Date.parse(snooze) > this.now() && (!alarm || Date.parse(snooze) < Date.parse(alarm))) alarm = snooze;
    const weatherAvailable = weather && !["unknown", "unavailable"].includes(weather.state);
    const nightState = states.find((state) => state.entity_id === nightEntityId(settings));
    const nightError = settings.night_mode === "sun" && !["above_horizon", "below_horizon"].includes(nightState?.state)
      ? "Home Assistant sun.sun is missing, unavailable or invalid. Check the Sun integration. The last night state is retained."
      : ["entity", "illuminance"].includes(settings.night_mode)
        && (!nightState || ["unknown", "unavailable"].includes(nightState.state))
        ? "Choose an available Home Assistant entity for sensor-based night mode. The last night state is retained." : null;
    return {
      layout: settings.layout, clock: settings.layout === "full" ? settings.full_face : settings.face,
      widget: settings.widget, seconds: settings.seconds, secondHand: settings.second_hand,
      timeFormat: settings.time_format, locale: settings.language,
      timeZone: zone, weekStart: settings.week_start, primary: settings.primary,
      accent: settings.accent, secondsColor: settings.seconds_color, background: settings.background,
      night: ["entity", "illuminance", "sun"].includes(settings.night_mode) ? "entity" : settings.night_mode,
      nightStart: settings.night_start, nightEnd: settings.night_end,
      nightActive: this.night, nightColor: settings.night_color, nightBrightness: settings.night_brightness,
      weatherConfigured: Boolean(settings.weather_entity), weatherPlace: settings.weather_name || weather?.attributes?.friendly_name || "",
      weatherCondition: weather?.state ?? null,
      weatherTemperature: weatherAvailable && typeof weather.attributes?.temperature === "number" ? weather.attributes.temperature : null,
      weatherUnit: weather?.attributes?.temperature_unit ?? "°C",
      weatherDate: this.forecast?.date ?? null, weatherHigh: this.forecast?.high ?? null, weatherLow: this.forecast?.low ?? null,
      alarm, error: [this.error, alarmError].filter(Boolean).join(" ") || null,
      night_error: nightError,
    };
  }
}
