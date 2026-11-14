import http from "node:http";
import { WebSocketServer } from "ws";
import { WEEKDAYS, alarmEntities, alarmSnapshot } from "../src/alarms.js";

export const DEMO_HA_TOKEN = "clock-radio-demo";
export const DEMO_MA_TOKEN = "clock-radio-music-demo";
export const DEMO_ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#123c54"/><stop offset="1" stop-color="#d78757"/></linearGradient></defs><rect width="500" height="500" fill="url(#g)"/><circle cx="250" cy="250" r="180" fill="#111c" stroke="#c7a889" stroke-width="2"/><circle cx="250" cy="250" r="145" fill="none" stroke="#fff3" stroke-width="2"/><circle cx="250" cy="250" r="115" fill="none" stroke="#fff3" stroke-width="2"/><circle cx="250" cy="250" r="70" fill="#2dd4bf"/><circle cx="250" cy="250" r="12" fill="#142c30"/><text x="250" y="450" fill="#fff" font-family="sans-serif" font-size="24" text-anchor="middle">CLOCK RADIO SESSIONS</text></svg>`;

function media(type, id, name, extra = {}) {
  return {
    media_type: type, item_id: String(id), provider: "library",
    uri: `library://${type}/${id}`, name, favorite: true,
    image: { type: "thumb", path: "/covers/demo", provider: "demo", proxy_id: "demo" },
    ...extra,
  };
}
export function demoLibrary() {
  const artists = [media("artist", 1, "The Morning Quartet"), media("artist", 2, "Quiet Company")];
  const albums = [
    media("album", 1, "Blue Morning", { artists: [artists[0]], year: 2026 }),
    media("album", 2, "Slow Hours", { artists: [artists[1]], year: 2025 }),
    media("album", 3, "Sunday Sessions", { artists: [artists[0]], year: 2024 }),
  ];
  const tracks = [
    media("track", 1, "First Light", { duration: 234, artists: [artists[0]], album: albums[0], track_number: 1 }),
    media("track", 2, "A Little More Time", { duration: 198, artists: [artists[0]], album: albums[0], track_number: 2 }),
    media("track", 3, "After The Rain", { duration: 267, artists: [artists[1]], album: albums[1], track_number: 1 }),
  ];
  const podcasts = [media("podcast", 1, "The Slow Start", { publisher: "Clock Radio", total_episodes: 2 })];
  const episodes = [
    media("podcast_episode", 1, "A kinder morning", { duration: 1200, podcast: podcasts[0], resume_position_ms: 180000 }),
    media("podcast_episode", 2, "Finding your rhythm", { duration: 1560, podcast: podcasts[0], fully_played: true }),
  ];
  const playlists = [media("playlist", 1, "Easy Wake-up", { owner: "Clock Radio" })];
  const radio = [media("radio", 1, "Morning Jazz"), media("radio", 2, "Slow Sundays"), media("radio", 3, "Classical Calm"), media("radio", 4, "After Hours")];
  return { artists, albums, tracks, podcasts, episodes, playlists, radio };
}

export function demoStates() {
  const states = ["bedroom", "kitchen"].map((name) => ({
    entity_id: `media_player.${name}`, state: name === "bedroom" ? "playing" : "idle",
    attributes: {
      friendly_name: name === "bedroom" ? "Bedroom" : "Kitchen",
      media_title: name === "bedroom" ? "The quiet side of morning" : "",
      media_artist: name === "bedroom" ? "Morning Jazz · Live radio" : "",
      media_content_type: "music", media_content_id: "library://radio/1",
      entity_picture: `/api/media_player_proxy/media_player.${name}?token=demo-artwork-only`,
      volume_level: 0.3, supported_features: 840247, group_members: [],
      media_duration: 234, media_position: 30, media_position_updated_at: new Date().toISOString(),
      shuffle: false, repeat: "off",
    },
  }));
  states.push(
    { entity_id: "weather.bedroom", state: "partlycloudy", attributes: { friendly_name: "Bedroom weather", temperature: 18, temperature_unit: "°C" } },
    { entity_id: "sensor.bedroom_illuminance", state: "30", attributes: { friendly_name: "Bedroom light", device_class: "illuminance", unit_of_measurement: "lx" } },
    { entity_id: "input_boolean.bedroom_night", state: "off", attributes: { friendly_name: "Bedroom night mode" } },
    { entity_id: "sun.sun", state: "above_horizon", attributes: { friendly_name: "Demo sun" } },
    { entity_id: "sensor.demo_next_alarm", state: new Date(Date.now() + 3600000).toISOString(), attributes: { friendly_name: "Demo next alarm", device_class: "timestamp" } },
  );
  for (const id of [1, 2]) {
    for (const [key, entity_id] of Object.entries(alarmEntities(id))) {
      let state = "off";
      if (key === "type") state = id === 1 ? "Music" : "Buzzer";
      else if (key === "hour") state = "6";
      else if (key === "minute") state = id === 1 ? "0" : "15";
      else if (key === "volume") state = "50";
      else if (key === "duration") state = "5";
      else if (WEEKDAYS.slice(0, 5).includes(key)) state = "on";
      states.push({ entity_id, state, attributes: { friendly_name: `Alarm ${id}: ${key}`, ...(key === "type" ? { options: ["Music", "Buzzer"] } : {}) } });
    }
    states.push({ entity_id: `timer.clock_radio_alarm_${id}`, state: "idle", attributes: {} });
    states.push({ entity_id: `input_boolean.clock_radio_alarm_${id}_deleted`, state: "off", attributes: {} });
  }
  for (const [key, state] of Object.entries({
    player: "media_player.bedroom", music_source: "library://radio/1",
    buzzer_source: "https://example.com/sounds/wakeup.mp3", active_player: "", active_alarm: "", snoozed_alarm: "", deleting_alarm: "",
  })) states.push({ entity_id: `input_text.clock_radio_${key}`, state, attributes: {} });
  states.push({ entity_id: "script.clock_radio_stop", state: "off", attributes: {} });
  states.push({ entity_id: "script.clock_radio_cleanup", state: "off", attributes: {} });
  states.push({ entity_id: "script.clock_radio_prepare_delete", state: "off", attributes: {} });
  states.push({ entity_id: "script.clock_radio_play_alarm", state: "off", attributes: {} });
  states.push({ entity_id: "script.clock_radio_snooze", state: "off", attributes: {} });
  states.push({ entity_id: "script.clock_radio_resume_snooze", state: "off", attributes: {} });
  states.push({ entity_id: "input_datetime.clock_radio_snooze_until", state: "2000-01-01 00:00:00", attributes: { timestamp: 946684800 } });
  states.push({ entity_id: "sensor.clock_radio_alarm_scheduler_version", state: "4", attributes: {} });
  return states;
}

export function createDemoAPI({ states = demoStates(), library = demoLibrary(), party = true, playerArtworkStatus = 200 } = {}) {
  const calls = [];
  const helperRequests = [];
  const helperDeletions = [];
  const nativeHelpers = new Map();
  const artworkRequests = [];
  const entity = (id) => states.find((state) => state.entity_id === id);
  let previous = null;
  function cleanupAlarm() {
    const player = entity(entity("input_text.clock_radio_active_player")?.state);
    if (player) {
      player.state = "idle";
      if (previous) Object.assign(player.attributes, previous);
    }
    previous = null;
    entity("input_text.clock_radio_active_player").state = "";
    entity("input_text.clock_radio_active_alarm").state = "";
    for (const state of states) if (/^timer\.clock_radio_alarm_[1-9]\d*$/.test(state.entity_id)) {
      state.state = "idle";
      delete state.attributes.finishes_at;
    }
  }
  function deletionReady(id) {
    const marker = entity("input_text.clock_radio_deleting_alarm")?.state;
    return (marker === "" || /^[1-9][0-9]*$/.test(marker))
      && (id > 2 || ["on", "off"].includes(entity(`input_boolean.clock_radio_alarm_${id}_deleted`)?.state));
  }
  function startAlarm(id, type = entity(`input_select.clock_radio_alarm_${id}_type`)?.state, now = Date.now()) {
    if (!["Music", "Buzzer"].includes(type) || !entity(`timer.clock_radio_alarm_${id}`)) throw new Error("Invalid demo alarm.");
    if (!deletionReady(id)) throw new Error("Invalid alarm deletion helpers.");
    if (entity("input_text.clock_radio_deleting_alarm")?.state === String(id) || entity(`input_boolean.clock_radio_alarm_${id}_deleted`)?.state === "on") throw new Error("This alarm is deleted or deletion is in progress.");
    cleanupAlarm();
    entity("input_text.clock_radio_snoozed_alarm").state = "";
    const player = entity(entity("input_text.clock_radio_player").state);
    previous = { volume_level: player.attributes.volume_level, repeat: player.attributes.repeat };
    player.state = "playing";
    player.attributes.repeat = type === "Buzzer" ? "one" : "off";
    player.attributes.volume_level = Number(entity(`input_number.clock_radio_alarm_${id}_volume`).state) / 100;
    entity("input_text.clock_radio_active_player").state = player.entity_id;
    entity("input_text.clock_radio_active_alarm").state = JSON.stringify({ id, type, started_at: new Date(now).toISOString() });
    const timer = entity(`timer.clock_radio_alarm_${id}`);
    timer.state = "active";
    timer.attributes.finishes_at = new Date(now + Number(entity(`input_number.clock_radio_alarm_${id}_duration`).state) * 60000).toISOString();
  }
  function advanceAlarms(now = Date.now()) {
    const snoozed = entity("input_text.clock_radio_snoozed_alarm")?.state;
    const until = entity("input_datetime.clock_radio_snooze_until")?.attributes.timestamp;
    if (snoozed && Number.isFinite(until) && until * 1000 <= now) {
      const alarm = JSON.parse(snoozed);
      if (!deletionReady(alarm.id)) throw new Error("Invalid alarm deletion helpers.");
      if (entity("input_text.clock_radio_deleting_alarm")?.state === String(alarm.id) || entity(`input_boolean.clock_radio_alarm_${alarm.id}_deleted`)?.state === "on") {
        entity("input_text.clock_radio_snoozed_alarm").state = "";
        return;
      }
      startAlarm(alarm.id, alarm.type, now);
      return;
    }
    if (states.some((state) => /^timer\.clock_radio_alarm_[1-9]\d*$/.test(state.entity_id)
      && state.state === "active" && Date.parse(state.attributes.finishes_at) <= now)) cleanupAlarm();
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const reply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith("/radio-logo/")) {
      artworkRequests.push(url.pathname);
      if (req.headers.authorization) return reply(400, { error: "Public radio logos must not receive access tokens." });
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      return res.end(DEMO_ART);
    }
    if (url.pathname.startsWith("/ma/imageproxy/")) {
      if (req.headers.authorization !== `Bearer ${DEMO_MA_TOKEN}`) return reply(401, { error: "Invalid demo music token." });
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      return res.end(DEMO_ART);
    }
    if (req.headers.authorization !== `Bearer ${url.pathname.startsWith("/ma/") ? DEMO_MA_TOKEN : DEMO_HA_TOKEN}`) return reply(401, { error: "Invalid demo token." });
    try {
      if (req.method === "GET" && url.pathname === "/api/states") {
        advanceAlarms();
        return reply(200, states);
      }
      if (req.method === "GET" && url.pathname === "/api/config") return reply(200, { time_zone: "Europe/Copenhagen" });
      if (req.method === "GET" && url.pathname.startsWith("/api/media_player_proxy/")) {
        artworkRequests.push(url.pathname);
        if (playerArtworkStatus !== 200) return reply(playerArtworkStatus, { error: "Demo player artwork unavailable." });
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        return res.end(DEMO_ART);
      }
      if (req.method !== "POST") return reply(404, { error: "Not found." });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (url.pathname === "/ma/api") {
        const result = musicCommand(data.command, data.args ?? {});
        return reply(result.status ?? 200, result.body);
      }
      const match = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url.pathname);
      if (!match) return reply(404, { error: "Not found." });
      const [, domain, service] = match;
      calls.push({ domain, service, data });
      if (calls.length > 2000) calls.shift();
      if (domain === "weather" && service === "get_forecasts") {
        return reply(200, { service_response: {
          [data.entity_id]: { forecast: [{ datetime: new Date().toISOString(), temperature: 22, templow: 11 }] },
        } });
      }
      if (domain === "music_assistant" && service === "get_library") return reply(200, { service_response: {
        items: library.radio.map((item) => ({
          media_type: "radio", uri: item.uri, name: item.name, favorite: item.favorite,
          image: item.image ? `http://127.0.0.1:${server.address().port}/radio-logo/${item.item_id}` : null,
        })),
        count: library.radio.length,
      } });
      if (domain === "script" && service === "clock_radio_prepare_delete") {
        const id = data.alarm;
        const snapshot = alarmSnapshot(states);
        if (!Number.isSafeInteger(id) || id < 1 || snapshot.active_error || snapshot.delete_error || snapshot.deleting && snapshot.deleting !== id) return reply(400, { error: "Invalid or conflicting alarm deletion." });
        entity("input_text.clock_radio_deleting_alarm").state = String(id);
        for (const key of ["enabled", "initialized"]) {
          const state = entity(`input_boolean.clock_radio_alarm_${id}_${key}`);
          if (state) state.state = "off";
        }
        if (snapshot.active_id === id) cleanupAlarm();
        if (snapshot.snoozed?.id === id) entity("input_text.clock_radio_snoozed_alarm").state = "";
        const timer = entity(`timer.clock_radio_alarm_${id}`);
        if (timer) { timer.state = "idle"; delete timer.attributes.finishes_at; }
        return reply(200, []);
      }
      if (domain === "script" && service === "turn_on" && data.entity_id === "script.clock_radio_stop") {
        cleanupAlarm();
        entity("input_text.clock_radio_snoozed_alarm").state = "";
        return reply(200, []);
      }
      if (domain === "script" && service === "clock_radio_snooze") {
        const active = entity("input_text.clock_radio_active_alarm").state;
        if (!active) return reply(409, { error: "No ringing alarm." });
        cleanupAlarm();
        entity("input_text.clock_radio_snoozed_alarm").state = active;
        const until = entity("input_datetime.clock_radio_snooze_until");
        until.attributes.timestamp = Math.floor(Date.now() / 1000) + 600;
        until.state = new Date(until.attributes.timestamp * 1000).toISOString();
        return reply(200, []);
      }
      if (domain === "script" && service === "turn_on" && data.entity_id === "script.clock_radio_play_alarm") {
        startAlarm(Number(data.variables?.alarm), data.variables?.alarm_type);
        return reply(200, []);
      }
      const targets = Array.isArray(data.entity_id) ? data.entity_id : [data.entity_id];
      for (const id of targets) {
        const state = states.find((item) => item.entity_id === id);
        if (!state) return reply(404, { error: "Unknown demo entity." });
        if (domain === "input_boolean") state.state = service === "turn_on" ? "on" : "off";
        else if (domain === "input_number" || domain === "input_text") state.state = String(data.value);
        else if (domain === "input_select") state.state = data.option;
        else if (domain === "music_assistant" && service === "play_media") {
          const mediaId = data.start_item ?? data.media_id;
          const item = Object.values(library).flat().find((entry) => entry.uri === mediaId);
          if (data.enqueue !== "add") {
            state.state = "playing";
            Object.assign(state.attributes, {
              media_title: item?.name ?? "A fresh frequency", media_artist: item?.artists?.map((artist) => artist.name).join(", ") ?? "Demo music",
              media_album_name: item?.album?.name ?? "",
              media_content_id: mediaId, media_content_type: item?.media_type ?? "music",
              media_duration: item?.duration ?? 234, media_position: 0, media_position_updated_at: new Date().toISOString(),
            });
          }
        } else if (domain === "media_player") {
          if (service === "play_media") { state.state = "playing"; state.attributes.media_title = "A fresh frequency"; }
          else if (service === "media_play") state.state = "playing";
          else if (service === "media_pause") state.state = "paused";
          else if (service === "media_play_pause") state.state = state.state === "playing" ? "paused" : "playing";
          else if (service === "media_stop") state.state = "idle";
          else if (service === "volume_set") state.attributes.volume_level = data.volume_level;
          else if (service === "media_seek") { state.attributes.media_position = data.seek_position; state.attributes.media_position_updated_at = new Date().toISOString(); }
          else if (service === "shuffle_set") state.attributes.shuffle = data.shuffle;
          else if (service === "repeat_set") state.attributes.repeat = data.repeat;
          else if (service === "join") {
            const members = [...new Set([id, ...state.attributes.group_members, ...data.group_members])];
            for (const player of states) if (members.includes(player.entity_id)) player.attributes.group_members = members;
          } else if (service === "unjoin") {
            for (const player of states) if (Array.isArray(player.attributes.group_members)) player.attributes.group_members = player.entity_id === id ? [] : player.attributes.group_members.filter((member) => member !== id);
          } else if (["media_next_track", "media_previous_track"].includes(service)) state.attributes.media_title = "Another quiet moment";
          else return reply(400, { error: "Unsupported demo service." });
        } else return reply(400, { error: "Unsupported demo domain." });
      }
      return reply(200, []);
    } catch (error) {
      console.error(`Demo request failed: ${error.message}`);
      return reply(400, { error: error.message });
    }
  });
  function musicCommand(command, args) {
    const known = Object.values(library).flat();
    let body;
    if (command === "music/recommendations") body = [
      { item_id: "mornings", provider: "demo", name: "Made for mornings", items: [library.albums[0], library.podcasts[0], library.radio[0]] },
      { item_id: "slow", provider: "demo", name: "Take it slowly", items: [library.albums[1], library.albums[2], library.playlists[0]] },
    ];
    else if (/^music\/(albums|artists|podcasts|playlists)\/library_items$/.test(command)) {
      const type = command.split("/")[1];
      let items = library[type].filter((item) => !args.search || item.name.toLowerCase().includes(args.search.toLowerCase()));
      if (args.order_by === "sort_name") items = [...items].sort((a, b) => a.name.localeCompare(b.name));
      body = items.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 60));
    } else if (command === "music/search") {
      body = Object.fromEntries(["artists", "albums", "tracks", "playlists", "podcasts", "radio"].map((key) => [key, library[key].filter((item) => item.name.toLowerCase().includes(args.search_query.toLowerCase()))]));
    } else if (/^music\/[a-z]+\/get$/.test(command)) body = known.find((item) => item.item_id === args.item_id && `${item.media_type}s` === command.split("/")[1]);
    else if (command === "music/albums/album_tracks") body = library.tracks.filter((item) => item.album.item_id === args.item_id);
    else if (command === "music/artists/artist_albums") body = library.albums;
    else if (command === "music/artists/artist_tracks" || command === "music/playlists/playlist_tracks") body = library.tracks;
    else if (command === "music/podcasts/podcast_episodes") body = library.episodes;
    else if (party && command === "party/url") body = "https://example.com/clock-radio-party";
    else if (party && command === "party/config") body = { party_name: "Clock Radio guests", qr_text: "Add a song to the morning", mode: "venue" };
    else if (party && command === "party/player") body = "demo-bedroom";
    else if (command === "player_queues/get") body = { current_index: 0, state: "playing", elapsed_time: 30 };
    else if (command === "player_queues/items") body = library.tracks.map((item, index) => ({ queue_item_id: String(index), media_item: item, duration: item.duration, extra_attributes: { party_guest: index === 1, party_boosted: index === 2 } }));
    else return { status: 400, body: { error: "Unknown command." } };
    if (body === undefined) return { status: 404, body: { error: "Item not found." } };
    return { body };
  }
  server.keepAliveTimeout = 60000;
  server.headersTimeout = 65000;
  const ws = new WebSocketServer({ server, path: "/api/websocket" });
  ws.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required" }));
    let authenticated = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth") {
        authenticated = message.access_token === DEMO_HA_TOKEN;
        socket.send(JSON.stringify({ type: authenticated ? "auth_ok" : "auth_invalid" }));
      } else if (authenticated && message.type === "config_entries/get") {
        socket.send(JSON.stringify({ type: "result", id: message.id, success: true, result: [{ domain: "music_assistant", entry_id: "demo-music", state: "loaded" }] }));
      } else if (authenticated && message.type === "config/entity_registry/list") {
        socket.send(JSON.stringify({ type: "result", id: message.id, success: true, result: states.map((state) => ({ entity_id: state.entity_id, unique_id: state.entity_id.split(".")[1], platform: state.entity_id.split(".")[0] })) }));
      } else if (authenticated && /^(input_boolean|input_number|input_select|timer)\/list$/.test(message.type)) {
        const domain = message.type.split("/")[0];
        socket.send(JSON.stringify({ type: "result", id: message.id, success: true, result: [...nativeHelpers.values()].filter((item) => item.domain === domain).map((item) => ({ id: item.id, name: item.name })) }));
      } else if (authenticated && /^(input_boolean|input_number|input_select|timer)\/delete$/.test(message.type)) {
        helperDeletions.push(message);
        const domain = message.type.split("/")[0];
        const key = `${domain}.${message[`${domain}_id`]}`;
        if (!nativeHelpers.has(key)) {
          socket.send(JSON.stringify({ type: "result", id: message.id, success: false, error: { message: "Native helper not found." } }));
          return;
        }
        nativeHelpers.delete(key);
        const index = states.findIndex((state) => state.entity_id === key);
        if (index >= 0) states.splice(index, 1);
        socket.send(JSON.stringify({ type: "result", id: message.id, success: true, result: null }));
      } else if (authenticated && /^(input_boolean|input_number|input_select|timer)\/create$/.test(message.type)) {
        helperRequests.push(message);
        const domain = message.type.split("/")[0];
        const objectId = message.name.toLowerCase().replaceAll(" ", "_");
        const entity_id = `${domain}.${objectId}`;
        if (states.some((state) => state.entity_id === entity_id)) {
          socket.send(JSON.stringify({ type: "result", id: message.id, success: false, error: { message: "Entity already exists." } }));
          return;
        }
        const state = domain === "input_boolean" ? "off" : domain === "timer" ? "idle" : domain === "input_select" ? message.options[0] : String(message.min);
        states.push({ entity_id, state, attributes: { friendly_name: message.name, min: message.min, max: message.max, step: message.step, options: message.options } });
        nativeHelpers.set(entity_id, { domain, id: objectId, name: message.name });
        socket.send(JSON.stringify({ type: "result", id: message.id, success: true, result: { id: objectId, name: message.name } }));
      }
    });
  });
  return { server, ws, states, calls, helperRequests, helperDeletions, artworkRequests, library, startAlarm, advanceAlarms };
}
