import crypto from "node:crypto";
import { imageSource, pickImage } from "./ma-api.js";

export class RadioLibrary {
  constructor({ ha, music, logger, now = Date.now }) {
    Object.assign(this, { ha, music, logger, now });
    this.stations = [];
    this.updatedAt = 0;
    this.error = null;
    this.entry = null;
  }

  async refresh() {
    if (this.now() - this.updatedAt < (this.error ? 60000 : 300000)) return;
    this.updatedAt = this.now();
    try {
      if (!this.entry) {
        const entries = await this.ha.requestWs({ type: "config_entries/get", domain: "music_assistant" });
        this.entry = entries.find((entry) => entry.domain === "music_assistant" && entry.state === "loaded")?.entry_id;
      }
      if (!this.entry) {
        this.stations = [];
        this.error = "Music Assistant is not configured in Home Assistant. Configured radio presets still work.";
        return;
      }
      const response = await this.ha.callServiceWithResponse("music_assistant", "get_library", { config_entry_id: this.entry, media_type: "radio", limit: 500, offset: 0 });
      const list = Array.isArray(response) ? response : response.items;
      if (!Array.isArray(list)) throw new Error("Music Assistant returned no radio item list.");
      this.stations = list.map((item) => {
        if (typeof item.uri !== "string" || typeof item.name !== "string") throw new Error("Music Assistant returned an invalid radio item.");
        const image = pickImage(item);
        const source = typeof image === "string" || image?.remotely_accessible || this.music.configured
          ? imageSource(image, this.music.client.baseUrl) : null;
        return {
          id: `ma-${crypto.createHash("sha256").update(item.uri).digest("hex").slice(0, 16)}`,
          name: item.name, uri: item.uri, source: "music_assistant",
          image: source ? this.music._register(source) : null,
        };
      });
      this.error = null;
    } catch (error) {
      this.error = `Radio library unavailable: ${error.message}`;
      this.logger.warn(this.error);
    }
  }

  all(config) {
    const presets = config.stations.map((station) => ({
      ...station, uri: station.media_content_id, image: null,
    }));
    return [...presets, ...this.stations.filter((station) => !presets.some((preset) => preset.uri === station.uri))];
  }

  payload(config) {
    return this.all(config).map(({ id, name, image, uri }) => ({
      id, name, image,
      uri: /^(library|radiobrowser):\/\//.test(uri) ? uri : null,
    }));
  }
}
