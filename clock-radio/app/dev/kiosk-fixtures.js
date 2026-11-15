import http from "node:http";

export const DEMO_KIOSK_TOKEN = "clock-radio-fictional-kiosk";

export function createKioskDemo() {
  const alarms = [{ id: "personal-native-alarm", time: "07:00", days: [0, 6], on: false, label: "Personal alarm", tone: "builtin", music: "none", sunrise: false, speak: false, phrase: "" }];
  const calls = [];
  const mode = { unavailable: false, failMusic: false, ignoreSaves: false, phase: "idle", ids: [] };
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
    if (name === "libraryPickerSource") {
      if (mode.failMusic) return reply(400, { ok: false, error: "no_source" });
      return ok({ source: "ma", sources: ["ma"], categories: [{ key: "radios", kind: "radio" }],
        speakers: [{ pick: "", name: "Fictional Echo Show", available: true, self: true }] });
    }
    if (name === "libraryPickerList") return ok({
      more: false, items: ["Morning Jazz", "Slow Sundays"].map((title, i) => ({
        id: `library://radio/${i + 1}`, kind: "radio", title, playable: true, expandable: false,
        raw: { item_id: String(i + 1), uri: `library://radio/${i + 1}`, media_type: "radio", provider: "library", private_data: "fictional-secret" },
      })),
    });
    if (name === "alarmSave") {
      const alarm = data.alarm;
      if (alarms.some((item) => item.id !== alarm.id && item.time === alarm.time
          && JSON.stringify([...item.days].sort()) === JSON.stringify([...alarm.days].sort()))) return reply(400, { ok: false, error: "duplicate" });
      if (!mode.ignoreSaves) {
        const index = alarms.findIndex((item) => item.id === alarm.id);
        const saved = structuredClone(alarm);
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
  return { server, alarms, calls, mode };
}
