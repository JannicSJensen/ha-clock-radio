import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import crypto from "node:crypto";
import { CLOCK_DEFAULTS, parseClockOptions } from "../web/js/lib/clock-options.js";

const keys = new Set(["title", "locale", "time_zone", "clock_24h", "show_seconds", "players", "default_player", "stations", "clock"]);
const playerId = /^media_player\.[a-z0-9_]+$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function text(value, field, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim() || result.length > 256) {
    throw new Error(`${field} must be a non-empty string of at most 256 characters.`);
  }
  return result.trim();
}

export function parseConfig(raw) {
  if (!object(raw)) throw new Error("dashboard.yaml must contain a mapping.");
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) throw new Error(`Unknown dashboard setting: ${key}.`);
  }
  const title = text(raw.title, "title", "Clock Radio");
  const locale = text(raw.locale, "locale", "en-GB");
  const timeZone = raw.time_zone ?? "";
  if (typeof timeZone !== "string") throw new Error("time_zone must be a string.");
  new Intl.DateTimeFormat(locale, timeZone ? { timeZone } : {});
  for (const key of ["clock_24h", "show_seconds"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  const players = raw.players ?? [];
  if (!Array.isArray(players) || !players.every((id) => typeof id === "string" && playerId.test(id))) {
    throw new Error("players must be a list of media_player entity IDs.");
  }
  if (new Set(players).size !== players.length) throw new Error("players contains duplicates.");
  const defaultPlayer = raw.default_player ?? "";
  if (typeof defaultPlayer !== "string" || (defaultPlayer && !playerId.test(defaultPlayer))) {
    throw new Error("default_player must be a media_player entity ID or an empty string.");
  }
  if (defaultPlayer && players.length && !players.includes(defaultPlayer)) {
    throw new Error("default_player must be in players.");
  }
  if (!Array.isArray(raw.stations ?? [])) throw new Error("stations must be a list.");
  const ids = new Set();
  const stations = (raw.stations ?? []).map((station, index) => {
    const field = `stations[${index}]`;
    if (!object(station)) throw new Error(`${field} must be a mapping.`);
    const allowed = ["id", "name", "media_content_id", "media_content_type", "source"];
    for (const key of Object.keys(station)) {
      if (!allowed.includes(key)) throw new Error(`Unknown ${field} setting: ${key}.`);
    }
    const id = text(station.id, `${field}.id`);
    if (!/^[a-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`${field}.id must be a unique lowercase slug.`);
    ids.add(id);
    const source = station.source ?? "home_assistant";
    if (!["home_assistant", "music_assistant"].includes(source)) throw new Error(`${field}.source is invalid.`);
    const uri = station.media_content_id;
    if (typeof uri !== "string" || uri.length > 4096 || /[\u0000-\u0020]/.test(uri)) {
      throw new Error(`${field}.media_content_id must be a URL or media URI without spaces.`);
    }
    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new Error(`${field}.media_content_id must be an absolute URL or media URI.`);
    }
    const protocols = source === "music_assistant"
      ? ["http:", "https:", "library:", "radiobrowser:"]
      : ["http:", "https:", "media-source:"];
    if (!protocols.includes(url.protocol) || url.username || url.password) {
      throw new Error(`${field}.media_content_id uses an unsupported protocol or embedded credentials.`);
    }
    return {
      id, name: text(station.name, `${field}.name`),
      media_content_id: uri,
      media_content_type: text(station.media_content_type, `${field}.media_content_type`, "music"),
      source,
    };
  });
  const clock = parseClockOptions(raw.clock ?? {}, {
    ...CLOCK_DEFAULTS,
    language: raw.locale === undefined ? "" : locale,
    seconds: raw.show_seconds ?? CLOCK_DEFAULTS.seconds,
    time_format: raw.clock_24h === false ? "12-hour" : "24-hour",
  });
  return { title, locale, time_zone: timeZone, clock_24h: raw.clock_24h ?? true, show_seconds: raw.show_seconds ?? false, clock, players, default_player: defaultPlayer, stations };
}

export class ConfigStore {
  constructor({ dir, example, logger = console }) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "dashboard.yaml");
    if (!fs.existsSync(this.file)) fs.copyFileSync(example, this.file, fs.constants.COPYFILE_EXCL);
    this.logger = logger;
    this.error = null;
    this.load(true);
  }

  load(initial = false) {
    try {
      const source = fs.readFileSync(this.file, "utf8");
      if (source === this.source && !this.error) return;
      const config = parseConfig(YAML.parse(source));
      this.current = config;
      this.source = source;
      this.error = null;
    } catch (error) {
      if (initial) throw error;
      const message = `Configuration not applied: ${error.message}`;
      if (message !== this.error) this.logger.warn(message);
      this.error = message;
    }
  }

  saveClock(raw) {
    const source = fs.readFileSync(this.file, "utf8");
    const document = YAML.parseDocument(source);
    if (document.errors.length) throw new Error(`Fix dashboard.yaml before saving: ${document.errors[0].message}`);
    parseConfig(document.toJS());
    const clock = parseClockOptions(raw);
    document.set("clock", clock);
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, document.toString(), { flag: "wx" });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.load(true);
    return this.current.clock;
  }
}
