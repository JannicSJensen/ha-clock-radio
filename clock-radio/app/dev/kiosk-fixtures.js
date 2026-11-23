import http from "node:http";

export const DEMO_KIOSK_TOKEN = "clock-radio-fictional-kiosk";
export const DEMO_KIOSK_PASSWORD = "clock-radio-fictional-kiosk-password";

export function createKioskDemo() {
  const alarms = [{ id: "personal-native-alarm", time: "07:00", days: [0, 6], on: false, label: "Personal alarm", tone: "builtin", music: "none", sunrise: false, speak: false, phrase: "" }];
  const calls = [];
  const record = (name, data) => {
    calls.push({ name, data });
    if (calls.length > 2000) calls.shift();
  };
  const mode = { unavailable: false, ignoreSaves: false, ignoreMusic: false, ignoreTone: false, musicUnavailable: false, soundUnavailable: false, speakerUnavailable: false, phase: "idle", ids: [], presentation: null, updateUnsupported: false, updateUnreachable: false, autoUpdate: false, dimmingUnsupported: false, proximitySupported: true, ignoreDimmingSaves: false, rejectDimmingKey: null };
  const settings = {
    "screensaver.enabled": false, "screensaver.mode": "clock", "screensaver.timeout_seconds": 300,
    "screensaver.dim_level": 0.2, "screensaver.screen_off_minutes": 15,
    "screensaver.dismiss_on_proximity": false, "screensaver.postpone_on_proximity": false,
    "screensaver.dismiss_on_proximity_screen_off_only": true, "screensaver.schedule_enabled": false,
    "lockdown.enabled": false, "screen.default_brightness": 0.65, "screensaver.saved_brightness": -1,
    "screen.adaptive_brightness": true, "ha.password": "fictional-secret",
  };
  const updates = { currentVersion: "2030.1.1+1", availableVersion: "2030.1.2", progress: null, installing: false, lastOutcome: null, canRelaunch: true, silent: true };
  const updateTimers = new Set();
  const later = (delay, run) => {
    const timer = setTimeout(() => { updateTimers.delete(timer); run(); }, delay);
    updateTimers.add(timer);
  };
  const sounds = ["Gentle Bells.ogg", "Soft Chime.wav"];
  const speakers = {
    ma: [{ pick: "", name: "This device (Sendspin)", self: true, available: true }, { pick: "ma:bedroom", name: "Bedroom speaker", available: true },
      { pick: "ma:show-01", name: "show-01", available: true }],
    ha: [{ pick: "ha:media_player.kitchen", name: "Kitchen speaker", available: true }],
    sonos: [{ pick: "sonos:living", name: "Living room Sonos", available: true }],
  };
  const radios = [1, 2].map((id) => ({
    id: `library://radio/${id}`, title: id === 1 ? "Morning Radio" : "Evening Radio", kind: "radio",
    playable: true, expandable: false, raw: { uri: `library://radio/${id}`, item_id: String(id), media_type: "radio", provider: "library" },
  }));
  const playlist = { id: "library://playlist/1", title: "Morning playlist", kind: "playlist", playable: true, expandable: true, raw: { uri: "library://playlist/1", item_id: "1", media_type: "playlist", provider: "library" } };
  const folder = { id: "media-source://radios", title: "Kitchen radios", kind: "folder", playable: false, expandable: true, raw: { media_content_id: "media-source://radios", media_content_type: "app" } };
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/api/login" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return reply(400, { error: "Invalid JSON." }); }
      if (mode.unavailable) return reply(503, { error: "Fictional Kiosk offline." });
      if (data?.password !== DEMO_KIOSK_PASSWORD) return reply(401, { error: "Invalid fictional password." });
      record("login", { ttl_days: data.ttl_days });
      return reply(200, { token: DEMO_KIOSK_TOKEN });
    }
    if (req.headers.authorization !== `Bearer ${DEMO_KIOSK_TOKEN}`) return reply(401, { error: "Invalid fictional Kiosk token." });
    if (mode.unavailable) return reply(503, { error: "Fictional Kiosk offline." });
    if (req.url === "/api/settings" && ["GET", "PATCH"].includes(req.method)) {
      if (mode.dimmingUnsupported) return reply(404, { error: "unknown endpoint" });
      if (req.method === "GET") {
        record("getSettings", null);
        return reply(200, { settings: Object.entries(settings).map(([key, value]) => ({ key, value })) });
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let values;
      try { values = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return reply(400, { error: "Invalid JSON." }); }
      if (!values || typeof values !== "object" || Array.isArray(values)) return reply(400, { error: "Invalid settings." });
      record("patchSettings", values);
      const rejected = [];
      for (const [key, value] of Object.entries(values)) {
        if (!Object.hasOwn(settings, key) || typeof value !== typeof settings[key] || mode.rejectDimmingKey === key) rejected.push(key);
        else if (!mode.ignoreDimmingSaves) settings[key] = value;
      }
      return reply(200, { ok: !rejected.length, rejected, errors: {} });
    }
    const match = /^\/api\/commands\/([A-Za-z]+)$/.exec(req.url);
    if (req.method !== "POST" || !match) return reply(404, { error: "Not found." });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { return reply(400, { error: "Invalid JSON." }); }
    const name = match[1];
    record(name, data);
    const ok = (data) => reply(200, { ok: true, ...(data === undefined ? {} : { data }) });
    if (name === "getProximitySupport") return mode.dimmingUnsupported
      ? reply(400, { ok: false, error: "unknown command" }) : ok({ supported: mode.proximitySupported, name: "Fictional proximity sensor" });
    if (name === "alarmsStatus") return ok({
      phase: mode.phase, ids: mode.ids, labels: [], at: null, snoozedUntil: null, next: null, visible: false,
      alarms: alarms.map((alarm) => ({ ...alarm, next: alarm.on ? new Date(Date.now() + 3600000).toISOString() : null })),
      ...(mode.presentation ? { presentation: mode.presentation } : {}),
    });
    if (["getUpdateStatus", "checkUpdateNow", "installUpdate"].includes(name)) {
      if (mode.updateUnsupported) return reply(400, { ok: false, error: "unknown command" });
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length) return reply(400, { ok: false, error: "invalid update parameters" });
      if (name === "getUpdateStatus") return ok(updates);
      if (name === "checkUpdateNow") return ok({ ...updates, reachable: !mode.updateUnreachable });
      if (!updates.availableVersion || updates.progress !== null || updates.installing) return reply(400, { ok: false, error: "update unavailable or busy" });
      const version = updates.availableVersion;
      updates.progress = 0;
      updates.lastOutcome = null;
      if (mode.autoUpdate) {
        later(500, () => { updates.progress = 0.5; });
        later(8000, () => { updates.progress = null; updates.installing = true; });
        later(13000, () => {
          updates.currentVersion = `${version}+2`;
          updates.availableVersion = null;
          updates.installing = false;
          updates.lastOutcome = "silent";
        });
      }
      return ok(true);
    }
    if (name === "listNotificationSounds") {
      if (mode.soundUnavailable) return reply(400, { ok: false, error: "sounds unavailable" });
      return ok({ sounds });
    }
    if (name.startsWith("libraryPicker")) {
      if (mode.musicUnavailable) return reply(400, { ok: false, error: "no_source" });
      const source = ["ma", "ha", "sonos"].includes(data.source) ? data.source : "ma";
      if (name === "libraryPickerSource") return ok({
        sources: ["ma", "ha", "sonos"], source, followed: "ma:bedroom", browse: source === "ha",
        categories: source === "ma" ? [{ key: "radio", kind: "radio" }, { key: "playlists", kind: "playlist" }]
          : source === "sonos" ? [{ key: "favorites", kind: "track" }] : [],
        speakers: speakers[source].map((speaker) => ({ ...speaker, available: !mode.speakerUnavailable && speaker.available })),
      });
      if (name === "libraryPickerList") {
        const entries = data.category === "radio" ? radios : [playlist];
        const offset = data.offset ?? 0;
        return ok({ items: entries.slice(offset, offset + 1), more: offset + 1 < entries.length });
      }
      if (name === "libraryPickerBrowse") return ok({ items: [folder] });
      if (name === "libraryPickerOpen") return ok({ items: [source === "ha"
        ? { id: "media-source://radio/1", title: "Kitchen Radio", kind: "radio", playable: true, expandable: false, raw: { media_content_id: "media-source://radio/1", media_content_type: "music", can_play: true } }
        : { id: "library://track/1", title: "Morning track", kind: "track", playable: true, expandable: false, raw: { uri: "library://track/1", item_id: "1", media_type: "track", provider: "library" } }] });
    }
    if (name === "alarmSave") {
      const alarm = data.alarm;
      if (alarms.some((item) => item.id !== alarm.id && item.time === alarm.time
          && JSON.stringify([...item.days].sort()) === JSON.stringify([...alarm.days].sort()))) return reply(400, { ok: false, error: "duplicate" });
      if (!mode.ignoreSaves) {
        const index = alarms.findIndex((item) => item.id === alarm.id);
        const saved = structuredClone(alarm);
        const previous = alarms[index];
        if (mode.ignoreTone) saved.tone = previous?.tone;
        if (mode.ignoreMusic) {
          if (previous && Object.hasOwn(previous, "music")) saved.music = previous.music;
          else delete saved.music;
        }
        if (saved.music && typeof saved.music === "object") {
          const pick = saved.music;
          saved.music = { source: pick.source, item: pick.item, shuffle: pick.shuffle, speaker: pick.speaker, speakerName: pick.speakerName };
        }
        if (index < 0) alarms.push(saved);
        else alarms[index] = saved;
      }
      return ok(alarm);
    }
    if (name === "alarmDelete") {
      const index = alarms.findIndex((item) => item.id === data.id);
      if (index < 0) return reply(400, { ok: false, error: "no such alarm" });
      alarms.splice(index, 1);
      return ok();
    }
    return reply(400, { ok: false, error: "Unknown fictional Kiosk command." });
  });
  server.on("close", () => { for (const timer of updateTimers) clearTimeout(timer); });
  return { server, alarms, calls, mode, sounds, speakers, radios, updates, settings };
}
