import crypto from "node:crypto";
import { MAClient, MAError, toCard, toDetail, toSearchGroups } from "./ma-api.js";
import { fetchImage } from "./images.js";
import { RequestError } from "./errors.js";

export const MUSIC_TABS = ["discover", "radio", "albums", "artists", "podcasts", "playlists", "search"];
export const DEFAULT_TABS = MUSIC_TABS;
/** Tabs that need Music Assistant's own API (radio works through Home Assistant alone). */
const LIBRARY_TABS = new Set(["discover", "albums", "artists", "podcasts", "playlists", "search"]);

const LIBRARY_TYPES = { albums: "album", artists: "artist", podcasts: "podcast", playlists: "playlist" };
const ORDERS = { name: "sort_name", new: "timestamp_added_desc", random: "random" };
const DETAIL_TYPES = new Set(["album", "artist", "podcast", "playlist", "audiobook"]);
const ENQUEUE = new Set(["play", "replace", "next", "replace_next", "add"]);
const PLAY_TYPES = new Set(["album", "artist", "track", "playlist", "podcast", "radio", "audiobook"]);
const URI_RE = /^[a-z0-9_.-]+:\/\/[a-z_]+\/\S{1,400}$/i;
const BLOCKED_SCHEMES = new Set(["http", "https", "file", "ftp", "data", "javascript"]);

const IMAGE_CACHE_ENTRIES = 400;
const IMAGE_CACHE_BYTES = 80 * 1024 * 1024;
const DISCOVER_TTL_MS = 60_000;
const DISCOVER_ROWS = 14;

const hash = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);

const boundedInt = (value, min, max, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) throw new RequestError(`Value must be an integer from ${min} to ${max}.`);
  return Number(value);
};

const badRequest = (message) => new RequestError(message);

export function validPlayUri(uri) {
  if (typeof uri !== "string" || !URI_RE.test(uri)) return false;
  return !BLOCKED_SCHEMES.has(uri.slice(0, uri.indexOf(":")).toLowerCase());
}

/** The tabs a tablet gets, given what is configured. */
export function availableTabs(settings, libraryConfigured) {
  const wanted = settings?.tabs?.length ? settings.tabs : DEFAULT_TABS;
  return wanted.filter((tab) => tab === "radio" || (libraryConfigured && LIBRARY_TABS.has(tab)));
}

/**
 * Browsing of the Music Assistant library (through its own API) and playback of what was found
 * (through Home Assistant's `music_assistant.play_media`).
 */
export class MusicService {
  constructor({ ha, logger, url, token, fetchImpl = globalThis.fetch }) {
    this.ha = ha;
    this.log = logger;
    this.fetch = fetchImpl;
    this.client = new MAClient({ url, token, fetchImpl });
    this._sources = new Map(); // image id -> url to fetch
    this._images = new Map(); // image id -> { type, body }
    this._imageBytes = 0;
    this._discover = null;
    this._playable = new Map();
  }

  get configured() {
    return this.client.configured;
  }

  get options() {
    return {
      baseUrl: this.client.baseUrl,
      registerImage: (source) => this._register(source),
    };
  }

  _register(source) {
    let url;
    try { url = new URL(source); }
    catch { throw new MAError("Music Assistant returned an invalid artwork URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new MAError("Music Assistant returned an unsupported artwork URL.");
    const id = hash(source);
    if (!this._sources.has(id)) {
      this._sources.set(id, source);
      if (this._sources.size > 5000) this._sources.delete(this._sources.keys().next().value);
    }
    return `api/music/image/${id}`;
  }

  cards(list) {
    return (Array.isArray(list) ? list : []).map((item) => this.remember(toCard(item, this.options))).filter(Boolean);
  }

  remember(card) {
    if (card && validPlayUri(card.uri)) {
      this._playable.set(card.uri, card.type);
      if (this._playable.size > 10000) this._playable.delete(this._playable.keys().next().value);
    }
    return card;
  }

  // ---- browsing -------------------------------------------------------------------

  async library({ tab, q, limit, offset, sort, favorite }) {
    if (!Object.hasOwn(LIBRARY_TYPES, tab)) throw badRequest("Unknown library.");
    if (sort !== undefined && !Object.hasOwn(ORDERS, sort)) throw badRequest("Unknown sort order.");
    if (q && String(q).length > 100) throw badRequest("Library filter is too long.");
    const args = {
      limit: boundedInt(limit, 1, 100, 60),
      offset: boundedInt(offset, 0, 100_000, 0),
      order_by: ORDERS[sort] ?? ORDERS.name,
    };
    if (q) args.search = String(q).slice(0, 100);
    if (favorite) args.favorite = true;

    let items;
    try {
      items = await this.client.call(`music/${tab}/library_items`, args);
    } catch (err) {
      if (!(err instanceof MAError) || err.status === 503 || !/order|sort|invalid/i.test(err.message)) throw err;
      this.log.warn(`Music Assistant rejected the sort order; retrying without sorting: ${err.message}`);
      delete args.order_by; // an unknown sort name must not break browsing
      items = await this.client.call(`music/${tab}/library_items`, args);
    }
    if (!Array.isArray(items)) throw new MAError("Music Assistant returned an invalid library list.");
    const cards = this.cards(items);
    return { items: cards, more: Array.isArray(items) && items.length >= args.limit };
  }

  async discover() {
    if (this._discover && Date.now() - this._discover.at < DISCOVER_TTL_MS) return this._discover.value;
    const folders = await this.client.call("music/recommendations");
    if (!Array.isArray(folders)) throw new MAError("Music Assistant returned an invalid recommendations list.");
    const wanted = (Array.isArray(folders) ? folders : []).filter((f) => f?.enabled_by_default !== false).slice(0, DISCOVER_ROWS);
    const rows = await Promise.all(
      wanted.map(async (folder) => {
          const items = Array.isArray(folder.items) && folder.items.length
            ? folder.items
            : await this.client.call("music/recommendations/items", { provider: folder.provider, item_id: folder.item_id });
          if (!Array.isArray(items)) throw new MAError("Music Assistant returned invalid recommendation items.");
          const cards = this.cards(items).slice(0, 30);
          return cards.length ? { id: String(folder.item_id), name: String(folder.name ?? ""), subtitle: folder.subtitle ?? "", items: cards } : null;
      }),
    );
    const value = { rows: rows.filter(Boolean) };
    this._discover = { at: Date.now(), value };
    return value;
  }

  async search(q) {
    if (q !== undefined && (typeof q !== "string" || q.length > 100)) throw badRequest("Search must be text of at most 100 characters.");
    const query = String(q ?? "").trim().slice(0, 100);
    if (query.length < 2) return toSearchGroups({}, this.options);
    const results = await this.client.call("music/search", {
      search_query: query,
      media_types: ["artist", "album", "track", "playlist", "podcast", "radio"],
      limit: 12,
    });
    if (!results || typeof results !== "object" || Array.isArray(results)) throw new MAError("Music Assistant returned invalid search results.");
    const groups = toSearchGroups(results, this.options);
    for (const list of Object.values(groups)) for (const card of list) this.remember(card);
    return groups;
  }

  async detail(type, provider, id) {
    if (!DETAIL_TYPES.has(type)) throw badRequest("Unknown item type.");
    if (typeof provider !== "string" || typeof id !== "string" || !provider || !id || provider.length > 200 || id.length > 400) {
      throw badRequest("provider and id are required.");
    }
    const key = { item_id: id, provider_instance_id_or_domain: provider };
    const kind = `${type}s`;
    const item = await this.client.call(`music/${kind}/get`, { ...key, allow_update_metadata: false });
    const header = this.remember(toDetail(item, this.options));
    if (!header) throw new MAError("Music Assistant returned an item that cannot be shown.");

    const sections = [];
    const add = (name, list, max = 300) => {
      const items = this.cards(list).slice(0, max);
      if (items.length) sections.push({ name, items });
    };
    if (type === "album") add("tracks", await this.client.call("music/albums/album_tracks", { ...key, in_library_only: false }));
    else if (type === "artist") {
      const [albums, tracks] = await Promise.all([
        this.client.call("music/artists/artist_albums", key),
        this.client.call("music/artists/artist_tracks", key),
      ]);
      add("albums", albums);
      add("tracks", tracks, 25);
    } else if (type === "podcast") add("episodes", await this.client.call("music/podcasts/podcast_episodes", key));
    else if (type === "playlist") add("tracks", await this.client.call("music/playlists/playlist_tracks", key));
    return { item: header, sections };
  }

  // ---- images -----------------------------------------------------------------------

  /** A cover as { type, body }, fetched by the add-on and kept in memory. */
  async image(id) {
    const cached = this._images.get(id);
    if (cached) return cached;
    const source = this._sources.get(id);
    if (!source) return null;

    const headers = {};
    // Only requests to Music Assistant itself carry the token; external cover URLs never see it.
    const url = new URL(source);
    const base = this.client.baseUrl ? new URL(this.client.baseUrl) : null;
    if (base && url.origin === base.origin && url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) headers.Authorization = `Bearer ${this.client.token}`;
    const { type, body } = await fetchImage(this.fetch, source, headers);

    this._imageBytes -= this._images.get(id)?.body.length ?? 0;
    this._images.set(id, { type, body });
    this._imageBytes += body.length;
    while (this._images.size > IMAGE_CACHE_ENTRIES || this._imageBytes > IMAGE_CACHE_BYTES) {
      const [oldest, entry] = this._images.entries().next().value;
      this._images.delete(oldest);
      this._imageBytes -= entry.body.length;
    }
    return { type, body };
  }

  // ---- playback ---------------------------------------------------------------------

  /** Play (or queue) an item on a Music Assistant player; `startItem` starts a container at that item. */
  async play(entityId, { uri, type, enqueue = "replace", startItem }) {
    if (!validPlayUri(uri) || this._playable.get(uri) !== type) throw badRequest("Open this item in the library before playing it.");
    if (startItem != null && (!validPlayUri(startItem) || !this._playable.has(startItem))) throw badRequest("Open this starting item in the library before playing it.");
    if (!ENQUEUE.has(enqueue)) throw badRequest("Unknown queue mode.");
    const data = { media_id: uri, enqueue };
    // Episodes have no media type in the action; for everything else it makes the request unambiguous.
    if (PLAY_TYPES.has(type)) data.media_type = type;
    if (startItem) data.start_item = startItem;
    await this.ha.callService("music_assistant", "play_media", { ...data, entity_id: entityId });
  }
}

export { DETAIL_TYPES };
