import http from "node:http";

export const DEMO_KIOSK_TOKEN = "clock-radio-fictional-kiosk";

export function createKioskDemo() {
  const alarms = [{ id: "personal-native-alarm", time: "07:00", days: [0, 6], on: false, label: "Personal alarm", tone: "builtin", music: "none", sunrise: false, speak: false, phrase: "" }];
  const calls = [];
  const mode = { unavailable: false, ignoreSaves: false, ignoreMusic: false, ignoreTone: false, musicUnavailable: false, soundUnavailable: false, speakerUnavailable: false, phase: "idle", ids: [] };
  const sounds = ["Gentle Bells.ogg", "Soft Chime.wav"];
  const speakers = {
    ma: [{ pick: "", name: "This device (Sendspin)", self: true, available: true }, { pick: "ma:bedroom", name: "Bedroom speaker", available: true }],
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
    if (req.headers.authorization !== `Bearer ${DEMO_KIOSK_TOKEN}`) return reply(401, { error: "Invalid fictional Kiosk token." });
    if (mode.unavailable) return reply(503, { error: "Fictional Kiosk offline." });
    const match = /^\/api\/commands\/([A-Za-z]+)$/.exec(req.url);
    if (req.method !== "POST" || !match) return reply(404, { error: "Not found." });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { return reply(400, { error: "Invalid JSON." }); }
    const name = match[1];
    calls.push({ name, data });
    if (calls.length > 2000) calls.shift();
    const ok = (data) => reply(200, { ok: true, ...(data === undefined ? {} : { data }) });
    if (name === "alarmsStatus") return ok({
      phase: mode.phase, ids: mode.ids, labels: [], at: null, snoozedUntil: null, next: null, visible: false,
      alarms: alarms.map((alarm) => ({ ...alarm, next: alarm.on ? new Date(Date.now() + 3600000).toISOString() : null })),
    });
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
  return { server, alarms, calls, mode, sounds, speakers, radios };
}
