import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RequestError } from "./errors.js";
import { WEEKDAYS, validateAlarmSchedule } from "./alarms.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const managed = (id) => typeof id === "string" && /^clock-radio-[a-f0-9]{32}$/.test(id);
const text = (value) => typeof value === "string" && value.length <= 1024;
const nativeDays = (days) => WEEKDAYS.flatMap((day, i) => days[day] ? [(i + 1) % 7] : []).sort();
const sources = ["ma", "ha", "sonos"];
const choiceId = (kind, value) => `ks-${kind}-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
const musicId = (pick) => choiceId("music", [pick.source, pick.speaker ?? "", pick.item?.id ?? pick.random]);

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
    this.busy = false;
    this.musicChoices = new Map();
    this.speakers = new Map();
    this.tones = new Map();
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
        : result?.error === "no_source" ? "Configure a Music Assistant, Home Assistant or Sonos music source on Kiosk Satellite."
        : "Check the Kiosk version, configuration and Remote Administration logs.";
      throw new RequestError(`Kiosk Satellite rejected ${name}. ${detail}`, 502);
    }
    if (!response.ok || !object(result) || result.ok !== true) throw new RequestError(`Kiosk Satellite request failed (HTTP ${response.status}).${uncertain}`, 502);
    return result.data;
  }

  remember(map, id, value) {
    map.delete(id);
    map.set(id, value);
    if (map.size > 2000) map.delete(map.keys().next().value);
    return id;
  }

  async soundOptions() {
    const data = await this.command("listNotificationSounds");
    if (!object(data) || !Array.isArray(data.sounds) || data.sounds.length > 2000
        || !data.sounds.every((name) => text(name) && name && name.length <= 255 && !/[/\\]/.test(name) && ![".", "..", "builtin"].includes(name))
        || new Set(data.sounds).size !== data.sounds.length) throw new RequestError("Kiosk returned an invalid sound catalog.", 502);
    return { sounds: [
      { id: null, name: "Use Kiosk tone default" }, { id: "builtin", name: "Kiosk built-in alarm" },
      ...data.sounds.map((name) => ({ id: this.remember(this.tones, choiceId("tone", name), name), name })),
    ] };
  }

  async musicOptions(params = {}) {
    if (!object(params) || Object.keys(params).some((key) => !["source", "speaker", "category", "parent", "offset"].includes(key))
        || Object.values(params).some((value) => !text(value))
        || params.source !== undefined && !sources.includes(params.source)
        || params.offset !== undefined && !/^(0|[1-9]\d{0,5})$/.test(params.offset)) throw new RequestError("Invalid native music browser settings.");
    const savedSpeaker = this.status.alarms.map((alarm) => alarm.music).find((pick) => object(pick)
      && pick.source === params.source && choiceId("speaker", [pick.source, pick.speaker ?? ""]) === params.speaker);
    const requestedSpeaker = params.speaker === undefined ? null : this.speakers.get(params.speaker)
      ?? (savedSpeaker ? { source: savedSpeaker.source, pick: savedSpeaker.speaker ?? "" } : null);
    if (params.speaker !== undefined && (!requestedSpeaker || requestedSpeaker.source !== params.source)) throw new RequestError("This Kiosk speaker choice expired. Refresh the music choices.", 409);
    let info = await this.command("libraryPickerSource", {
      ...(params.source ? { source: params.source } : {}),
      ...(requestedSpeaker ? { speaker: requestedSpeaker.pick } : {}),
    });
    const validate = () => {
      if (!object(info) || !sources.includes(info.source) || params.source && info.source !== params.source
          || !Array.isArray(info.sources) || !Array.isArray(info.speakers) || !Array.isArray(info.categories)
          || !info.speakers.every((sp) => object(sp) && text(sp.pick) && text(sp.name) && typeof sp.available === "boolean")
          || !info.categories.every((cat) => object(cat) && text(cat.key) && cat.key && text(cat.kind))) {
        throw new RequestError("Kiosk returned an invalid or unsupported native music source.", 502);
      }
    };
    validate();
    const speaker = requestedSpeaker
      ? info.speakers.find((sp) => sp.pick === requestedSpeaker.pick)
      : info.speakers.find((sp) => sp.available && sp.pick === info.followed) ?? info.speakers.find((sp) => sp.available);
    if (requestedSpeaker && !speaker?.available) throw new RequestError("The selected Kiosk music speaker is unavailable.", 409);
    if (info.source === "ha" && speaker && !requestedSpeaker) {
      info = await this.command("libraryPickerSource", { source: "ha", speaker: speaker.pick });
      validate();
    }
    const source = info.source;
    const categories = [
      ...(info.browse === true ? [{ key: "browse", kind: "folder" }] : []), ...info.categories,
    ];
    const category = params.category ?? categories.find((cat) => cat.kind === "radio")?.key
      ?? categories.find((cat) => cat.key === "favorites")?.key ?? categories[0]?.key;
    if (params.category !== undefined && !categories.some((cat) => cat.key === category)) throw new RequestError("This native music category is unavailable.", 409);
    const base = { source, speaker: speaker?.pick ?? "" };
    const parent = params.parent === undefined ? null : this.musicChoices.get(params.parent);
    if (params.parent !== undefined && (!parent || parent.pick.source !== source
        || parent.pick.speaker !== base.speaker || !parent.pick.item.expandable)) throw new RequestError("This music folder choice expired. Refresh the music choices.", 409);
    const offset = Number(params.offset ?? 0);
    const page = !speaker || !category ? { items: [], more: false }
      : parent ? await this.command("libraryPickerOpen", { ...base, item: parent.pick.item })
      : category === "browse" ? await this.command("libraryPickerBrowse", base)
      : await this.command("libraryPickerList", { ...base, category, offset });
    if (!object(page) || !Array.isArray(page.items) || page.items.length > 1000
        || page.more !== undefined && typeof page.more !== "boolean" || page.more && !page.items.length) {
      throw new RequestError("Kiosk returned an invalid music library page.", 502);
    }
    const items = page.items.map((entry) => {
      if (!object(entry) || !text(entry.id) || !entry.id || !text(entry.title) || !text(entry.kind)
          || entry.raw !== undefined && !object(entry.raw)) throw new RequestError("Kiosk returned an invalid music item.", 502);
      const item = { id: entry.id, kind: entry.kind, title: entry.title, playable: entry.playable !== false, expandable: entry.expandable === true };
      if (entry.raw) item.raw = Object.fromEntries(Object.entries(entry.raw)
        .filter(([, value]) => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)));
      const pick = { source, item, shuffle: false, speaker: speaker.pick, speakerName: speaker.name };
      const id = this.remember(this.musicChoices, musicId(pick), { pick });
      return { id, name: item.title, kind: item.kind, playable: item.playable, expandable: item.expandable };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new RequestError("Kiosk returned duplicate music items.", 502);
    return {
      sources: info.sources.filter((key) => sources.includes(key)), source, categories, category: category ?? "",
      speakers: info.speakers.map((sp) => ({
        id: this.remember(this.speakers, choiceId("speaker", [source, sp.pick]), { source, pick: sp.pick }),
        name: sp.name, available: sp.available,
      })),
      speaker: speaker ? choiceId("speaker", [source, speaker.pick]) : null,
      items, more: !parent && category !== "browse" && page.more === true, offset: offset + items.length,
      note: speaker ? "Select music and its speaker for this alarm. Save applies the choice; nothing plays now."
        : "No available speakers for this source. Check its configuration on Kiosk.",
    };
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
    } catch (error) {
      if (this.error !== error.message) this.logger.warn(error.message);
      this.connected = false;
      this.error = error.message;
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
      radio_stations: [], radio_error: null, buzzer_sounds: [],
      alarms: owned.map((alarm) => ({
        backend: "kiosk_satellite", id: alarm.id, enabled: alarm.on,
        native_busy: this.status.phase !== "idle" && this.status.ids.includes(alarm.id),
        type: alarm.music === "none" ? "Buzzer" : "Music",
        hour: Number(alarm.time.slice(0, 2)), minute: Number(alarm.time.slice(3)), volume: null, duration: null,
        days: Object.fromEntries(WEEKDAYS.map((day, i) => [day, alarm.days.includes((i + 1) % 7)])),
        missing: [], available: true, setup_complete: true, deletion_pending: false, timer: null, finishes_at: null,
        can_select_radio: this.connected, can_select_sound: this.connected, music_source_error: null, buzzer_source_error: null,
        music_station_id: object(alarm.music) ? musicId(alarm.music) : null,
        music_source: object(alarm.music) ? alarm.music.source : null,
        music_speaker_id: object(alarm.music) ? choiceId("speaker", [alarm.music.source, alarm.music.speaker ?? ""]) : null,
        music_speaker_name: object(alarm.music) ? alarm.music.speakerName ?? "" : "",
        music_station_name: alarm.music?.item?.title ?? (alarm.music === "none" ? null : "Kiosk Alarm music default"),
        music_source_set: alarm.music !== "none", buzzer_source_set: Boolean(alarm.tone),
        buzzer_sound_id: !alarm.tone ? null : alarm.tone === "builtin" ? "builtin" : choiceId("tone", alarm.tone),
        buzzer_sound_name: !alarm.tone ? "Kiosk tone default" : alarm.tone === "builtin" ? "Kiosk built-in alarm" : alarm.tone,
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
    if (!object(body) || Object.keys(body).some((key) => !["id", "enabled", "type", "hour", "minute", "days", "music_station_id", "buzzer_sound_id"].includes(key))) throw new RequestError("Unknown Kiosk alarm setting.");
    validateAlarmSchedule(body, { allowOnce: true });
    const hasMusic = Object.hasOwn(body, "music_station_id");
    const hasTone = Object.hasOwn(body, "buzzer_sound_id");
    const music = hasMusic && body.music_station_id !== null ? this.musicChoices.get(body.music_station_id)?.pick : null;
    const tone = body.buzzer_sound_id === null ? "" : body.buzzer_sound_id === "builtin" ? "builtin" : this.tones.get(body.buzzer_sound_id);
    if (hasMusic && (body.type !== "Music" || body.music_station_id !== null && !music?.item.playable)) throw new RequestError("Select an available native music item in Clock Radio before saving.", 409);
    if (hasTone && typeof tone !== "string") throw new RequestError("Select an available native buzzer tone in Clock Radio before saving.", 409);
    return this.mutate(async () => {
      this.requireAlarm(body.id);
      if (music) {
        const info = await this.command("libraryPickerSource", { source: music.source, speaker: music.speaker });
        if (info?.source !== music.source || !info?.speakers?.some((sp) => sp.pick === music.speaker && sp.available === true)) throw new RequestError("The selected Kiosk music source or speaker is unavailable.", 409);
      }
      if (hasTone && ![null, "builtin"].includes(body.buzzer_sound_id)) {
        const options = await this.soundOptions();
        if (!options.sounds.some(({ id }) => id === body.buzzer_sound_id) || this.tones.get(body.buzzer_sound_id) !== tone) throw new RequestError("The selected Kiosk sound is no longer available.", 409);
      }
      if (music || hasTone) {
        if (this.loading) await this.loading;
        await this.refresh();
        if (!this.connected) throw new RequestError(this.error, 503);
      }
      const current = this.requireAlarm(body.id);
      const alarm = { ...current, time: `${String(body.hour).padStart(2, "0")}:${String(body.minute).padStart(2, "0")}`, days: nativeDays(body.days), on: body.enabled };
      delete alarm.next;
      if (body.type === "Buzzer") alarm.music = "none";
      else if (hasMusic && music) alarm.music = structuredClone(music);
      else if (hasMusic || current.music === "none") delete alarm.music;
      if (hasTone) alarm.tone = tone;
      await this.command("alarmSave", { alarm }, true);
      await this.verify(body.id, (saved) => Boolean(saved) && saved.on === alarm.on && saved.time === alarm.time
        && JSON.stringify([...saved.days].sort()) === JSON.stringify(alarm.days) && isDeepStrictEqual(saved.music, alarm.music)
        && saved.tone === alarm.tone);
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
