import { RequestError } from "./errors.js";
import crypto from "node:crypto";
import { ClockData } from "./clock-data.js";
import { alarmEntities, alarmSnapshot, saveAlarm, validateAlarm, validatePlaybackSettings } from "./alarms.js";
import { availableTabs } from "./music.js";
import { fetchImage } from "./images.js";
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
  constructor({ ha, configStore, music = null, radio = null, readOnly = false, demo = false, version, logger = console }) {
    Object.assign(this, { ha, configStore, music, radio, readOnly, demo, version, logger });
    this.states = [];
    this.connected = false;
    this.connectionError = "Connecting to Home Assistant.";
    this.updatedAt = null;
    this.clockData = new ClockData({ ha, logger });
    this.haTimeZone = "";
    this.timeZoneError = null;
    this.alarmWrites = new Set();
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
    await this.clockData.refresh(this.configStore.current, this.states, this.configStore.current.time_zone || this.haTimeZone);
    if (this.radio) await this.radio.refresh();
  }

  payload() {
    const config = this.configStore.current;
    const states = this.states.filter((state) => /^media_player\.[a-z0-9_]+$/.test(state.entity_id)
      && (!config.players.length || config.players.includes(state.entity_id)));
    const players = states.map((state) => {
      const attributes = state.attributes ?? {};
      const safeAttributes = {};
      for (const key of ["friendly_name", "media_title", "media_artist", "media_album_name", "media_content_type", "media_channel", "media_playlist", "media_duration", "media_position", "media_position_updated_at", "volume_level", "supported_features", "shuffle", "repeat"]) {
        if (["string", "number", "boolean"].includes(typeof attributes[key])) safeAttributes[key] = attributes[key];
      }
      safeAttributes.group_members = Array.isArray(attributes.group_members) ? attributes.group_members.filter((id) => states.some((player) => player.entity_id === id)) : [];
      if (typeof attributes.media_content_id === "string" && /^[a-z0-9_.-]+:\/\/[a-z_]+\/\S{1,400}$/i.test(attributes.media_content_id) && !/^https?:/.test(attributes.media_content_id)) safeAttributes.media_content_id = attributes.media_content_id;
      if (attributes.entity_picture) {
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
    const clock = this.clockData.payload(config, alarms, this.states, this.haTimeZone);
    clock.error = [clock.error, this.timeZoneError].filter(Boolean).join(" ") || null;
    const errors = [clock.error, clock.night_error].filter(Boolean).join(" ");
    if (errors && errors !== this.clockError) this.logger.warn(errors);
    this.clockError = errors;
    const stations = this.radio ? this.radio.payload(config) : config.stations.map(({ id, name }) => ({ id, name }));
    return {
      version: this.version, demo: this.demo, read_only: this.readOnly,
      connected: this.connected, updated_at: this.updatedAt,
      connection_error: this.connectionError, config_error: this.configStore.error,
      missing_players: config.players.filter((id) => !states.some((state) => state.entity_id === id)),
      config: {
        title: config.title, locale: config.locale, time_zone: config.time_zone,
        clock_24h: config.clock_24h, show_seconds: config.show_seconds,
        default_player: config.default_player,
        stations: config.stations.map(({ id, name }) => ({ id, name })),
        clock: config.clock,
      },
      players, alarms, clock,
      clock_entities: this.states.filter((state) => /^(weather|sensor|input_datetime|input_boolean|binary_sensor|switch|sun)\./.test(state.entity_id))
        .map((state) => ({ entity_id: state.entity_id, name: state.attributes?.friendly_name || state.entity_id, device_class: state.attributes?.device_class ?? null })),
      music: {
        title: "Music overview", players: players.map((player) => player.entity_id),
        default_player: config.default_player || (players.some((player) => player.entity_id === alarms.player) ? alarms.player : ""), stations,
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
    try { this.configStore.saveClock(body); }
    catch (error) {
      if (error.code) throw error;
      throw new RequestError(error.message);
    }
    await this.refresh();
  }

  async saveAlarm(body) {
    await this.mutationReady();
    const { id } = validateAlarm(body);
    if (this.alarmWrites.has(id) || this.alarmWrites.has("playback")) throw new RequestError("This alarm is already being edited. Try again when the save finishes.", 409);
    this.alarmWrites.add(id);
    try {
      await saveAlarm(this.ha, body, this.states, this.logger);
    } finally {
      this.alarmWrites.delete(id);
      await this.refresh();
    }
  }

  async saveAlarmPlayback(body) {
    await this.mutationReady();
    const settings = validatePlaybackSettings(body, this.payload().players.map((player) => player.entity_id));
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
      await this.refresh();
    }
  }

  async stopAlarm(body) {
    await this.mutationReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new RequestError("Stop alarm takes an empty object.");
    if (!alarmSnapshot(this.states).can_stop) throw new RequestError("The alarm stop script is unavailable.", 409);
    await this.ha.callService("script", "turn_on", { entity_id: "script.clock_radio_stop" });
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

  async groupPlayers(body) {
    await this.mutationReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["leader", "add", "remove"].includes(key))) throw new RequestError("Invalid group request.");
    const add = body.add ?? [], remove = body.remove ?? [];
    if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length === 0 || add.length + remove.length > 50 || new Set([...add, ...remove]).size !== add.length + remove.length || [...add, ...remove].includes(body.leader)) throw new RequestError("Invalid group members.");
    for (const id of [body.leader, ...add, ...remove]) {
      const player = this.player(id);
      if (!(player.supported_features & 524288)) throw new RequestError("This speaker does not support grouping.", 409);
    }
    if (remove.length) await this.ha.callService("media_player", "unjoin", { entity_id: remove });
    if (add.length) await this.ha.callService("media_player", "join", { entity_id: body.leader, group_members: add });
    await this.refresh();
  }

  async playerImage(id) {
    this.player(id);
    const picture = this.states.find((state) => state.entity_id === id)?.attributes?.entity_picture;
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
