export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const fields = new Set(["action", "entity_id", "station_id", "volume_level"]);
const actions = new Set(["play_station", "media_play", "media_pause", "media_stop", "volume_set"]);

export function validateCommand(body, { config, players, readOnly }) {
  if (readOnly) throw new RequestError("The dashboard is read-only.", 403);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object.");
  if (Object.keys(body).some((key) => !fields.has(key))) throw new RequestError("Unknown command field.");
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
  return { domain: "media_player", service: body.action, data };
}

export class Dashboard {
  constructor({ ha, configStore, readOnly = false, demo = false, version, logger = console }) {
    Object.assign(this, { ha, configStore, readOnly, demo, version, logger });
    this.states = [];
    this.connected = false;
    this.connectionError = "Connecting to Home Assistant.";
    this.updatedAt = null;
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
    }
  }

  payload() {
    const config = this.configStore.current;
    const states = this.states.filter((state) => /^media_player\.[a-z0-9_]+$/.test(state.entity_id)
      && (!config.players.length || config.players.includes(state.entity_id)));
    const players = states.map((state) => {
      const attributes = state.attributes ?? {};
      return {
        entity_id: state.entity_id,
        name: attributes.friendly_name ?? state.entity_id,
        state: state.state,
        title: attributes.media_title ?? "",
        artist: attributes.media_artist ?? "",
        volume_level: typeof attributes.volume_level === "number" ? attributes.volume_level : null,
        supported_features: Number.isSafeInteger(attributes.supported_features) ? attributes.supported_features : 0,
      };
    });
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
      },
      players,
    };
  }

  async command(body) {
    await this.refresh();
    if (!this.connected) throw new RequestError("Home Assistant is disconnected.", 503);
    const command = validateCommand(body, { config: this.configStore.current, players: this.payload().players, readOnly: this.readOnly });
    await this.ha.callService(command.domain, command.service, command.data);
    await this.refresh();
  }
}
