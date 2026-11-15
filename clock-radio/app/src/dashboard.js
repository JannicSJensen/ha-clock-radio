import { RequestError } from "./errors.js";
import crypto from "node:crypto";
import { ClockData, NIGHT_OVERRIDE_ENTITY } from "./clock-data.js";
import { alarmEntities, alarmSnapshot, canCreateAlarm, deleteAlarm, provisionAlarm, saveAlarm, validateAlarm, validateDeleteAlarm, validatePlaybackSettings } from "./alarms.js";
import { availableTabs } from "./music.js";
import { fetchImage } from "./images.js";
import { parseClockOptions } from "../web/js/lib/clock-options.js";
import { ALARM_SOUNDS, alarmSoundId } from "../web/js/lib/alarm-sounds.js";
export { RequestError } from "./errors.js";

const extraFields = { play_station: "station_id", volume_set: "volume_level", media_seek: "seek_position", shuffle_set: "shuffle", repeat_set: "repeat" };
const actions = new Set(["play_station", "media_play", "media_pause", "media_stop", "media_play_pause", "media_next_track", "media_previous_track", "volume_set", "media_seek", "shuffle_set", "repeat_set"]);

export function validateCommand(body, { config, players, readOnly }) {
  if (readOnly) throw new RequestError("The dashboard is read-only.", 403);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object.");
  if (Object.keys(body).some((key) => !["action", "entity_id", extraFields[body.action]].includes(key))) throw new RequestError("Unknown command field.");
  if (!actions.has(body.action)) throw new RequestError("This action is not allowed.");
  const player = players.find((item) => item.entity_id === body.entity_id);
  if (!player) throw new RequestError("This player is not part of the dashboard.", 403);
  if (["unavailable", "unknown"].includes(player.state)) throw new RequestError("This player is unavailable.", 409);
  if (body.action !== "play_station" && body.station_id !== undefined) throw new RequestError("station_id is only valid for play_station.");
  if (body.action !== "volume_set" && body.volume_level !== undefined) throw new RequestError("volume_level is only valid for volume_set.");
  const data = { entity_id: player.entity_id };
  if (body.action === "play_station") {
    const station = config.stations.find((item) => item.id === body.station_id);
    if (!station) throw new RequestError("Unknown radio station.");
    if (station.source === "music_assistant") {
      return { domain: "music_assistant", service: "play_media", data: { ...data, media_id: station.media_content_id, media_type: "radio", enqueue: "replace" } };
    }
    return { domain: "media_player", service: "play_media", data: { ...data, media_content_id: station.media_content_id, media_content_type: station.media_content_type } };
  }
  if (body.action === "volume_set") {
    if (typeof body.volume_level !== "number" || !Number.isFinite(body.volume_level) || body.volume_level < 0 || body.volume_level > 1) {
      throw new RequestError("volume_level must be a number between 0 and 1.");
    }
    data.volume_level = body.volume_level;
  }
  if (body.action === "media_seek") {
    const duration = player.attributes?.media_duration;
    if (!Number.isFinite(body.seek_position) || body.seek_position < 0 || !Number.isFinite(duration) || body.seek_position > duration) throw new RequestError("Seek position must be within this track.");
    data.seek_position = body.seek_position;
  }
  if (body.action === "shuffle_set") {
    if (typeof body.shuffle !== "boolean") throw new RequestError("shuffle must be a boolean.");
    data.shuffle = body.shuffle;
  }
  if (body.action === "repeat_set") {
    if (!["off", "one", "all"].includes(body.repeat)) throw new RequestError("repeat must be off, one or all.");
    data.repeat = body.repeat;
  }
  return { domain: "media_player", service: body.action, data };
}

export class Dashboard {
  constructor({ ha, configStore, music = null, radio = null, mediaPlayer = "", weatherEntity = "", sunEntity = "sun.sun", returnToClockMinutes = 2, readOnly = false, demo = false, version, logger = console }) {
    Object.assign(this, { ha, configStore, music, radio, mediaPlayer, weatherEntity, sunEntity, returnToClockMinutes, readOnly, demo, version, logger });
    this.states = [];
    this.connected = false;
    this.connectionError = "Connecting to Home Assistant.";
    this.updatedAt = null;
    this.clockData = new ClockData({ ha, logger });
    this.haTimeZone = "";
    this.timeZoneError = null;
    this.alarmWrites = new Set();
  }

  get config() {
    const config = this.configStore.current;
    return { ...config, sun_entity: this.sunEntity, clock: { ...config.clock, weather_entity: this.weatherEntity } };
  }

  refresh() {
    this.loading ??= this.fetchStates().finally(() => { this.loading = null; });
    return this.loading;
  }

  async fetchStates() {
    this.configStore.load();
    try {
      this.states = await this.ha.states();
      this.connected = true;
      this.connectionError = null;
      this.updatedAt = new Date().toISOString();
    } catch (error) {
      const message = `Home Assistant unavailable: ${error.message}`;
      if (message !== this.connectionError) this.logger.warn(message);
      this.connected = false;
      this.connectionError = message;
      return;
    }
    if (!this.haTimeZone && typeof this.ha.timeZone === "function") {
      try {
        this.haTimeZone = await this.ha.timeZone();
        this.timeZoneError = null;
      } catch (error) {
        this.timeZoneError = `Home Assistant time zone unavailable: ${error.message}`;
        this.logger.warn(this.timeZoneError);
      }
    }
    const alarms = alarmSnapshot(this.states);
    this.alarmPlayerError = null;
    if (this.mediaPlayer && !alarms.playback_missing.length
        && alarms.alarms.every((alarm) => alarm.available) && alarms.player !== this.mediaPlayer && !this.alarmWrites.size) {
      if (this.readOnly) this.alarmPlayerError = "Read-only mode cannot apply the configured speaker to HA alarms. They still use the existing HA speaker helper.";
      else {
        try { await this.writeAlarmPlayback({ player: this.mediaPlayer }); }
        catch (error) { this.alarmPlayerError = error.message; this.logger.warn(error.message); }
        try { this.states = await this.ha.states(); }
        catch (error) { this.connected = false; this.connectionError = `Home Assistant unavailable: ${error.message}`; this.logger.warn(this.connectionError); return; }
      }
    }
    const config = this.config;
    await this.clockData.refresh(config, this.states, config.time_zone || this.haTimeZone);
    if (this.radio) await this.radio.refresh();
  }

  radioArtwork(state) {
    return this.radio?.stations.find((station) => station.uri === state?.attributes?.media_content_id)?.image ?? null;
  }

  payload() {
    const config = this.config;
    const states = this.states.filter((state) => state.entity_id === this.mediaPlayer);
    const players = states.map((state) => {
      const attributes = state.attributes ?? {};
      const safeAttributes = {};
      for (const key of ["friendly_name", "media_title", "media_artist", "media_album_name", "media_content_type", "media_channel", "media_playlist", "media_duration", "media_position", "media_position_updated_at", "volume_level", "supported_features", "shuffle", "repeat"]) {
        if (["string", "number", "boolean"].includes(typeof attributes[key])) safeAttributes[key] = attributes[key];
      }
      safeAttributes.group_members = Array.isArray(attributes.group_members) ? attributes.group_members.filter((id) => states.some((player) => player.entity_id === id)) : [];
      if (typeof attributes.media_content_id === "string" && /^[a-z0-9_.-]+:\/\/[a-z_]+\/\S{1,400}$/i.test(attributes.media_content_id) && !/^https?:/.test(attributes.media_content_id)) safeAttributes.media_content_id = attributes.media_content_id;
      const radioArtwork = this.radioArtwork(state);
      if (radioArtwork) safeAttributes.entity_picture = radioArtwork;
      else if (attributes.entity_picture) {
        const hash = crypto.createHash("sha256").update(String(attributes.entity_picture)).digest("hex").slice(0, 12);
        safeAttributes.entity_picture = `api/player/image/${encodeURIComponent(state.entity_id)}?v=${hash}`;
      }
      return {
        entity_id: state.entity_id,
        name: attributes.friendly_name ?? state.entity_id,
        state: state.state,
        title: attributes.media_title ?? "",
        artist: attributes.media_artist ?? "",
        volume_level: typeof attributes.volume_level === "number" ? attributes.volume_level : null,
        supported_features: Number.isSafeInteger(attributes.supported_features) ? attributes.supported_features : 0,
        attributes: safeAttributes,
      };
    });
    const alarms = alarmSnapshot(this.states);
    alarms.can_create = canCreateAlarm(alarms);
    alarms.radio_stations = (this.radio?.stations ?? []).map(({ id, name, image }) => ({ id, name, image }));
    alarms.radio_error = this.radio?.error ?? (this.radio ? null : "Music Assistant radio library is unavailable.");
    alarms.buzzer_sounds = ALARM_SOUNDS;
    for (const alarm of alarms.alarms) {
      const source = alarm.music_source;
      const station = this.radio?.stations.find((item) => item.uri === source);
      alarm.music_source_set = Boolean(source);
      delete alarm.music_source;
      alarm.music_station_id = station?.id ?? null;
      alarm.music_station_name = station?.name ?? null;
      alarm.buzzer_sound_id = alarmSoundId(alarm.buzzer_source);
      alarm.buzzer_sound_name = ALARM_SOUNDS.find(({ id }) => id === alarm.buzzer_sound_id)?.name ?? null;
      alarm.buzzer_source_set = Boolean(alarm.buzzer_source);
      delete alarm.buzzer_source;
    }
    const clock = this.clockData.payload(config, alarms, this.states, this.haTimeZone);
    clock.error = [clock.error, this.timeZoneError].filter(Boolean).join(" ") || null;
    const errors = [clock.error, clock.night_error].filter(Boolean).join(" ");
    if (errors && errors !== this.clockError) this.logger.warn(errors);
    this.clockError = errors;
    const stations = this.radio ? this.radio.payload(config) : config.stations.map(({ id, name }) => ({ id, name }));
    return {
      version: this.version, demo: this.demo, read_only: this.readOnly,
      connected: this.connected, updated_at: this.updatedAt,
      connection_error: this.connectionError,
      config_error: [this.configStore.error, !this.mediaPlayer ? "Select media_player in the Home Assistant app configuration." : null, this.alarmPlayerError].filter(Boolean).join(" ") || null,
      missing_players: this.mediaPlayer && !states.length ? [this.mediaPlayer] : [],
      config: {
        title: config.title, locale: config.locale, time_zone: config.time_zone,
        sun_entity: this.sunEntity,
        return_to_clock_minutes: this.returnToClockMinutes,
        clock_24h: config.clock_24h, show_seconds: config.show_seconds,
        default_player: this.mediaPlayer,
        stations: config.stations.map(({ id, name }) => ({ id, name })),
        clock: config.clock,
      },
      players, alarms, clock,
      night_override: { entity_id: NIGHT_OVERRIDE_ENTITY, ...(this.clockData.override ?? { value: "Auto", available: false, error: null }) },
      clock_entities: this.states.filter((state) => /^(weather|sensor|input_datetime|input_boolean|binary_sensor|switch|sun)\./.test(state.entity_id))
        .map((state) => ({ entity_id: state.entity_id, name: state.attributes?.friendly_name || state.entity_id, device_class: state.attributes?.device_class ?? null })),
      music: {
        title: "Music overview", players: players.map((player) => player.entity_id),
        default_player: this.mediaPlayer, stations,
        tabs: availableTabs(null, this.music?.configured === true),
        library: this.music?.configured === true, library_missing: this.music?.client.missing ?? "both",
        error: this.radio?.error ?? null,
      },
    };
  }

  async command(body) {
    await this.refresh();
    if (!this.connected) throw new RequestError("Home Assistant is disconnected.", 503);
    const command = validateCommand(body, { config: this.configStore.current, players: this.payload().players, readOnly: this.readOnly });
    await this.ha.callService(command.domain, command.service, command.data);
    await this.refresh();
  }

  async mutationReady() {
    if (this.readOnly) throw new RequestError("The dashboard is read-only.", 403);
    await this.refresh();
    if (!this.connected) throw new RequestError("Home Assistant is disconnected.", 503);
  }

  player(id) {
    const player = this.payload().players.find((item) => item.entity_id === id);
    if (!player) throw new RequestError("This player is not part of the dashboard.", 403);
    if (["unknown", "unavailable"].includes(player.state)) throw new RequestError("This player is unavailable.", 409);
    return player;
  }

  async saveClock(body) {
    await this.mutationReady();
    try {
      const clock = parseClockOptions(body);
      if (body.weather_entity !== undefined && clock.weather_entity !== this.weatherEntity) {
        throw new RequestError("Configure weather_entity in the Home Assistant app configuration and restart the app.");
      }
      this.configStore.saveClock({ ...clock, weather_entity: this.configStore.current.clock.weather_entity });
    }
    catch (error) {
      if (error.code) throw error;
      throw new RequestError(error.message);
    }
    await this.refresh();
  }

  async saveAlarm(body) {
    await this.mutationReady();
    const { id } = validateAlarm(body);
    let musicSource;
    let buzzerSource;
    if (Object.hasOwn(body, "music_station_id")) {
      if (body.music_station_id === null) musicSource = "";
      else {
        if (!this.radio || this.radio.error) throw new RequestError(this.radio?.error || "Music Assistant radio library is unavailable.", 409);
        const station = this.radio.stations.find((item) => item.id === body.music_station_id);
        if (!station) throw new RequestError("This station is no longer in the Music Assistant radio library. Reload saved values and choose another.", 409);
        musicSource = station.uri;
      }
    }
    if (body.enabled) {
      this.player(this.mediaPlayer);
      if (alarmSnapshot(this.states).player !== this.mediaPlayer) throw new RequestError("Apply the configured HA app speaker before enabling alarms.", 409);
    }
    if (this.alarmWrites.has(id) || this.alarmWrites.has("playback") || this.alarmWrites.has("create") || this.alarmWrites.has("delete")) throw new RequestError("An alarm is already being edited. Try again when the save finishes.", 409);
    this.alarmWrites.add(id);
    try {
      if (Object.hasOwn(body, "buzzer_sound_id")) {
        const profile = alarmSnapshot(this.states).alarms.find((alarm) => alarm.id === id);
        if (!profile?.can_select_sound) throw new RequestError(profile?.buzzer_source_error || "Update the HA alarm package to scheduler version 7 before selecting a Buzzer sound.", 409);
        buzzerSource = body.buzzer_sound_id === null ? "" : await this.ha.alarmSoundUrl(body.buzzer_sound_id);
      }
      await saveAlarm(this.ha, body, this.states, this.logger, musicSource, buzzerSource);
    } finally {
      this.alarmWrites.delete(id);
      await this.refresh();
    }
  }

  async createAlarm(body) {
    await this.mutationReady();
    if (this.alarmWrites.size) throw new RequestError("An alarm is already being edited. Wait for that save to finish.", 409);
    this.alarmWrites.add("create");
    try { return await provisionAlarm(this.ha, this.states, body, this.logger); }
    finally { this.alarmWrites.delete("create"); await this.refresh(); }
  }

  async deleteAlarm(body) {
    await this.mutationReady();
    validateDeleteAlarm(body);
    if (this.alarmWrites.size) throw new RequestError("An alarm operation is already in progress. Wait for it to finish.", 409);
    this.alarmWrites.add("delete");
    try { return await deleteAlarm(this.ha, this.states, body, this.logger); }
    finally {
      try {
        if (this.loading) await this.loading;
        await this.refresh();
      } finally { this.alarmWrites.delete("delete"); }
    }
  }

  async saveAlarmPlayback(body) {
    await this.mutationReady();
    const settings = validatePlaybackSettings(body, this.payload().players.map((player) => player.entity_id));
    try { await this.writeAlarmPlayback(settings); }
    finally { await this.refresh(); }
  }

  async writeAlarmPlayback(settings) {
    const snapshot = alarmSnapshot(this.states);
    if (snapshot.playback_missing.length || snapshot.alarms.some((alarm) => !alarm.available)) throw new RequestError("Install the complete HA alarm package before saving playback settings.", 409);
    if (this.alarmWrites.size) throw new RequestError("An alarm is already being edited. Try again when the save finishes.", 409);
    this.alarmWrites.add("playback");
    const enabled = snapshot.alarms.filter((alarm) => alarm.enabled);
    try {
      for (const alarm of enabled) await this.ha.callService("input_boolean", "turn_off", { entity_id: alarmEntities(alarm.id).enabled });
      for (const [key, value] of Object.entries(settings)) {
        await this.ha.callService("input_text", "set_value", { entity_id: `input_text.clock_radio_${key}`, value });
      }
      for (const alarm of enabled) await this.ha.callService("input_boolean", "turn_on", { entity_id: alarmEntities(alarm.id).enabled });
    } catch (error) {
      this.logger.warn(`Alarm playback settings failed: ${error.message}`);
      throw new RequestError("Alarm playback settings were not fully saved or restored. Check shared settings and both profiles before enabling alarms.", 502);
    } finally {
      this.alarmWrites.delete("playback");
    }
  }

  async stopAlarm(body) {
    await this.mutationReady();
    if (this.alarmWrites.has("delete")) throw new RequestError("Wait for the alarm deletion to finish.", 409);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "snoozed")) throw new RequestError("Stop alarm takes an empty object or a snoozed alarm context.");
    const snapshot = alarmSnapshot(this.states);
    if (Object.hasOwn(body, "snoozed")) {
      const target = body.snoozed;
      if (!target || typeof target !== "object" || Array.isArray(target)
          || Object.keys(target).some((key) => !["id", "type", "until"].includes(key))
          || !Number.isSafeInteger(target.id) || target.id < 1 || !["Music", "Buzzer"].includes(target.type)
          || typeof target.until !== "string" || !Number.isFinite(Date.parse(target.until))) {
        throw new RequestError("A snoozed alarm ID, type and deadline are required.");
      }
      if (snapshot.active || snapshot.active_id || snapshot.active_player || snapshot.active_error
          || snapshot.snoozed?.id !== target.id || snapshot.snoozed?.type !== target.type
          || snapshot.snoozed?.until !== target.until || Date.parse(target.until) <= Date.now()) {
        throw new RequestError("This snooze has ended or changed. Refresh its current state before stopping it.", 409);
      }
    }
    if (!snapshot.can_stop) throw new RequestError("The alarm stop script is unavailable.", 409);
    await this.ha.callService("script", "turn_on", { entity_id: "script.clock_radio_stop" });
    await this.refresh();
  }

  async snoozeAlarm(body) {
    await this.mutationReady();
    if (this.alarmWrites.has("delete")) throw new RequestError("Wait for the alarm deletion to finish.", 409);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new RequestError("Snooze alarm takes an empty object.");
    const snapshot = alarmSnapshot(this.states);
    if (!snapshot.can_snooze) throw new RequestError(Number(snapshot.scheduler_version) >= 6
      ? "No alarm can be snoozed. Check the HA alarm helpers and that an alarm is ringing."
      : "Update the HA alarm package to scheduler version 6 for reliable Snooze.", 409);
    try {
      await this.ha.callService("script", "clock_radio_snooze", {});
    } catch (error) {
      this.logger.warn(`Alarm snooze failed: ${error.message}`);
      await this.refresh();
      throw new RequestError("The alarm could not be snoozed. Check the HA snooze script and try again.", 502);
    }
    await this.refresh();
  }

  async playRadio(body) {
    await this.mutationReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["entity_id", "station_id"].includes(key))) throw new RequestError("Invalid radio request.");
    this.player(body.entity_id);
    const station = this.radio?.all(this.configStore.current).find((item) => item.id === body.station_id);
    if (!station) throw new RequestError("Unknown radio station.");
    if (station.source === "home_assistant") return this.command({ action: "play_station", ...body });
    await this.ha.callService("music_assistant", "play_media", { entity_id: body.entity_id, media_id: station.uri, media_type: "radio", enqueue: "replace" });
    await this.refresh();
  }

  async playMusic(body) {
    await this.mutationReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["entity_id", "uri", "type", "enqueue", "startItem"].includes(key))) throw new RequestError("Invalid music request.");
    this.player(body.entity_id);
    if (!this.music?.configured) throw new RequestError("Configure Music Assistant browsing first.", 503);
    await this.music.play(body.entity_id, body);
    await this.refresh();
  }

  async playerImage(id) {
    this.player(id);
    const state = this.states.find((state) => state.entity_id === id);
    const radioArtwork = this.radioArtwork(state);
    if (radioArtwork) return this.music.image(radioArtwork.slice("api/music/image/".length));
    const picture = state?.attributes?.entity_picture;
    if (typeof picture !== "string") throw new RequestError("No artwork is available.", 404);
    const url = new URL(picture, `${this.ha.url}/`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new RequestError("Unsupported artwork URL.", 400);
    const headers = {};
    if (picture.startsWith("/")) {
      if (!/^\/api\/(media_player_proxy\/|image\/serve\/)/.test(picture)) throw new RequestError("Unsupported Home Assistant artwork path.");
      if (this.ha.url === "http://supervisor/core") url.pathname = `/core${url.pathname}`;
      headers.Authorization = `Bearer ${this.ha.token}`;
    }
    return fetchImage(this.ha.fetch, url.toString(), headers);
  }
}
