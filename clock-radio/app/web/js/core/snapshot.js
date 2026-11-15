import { clockRendererOptions, parseClockOptions } from "../lib/clock-options.js";
import { ALARM_SOUNDS } from "../lib/alarm-sounds.js";

const KEY = "clock-radio.snapshot";
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function check(valid, field) {
  if (!valid) throw new Error(`Invalid offline snapshot ${field}.`);
}
function text(value, field, max = 256) {
  check(typeof value === "string" && value.length <= max, field);
  return value;
}
function boolean(value, field) {
  check(typeof value === "boolean", field);
  return value;
}
function zone(value) {
  text(value, "time zone");
  if (value) new Intl.DateTimeFormat("en", { timeZone: value });
  return value;
}

function readSnapshot(raw) {
  check(object(raw) && raw.schema === 1, "version");
  check(typeof raw.saved_at === "string" && Number.isFinite(Date.parse(raw.saved_at)), "synchronization time");
  check(object(raw.config) && Array.isArray(raw.alarms) && raw.alarms.length <= 1000, "contents");
  const config = raw.config;
  check(object(config.clock), "clock settings");
  const locale = text(config.locale, "locale");
  new Intl.DateTimeFormat(locale);
  check(Number.isInteger(config.return_to_clock_minutes) && config.return_to_clock_minutes >= 0
    && config.return_to_clock_minutes <= 1440, "return-to-clock timeout");
  check(["Auto", "Day", "Night"].includes(raw.night_override), "night override");
  const ids = new Set();
  const backend = raw.backend ?? "home_assistant";
  check(["home_assistant", "kiosk_satellite"].includes(backend), "alarm backend");
  const native = backend === "kiosk_satellite";
  if (native) check(typeof raw.backend_id === "string" && /^[a-f0-9]{16}$/.test(raw.backend_id), "Kiosk identity");
  return {
    schema: 1, saved_at: new Date(raw.saved_at).toISOString(),
    backend, backend_id: native ? raw.backend_id : null,
    version: text(raw.version, "app version", 64),
    demo: boolean(raw.demo, "demo mode"), time_zone: zone(raw.time_zone),
    night_override: raw.night_override, night_active: boolean(raw.night_active, "night state"),
    config: {
      title: text(config.title, "title"), locale, time_zone: zone(config.time_zone),
      sun_entity: text(config.sun_entity, "Sun entity"),
      return_to_clock_minutes: config.return_to_clock_minutes,
      clock_24h: boolean(config.clock_24h, "clock format"),
      show_seconds: boolean(config.show_seconds, "seconds"),
      default_player: text(config.default_player, "speaker"), stations: [],
      clock: parseClockOptions(config.clock),
    },
    alarms: raw.alarms.map((alarm) => {
      check(object(alarm) && (native ? typeof alarm.id === "string" && /^clock-radio-[a-f0-9]{32}$/.test(alarm.id)
        : Number.isSafeInteger(alarm.id) && alarm.id > 0) && !ids.has(alarm.id), "alarm ID");
      ids.add(alarm.id);
      check(object(alarm.days) && Array.isArray(alarm.missing), "alarm helpers");
      const result = {
        id: alarm.id, ...(native ? { backend } : {}), enabled: boolean(alarm.enabled, "alarm enabled state"),
        type: alarm.type === null ? null : text(alarm.type, "alarm type", 32),
        available: boolean(alarm.available, "alarm availability"),
        setup_complete: boolean(alarm.setup_complete, "alarm setup"),
        missing: alarm.missing.map((id) => text(id, "missing helper")),
        days: Object.fromEntries(DAYS.map((day) => [day, boolean(alarm.days[day], day)])),
        buzzer_sound_name: alarm.buzzer_sound_name === null ? null : text(alarm.buzzer_sound_name, "sound"),
        music_station_name: alarm.music_station_name === null ? null : text(alarm.music_station_name, "station"),
        music_source_set: boolean(alarm.music_source_set, "radio source"),
        buzzer_source_set: boolean(alarm.buzzer_source_set, "sound source"),
        buzzer_sound_id: alarm.buzzer_sound_id,
      };
      check(result.buzzer_sound_id === null || ALARM_SOUNDS.some(({ id }) => id === result.buzzer_sound_id), "sound ID");
      for (const key of ["hour", "minute", "volume", "duration"]) {
        check(alarm[key] === null || typeof alarm[key] === "number" && Number.isFinite(alarm[key]), `alarm ${key}`);
        result[key] = alarm[key];
      }
      return result;
    }),
  };
}

export class SnapshotStore {
  constructor({ storage = () => globalThis.localStorage, logger = console } = {}) {
    Object.assign(this, { storage, logger, data: null, error: null, signature: "", attemptedAt: -Infinity });
    try {
      const saved = this.storage().getItem(KEY);
      if (saved !== null) {
        check(saved.length <= 1_000_000, "size");
        this.data = readSnapshot(JSON.parse(saved));
      }
    } catch (error) { this.report(error); }
  }

  report(error) {
    const message = `Offline snapshot unavailable: ${error.message}`;
    if (message !== this.error) this.logger.warn(message);
    this.error = message;
  }

  save(model, now = Date.now()) {
    const native = model.alarms.backend === "kiosk_satellite";
    if (!(native ? model.alarms.connected : model.connected) || model.offline_snapshot || model.alarms.deleting) return;
    try {
      const data = readSnapshot({
        schema: 1, saved_at: native ? model.alarms.updated_at : model.updated_at, version: model.version, demo: model.demo,
        backend: model.alarms.backend, backend_id: model.alarms.backend_id,
        config: model.config, time_zone: model.clock.timeZone,
        night_override: model.night_override.value, night_active: model.clock.nightActive,
        alarms: model.alarms.alarms,
      });
      this.data = data;
      const signature = JSON.stringify({ ...data, saved_at: null });
      if (signature === this.signature && now - this.attemptedAt < 60_000) return;
      this.signature = signature;
      this.attemptedAt = now;
      this.storage().setItem(KEY, JSON.stringify(data));
      this.error = null;
    } catch (error) { this.report(error); }
  }

  restore(message) {
    if (!this.data) return null;
    const data = readSnapshot(this.data);
    const config = data.config;
    const night = data.night_override;
    const appearance = clockRendererOptions(config.clock, data.time_zone);
    return {
      version: data.version, demo: data.demo, read_only: true, connected: false,
      updated_at: data.saved_at, offline_snapshot: true, connection_error: message,
      config_error: null, missing_players: [], players: [], config, clock_entities: [],
      night_override: { value: night, available: false, error: "Offline: last synchronized value." },
      clock: {
        ...appearance,
        night: night === "Day" ? "off" : night === "Night" ? "always" : appearance.night,
        nightActive: data.night_active, alarm: null, error: null, night_error: null,
        weatherConfigured: Boolean(config.clock.weather_entity), weatherPlace: config.clock.weather_name,
        weatherCondition: null, weatherTemperature: null, weatherUnit: "",
        weatherDate: null, weatherHigh: null, weatherLow: null,
      },
      alarms: {
        backend: data.backend, backend_id: data.backend_id, connected: false, updated_at: data.saved_at,
        error: message, native_phase: "unknown", native_active: false, next_at: null,
        scheduler_version: null, player: config.default_player, music_source: "", buzzer_source: "",
        active_player: "", active: null, active_id: null, snoozed: null,
        active_error: null, deleting: null, delete_error: null,
        can_create: false, can_delete: false, can_stop: false, can_snooze: false, can_play: false,
        playback_missing: [], radio_stations: [], radio_error: null, buzzer_sounds: ALARM_SOUNDS,
        alarms: data.alarms.map((alarm) => ({
          ...alarm, deletion_pending: false, timer: null, finishes_at: null,
          can_select_radio: false, can_select_sound: false,
          music_source_error: null, buzzer_source_error: null,
          music_station_id: null,
        })),
      },
      music: {
        title: "Music overview", players: [], default_player: config.default_player,
        stations: [], tabs: ["radio"], library: false, library_missing: "both",
        error: "Offline. Reconnect for music information and controls.",
      },
    };
  }
}

export function offlineStatus(model) {
  const native = model.alarms.backend === "kiosk_satellite";
  if (model.connected && (!native || model.alarms.connected)) return "";
  const saved = Date.parse(native ? model.alarms.updated_at : model.updated_at);
  const last = Number.isFinite(saved) ? ` Last synchronized: ${new Intl.DateTimeFormat(model.config.locale, {
    dateStyle: "short", timeStyle: "medium", timeZone: model.clock.timeZone || undefined,
  }).format(saved)}.` : " No confirmed alarm snapshot is available.";
  if (native) {
    const ha = model.connected ? "" : "Home Assistant is offline. ";
    return ha + (model.alarms.connected
      ? `Kiosk alarms are connected${model.read_only ? " (read-only)" : " and editable"}.`
      : `Kiosk is offline. Saved native schedules are read-only.${last} Native execution cannot be confirmed from this dashboard.`);
  }
  return `Offline - ${model.offline_snapshot ? "showing saved schedules" : "showing last received data"}. Read-only.${last} HA alarm execution cannot be confirmed.`;
}
