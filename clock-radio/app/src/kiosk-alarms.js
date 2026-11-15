import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RequestError } from "./errors.js";
import { WEEKDAYS, validateAlarmSchedule } from "./alarms.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const managed = (id) => typeof id === "string" && /^clock-radio-[a-f0-9]{32}$/.test(id);
const text = (value) => typeof value === "string" && value.length <= 1024;
const nativeDays = (days) => WEEKDAYS.flatMap((day, i) => days[day] ? [(i + 1) % 7] : []).sort();

export function kioskOptions(options) {
  const backend = options.alarm_backend ?? "home_assistant";
  if (!["home_assistant", "kiosk_satellite"].includes(backend)) throw new Error("alarm_backend must be home_assistant or kiosk_satellite.");
  for (const key of ["kiosk_satellite_url", "kiosk_satellite_token"]) {
    if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${key} must be a string.`);
  }
  if (backend === "home_assistant") return null;
  let url;
  try {
    url = new URL(options.kiosk_satellite_url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== "/") throw new Error();
  } catch {
    throw new Error("kiosk_satellite_url must be an HTTP(S) origin without a path, credentials, query or fragment.");
  }
  const token = options.kiosk_satellite_token;
  if (typeof token !== "string" || !token.trim() || /[\s]/.test(token)) throw new Error("kiosk_satellite_token is required and must not contain whitespace.");
  return { url: url.origin, token };
}

export class KioskAlarms {
  constructor({ url, token, fetchImpl = globalThis.fetch, logger = console, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url, token, fetch: fetchImpl, logger, timeoutMs, now });
    this.backendId = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    this.connected = false;
    this.updatedAt = null;
    this.error = "Connecting to Kiosk Satellite.";
    this.status = { alarms: [], ids: [], phase: "idle" };
    this.stations = [];
    this.musicError = "Loading Kiosk's Music Assistant radio library.";
    this.libraryAt = -Infinity;
    this.speaker = null;
    this.busy = false;
  }

  async command(name, params = {}, mutation = false) {
    const uncertain = mutation ? " The operation may have completed. Refresh Kiosk alarms before retrying." : "";
    let response, body;
    try {
      response = await this.fetch(`${this.url}/api/commands/${name}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(params),
      });
      body = await response.text();
    } catch {
      throw new RequestError(`Kiosk Satellite could not be reached or the request timed out.${uncertain}`, 502);
    }
    if (response.status === 401 || response.status === 403) throw new RequestError("Kiosk Satellite refused the API token. Renew it in the HA app configuration.", 502);
    let result;
    try {
      if (body.length > 2_000_000) throw new Error();
      result = JSON.parse(body);
    } catch { throw new RequestError(`Kiosk Satellite returned an invalid response (HTTP ${response.status}).${uncertain}`, 502); }
    if (object(result) && result.ok === false) {
      const detail = result?.error === "duplicate" ? "Another Kiosk alarm already has that time and repeat days."
        : result?.error === "no_source" ? "Configure Music Assistant and its local player on Kiosk before choosing music."
        : "Check the Kiosk version, configuration and Remote Administration logs.";
      throw new RequestError(`Kiosk Satellite rejected ${name}. ${detail}`, 502);
    }
    if (!response.ok || !object(result) || result.ok !== true) throw new RequestError(`Kiosk Satellite request failed (HTTP ${response.status}).${uncertain}`, 502);
    return result.data;
  }

  refresh() {
    this.loading ??= this.fetchStatus().finally(() => { this.loading = null; });
    return this.loading;
  }

  async fetchStatus() {
    try {
      const status = await this.command("alarmsStatus");
      if (!object(status) || !Array.isArray(status.alarms) || !Array.isArray(status.ids)
          || !status.ids.every((id) => text(id) && id.length > 0) || !["idle", "sunrise", "ringing", "snoozed"].includes(status.phase)
          || status.snoozedUntil != null && !(typeof status.snoozedUntil === "string" && Number.isFinite(Date.parse(status.snoozedUntil)))) {
        throw new RequestError("Kiosk Satellite returned invalid alarm status.", 502);
      }
      const ids = new Set();
      for (const alarm of status.alarms) {
        if (!object(alarm) || !text(alarm.id) || !alarm.id || ids.has(alarm.id) || typeof alarm.on !== "boolean"
            || !/^([01]\d|2[0-3]):[0-5]\d$/.test(alarm.time) || !Array.isArray(alarm.days)
            || new Set(alarm.days).size !== alarm.days.length || !alarm.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
            || alarm.next != null && !(typeof alarm.next === "string" && Number.isFinite(Date.parse(alarm.next)))) {
          throw new RequestError("Kiosk Satellite returned an invalid alarm definition.", 502);
        }
        ids.add(alarm.id);
      }
      this.status = status;
      this.connected = true;
      this.error = null;
      this.updatedAt = new Date(this.now()).toISOString();
      void this.refreshMusic();
    } catch (error) {
      if (this.error !== error.message) this.logger.warn(error.message);
      this.connected = false;
      this.error = error.message;
    }
  }

  refreshMusic() {
    if (this.libraryLoading) return this.libraryLoading;
    if (this.now() - this.libraryAt < (this.musicError ? 60_000 : 300_000)) return Promise.resolve();
    this.libraryLoading = this.fetchMusic().finally(() => { this.libraryLoading = null; });
    return this.libraryLoading;
  }

  async fetchMusic() {
    this.libraryAt = this.now();
    try {
      const source = await this.command("libraryPickerSource", { source: "ma" });
      if (!object(source) || source.source !== "ma" || !Array.isArray(source.speakers) || !Array.isArray(source.categories)) {
        throw new RequestError("Configure Music Assistant on Kiosk Satellite to choose alarm radio stations.", 409);
      }
      const speaker = source.speakers.find((item) => item.self === true && item.available === true && text(item.pick) && text(item.name));
      if (!speaker) throw new RequestError("Enable Kiosk's own Music Assistant/Sendspin player for music alarms on this device.", 409);
      const category = source.categories.find((item) => item.kind === "radio" && text(item.key));
      if (!category) throw new RequestError("Kiosk's Music Assistant source has no radio category.", 409);
      const stations = [];
      let more = true;
      while (more) {
        const page = await this.command("libraryPickerList", { source: "ma", speaker: speaker.pick, category: category.key, offset: stations.length });
        if (!object(page) || !Array.isArray(page.items) || typeof page.more !== "boolean" || page.more && !page.items.length) {
          throw new RequestError("Kiosk Satellite returned an invalid radio library page.", 502);
        }
        for (const item of page.items) {
          if (!object(item) || !text(item.id) || !item.id || item.kind !== "radio" || !text(item.title) || item.playable === false || !object(item.raw)) {
            throw new RequestError("Kiosk Satellite returned an invalid radio item.", 502);
          }
          const raw = Object.fromEntries(["item_id", "uri", "media_type", "provider", "path", "year"]
            .filter((key) => ["string", "number", "boolean"].includes(typeof item.raw[key])).map((key) => [key, item.raw[key]]));
          const id = `ks-radio-${crypto.createHash("sha256").update(item.id).digest("hex").slice(0, 16)}`;
          if (stations.some((station) => station.id === id)) throw new RequestError("Kiosk's radio library contains duplicate IDs.", 502);
          stations.push({ id, name: item.title, item: { id: item.id, kind: "radio", title: item.title, playable: true, expandable: false, raw } });
        }
        if (stations.length > 500) throw new RequestError("The experimental Kiosk backend supports at most 500 radio stations.", 409);
        more = page.more;
      }
      this.stations = stations;
      this.speaker = { pick: speaker.pick, name: speaker.name };
      this.musicError = null;
    } catch (error) {
      if (this.musicError !== error.message) this.logger.warn(error.message);
      this.musicError = error.message;
    }
  }

  snapshot() {
    const owned = this.status.alarms.filter((alarm) => managed(alarm.id));
    const activeOwned = this.status.ids.length > 0 && this.status.ids.every(managed);
    const next = owned.map((alarm) => alarm.next).filter((at) => typeof at === "string" && Number.isFinite(Date.parse(at))).sort();
    return {
      backend: "kiosk_satellite", backend_id: this.backendId, connected: this.connected,
      updated_at: this.updatedAt, error: this.error, native_phase: this.status.phase,
      native_active: activeOwned && this.status.phase !== "idle",
      next_at: activeOwned && this.status.phase === "snoozed" ? this.status.snoozedUntil ?? null : next[0] ?? null,
      scheduler_version: null, player: "", music_source: "", buzzer_source: "", active_player: "",
      active: null, active_id: null, snoozed: null, active_error: null, deleting: null, delete_error: null,
      can_create: this.connected, can_delete: this.connected, can_stop: false,
      can_snooze: false, can_play: false, playback_missing: [],
      radio_stations: this.stations.map(({ id, name }) => ({ id, name, image: null })),
      radio_error: this.musicError, buzzer_sounds: [],
      alarms: owned.map((alarm) => ({
        backend: "kiosk_satellite", id: alarm.id, enabled: alarm.on,
        native_busy: this.status.phase !== "idle" && this.status.ids.includes(alarm.id),
        type: alarm.music === "none" ? "Buzzer" : "Music",
        hour: Number(alarm.time.slice(0, 2)), minute: Number(alarm.time.slice(3)), volume: null, duration: null,
        days: Object.fromEntries(WEEKDAYS.map((day, i) => [day, alarm.days.includes((i + 1) % 7)])),
        missing: [], available: true, setup_complete: true, deletion_pending: false, timer: null, finishes_at: null,
        can_select_radio: true, can_select_sound: false, music_source_error: null, buzzer_source_error: null,
        music_station_id: this.stations.find((station) => station.item.id === alarm.music?.item?.id)?.id ?? null,
        music_station_name: alarm.music?.item?.title ?? (alarm.music === "none" ? null : "Kiosk default music"),
        music_source_set: alarm.music !== "none", buzzer_source_set: true,
        buzzer_sound_id: null, buzzer_sound_name: alarm.tone === "builtin" ? "Kiosk built-in tone" : "Kiosk configured tone",
      })),
    };
  }

  async mutate(action) {
    if (this.busy) throw new RequestError("A Kiosk alarm operation is already in progress. Wait for it to finish.", 409);
    this.busy = true;
    try {
      await this.refresh();
      if (!this.connected) throw new RequestError(this.error, 503);
      return await action();
    } finally {
      await this.refresh();
      this.busy = false;
    }
  }

  requireAlarm(id) {
    if (!managed(id)) throw new RequestError("Only Clock Radio's managed Kiosk test alarms can be changed.", 403);
    const alarm = this.status.alarms.find((item) => item.id === id);
    if (!alarm) throw new RequestError("This Kiosk alarm no longer exists. Reload saved values.", 409);
    if (this.status.phase !== "idle" && this.status.ids.includes(id)) throw new RequestError("Stop this alarm on Kiosk before editing or deleting it.", 409);
    return alarm;
  }

  async verify(id, expected) {
    if (this.loading) await this.loading;
    await this.refresh();
    const saved = this.status.alarms.find((alarm) => alarm.id === id);
    if (!this.connected || !expected(saved)) throw new RequestError("Kiosk has not confirmed the requested alarm change. Inspect its alarms before retrying.", 502);
  }

  create(body) {
    if (!object(body) || Object.keys(body).length) throw new RequestError("Create Kiosk alarm takes an empty object.");
    return this.mutate(async () => {
      const days = [1, 2, 3, 4, 5];
      let minute = 360;
      while (minute < 1800 && this.status.alarms.some((alarm) => alarm.time === `${String(Math.floor(minute % 1440 / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
        && JSON.stringify([...alarm.days].sort()) === JSON.stringify(days))) minute++;
      if (minute === 1800) throw new RequestError("No unused weekday alarm time is available on Kiosk.", 409);
      const id = `clock-radio-${crypto.randomBytes(16).toString("hex")}`;
      const alarm = { id, time: `${String(Math.floor(minute % 1440 / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
        days, on: false, label: "Clock Radio [TEST]", tone: "builtin", music: "none", sunrise: false, speak: false, phrase: "" };
      await this.command("alarmSave", { alarm }, true);
      await this.verify(id, (saved) => Boolean(saved) && saved.on === false && saved.time === alarm.time);
      return { alarm_id: id };
    });
  }

  save(body) {
    if (!object(body) || Object.keys(body).some((key) => !["id", "enabled", "type", "hour", "minute", "days", "music_station_id"].includes(key))) throw new RequestError("Unknown Kiosk alarm setting.");
    validateAlarmSchedule(body, { allowOnce: true });
    if (Object.hasOwn(body, "music_station_id") && (body.type !== "Music" || typeof body.music_station_id !== "string"
        || !/^ks-radio-[a-f0-9]{16}$/.test(body.music_station_id))) throw new RequestError("Choose a Kiosk radio station for a Music alarm; Buzzer alarms do not accept station changes.");
    return this.mutate(async () => {
      const current = this.requireAlarm(body.id);
      const alarm = { ...current, time: `${String(body.hour).padStart(2, "0")}:${String(body.minute).padStart(2, "0")}`, days: nativeDays(body.days), on: body.enabled };
      delete alarm.next;
      if (body.type === "Buzzer") alarm.music = "none";
      else if (Object.hasOwn(body, "music_station_id")) {
        if (this.musicError) throw new RequestError(this.musicError, 409);
        const station = this.stations.find((item) => item.id === body.music_station_id);
        if (!station || !this.speaker) throw new RequestError("Choose a radio from Kiosk's current Music Assistant library.", 409);
        alarm.music = { source: "ma", item: station.item, speaker: this.speaker.pick, speakerName: this.speaker.name, shuffle: false };
      } else if (!object(current.music)) throw new RequestError("Choose a Music Assistant radio station before saving a Music alarm.", 409);
      await this.command("alarmSave", { alarm }, true);
      await this.verify(body.id, (saved) => Boolean(saved) && saved.on === alarm.on && saved.time === alarm.time
        && JSON.stringify([...saved.days].sort()) === JSON.stringify(alarm.days) && isDeepStrictEqual(saved.music, alarm.music));
    });
  }

  delete(body) {
    if (!object(body) || Object.keys(body).length !== 1) throw new RequestError("Delete Kiosk alarm requires only its ID.");
    return this.mutate(async () => {
      if (this.requireAlarm(body.id).on) throw new RequestError("Disable the native alarm before deleting it.", 409);
      await this.command("alarmDelete", { id: body.id }, true);
      await this.verify(body.id, (saved) => !saved);
    });
  }

  control() {
    throw new RequestError("Use Kiosk's native ringing screen for Stop and Snooze. Its Remote API controls all simultaneous alarms, including unrelated native alarms.", 409);
  }
}
