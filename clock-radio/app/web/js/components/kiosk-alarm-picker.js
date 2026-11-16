import { h } from "../core/h.js";
import { getJson } from "../core/api.js";

const sourceNames = { ma: "Music Assistant", ha: "Home Assistant", sonos: "Sonos" };
const label = (value) => value.replace(/[_-]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
const row = (name, control) => h("div", { class: "alarm-editor__row" }, h("span", null, name), control);

export function createKioskAlarmPicker({ onChange }) {
  let signature = "";
  let alarm = null;
  let disabled = true;
  let type = "Buzzer";
  let musicDirty = false;
  let toneDirty = false;
  let selected = null;
  let selectedName = "";
  let soundStarted = false;
  let musicStarted = false;
  let musicLoading = false;
  let soundLoading = false;
  let musicGeneration = 0;
  let soundGeneration = 0;
  let musicRequest = null;
  let soundRequest = null;
  let query = {};
  let trail = [];
  let items = [];
  let nextOffset = 0;
  const source = h("select", { "aria-label": "Alarm music source" });
  const speaker = h("select", { "aria-label": "Alarm music speaker" });
  const category = h("select", { "aria-label": "Alarm music category" });
  const summary = h("p", { class: "alarm-editor__hint" });
  const musicStatus = h("p", { class: "alarm-editor__hint", role: "status" });
  const defaults = h("button", { class: "btn", type: "button" }, "Use Kiosk music default");
  const back = h("button", { class: "btn", type: "button", hidden: true }, "Back to music list");
  const list = h("div", { class: "alarm-stations__list", role: "radiogroup", "aria-label": "Native alarm music" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, "More music");
  const retryMusic = h("button", { class: "btn", type: "button" }, "Refresh music choices");
  const music = h("section", { class: "alarm-stations" }, h("h3", null, "Alarm music"), summary, defaults,
    row("Music from", source), row("Plays on", speaker), row("Browse", category), back, musicStatus, list, more, retryMusic);
  const tone = h("select", { "aria-label": "Native buzzer tone" });
  const toneStatus = h("p", { class: "alarm-editor__hint", role: "status" });
  const retryTone = h("button", { class: "btn", type: "button" }, "Refresh tone choices");
  const toneTitle = h("h3");
  const tones = h("section", { class: "alarm-stations" }, toneTitle, row("Sound", tone), toneStatus, retryTone);
  const el = h("div", { class: "kiosk-alarm-picker", hidden: true }, music, tones);

  function updateControls() {
    music.hidden = type !== "Music";
    toneTitle.textContent = type === "Music" ? "Fallback buzzer tone" : "Buzzer tone";
    summary.textContent = `Selected: ${selectedName || "Kiosk Alarm music default"}`;
    for (const control of [source, speaker, category, defaults, back, more, retryMusic, ...list.querySelectorAll("input, button")]) {
      control.disabled = disabled || musicLoading || (control === defaults && selected === null);
    }
    tone.disabled = disabled || soundLoading;
    retryTone.disabled = disabled || soundLoading;
  }

  async function loadSounds() {
    const generation = ++soundGeneration;
    soundRequest?.abort();
    soundRequest = new AbortController();
    soundLoading = true;
    toneStatus.textContent = "Loading native tones...";
    updateControls();
    try {
      const data = await getJson("api/alarm/sounds", { signal: soundRequest.signal });
      if (generation !== soundGeneration) return;
      const value = tone.value;
      const options = [...data.sounds];
      if (value && !options.some(({ id }) => id === value)) options.push({ id: value, name: "Saved tone (not in the current catalog)", missing: true });
      tone.replaceChildren(...options.map(({ id, name, missing }) => h("option", { value: id ?? "", disabled: Boolean(missing) }, name)));
      tone.value = value;
      toneStatus.textContent = "Choose a native tone for this alarm. Save applies it; no sound plays now. Clock Radio's HA-hosted tones are not copied to Kiosk.";
    } catch (error) {
      if (generation !== soundGeneration) return;
      toneStatus.textContent = `Tone choices unavailable: ${error.message} Saved tones are kept unless you choose another.`;
    } finally {
      if (generation === soundGeneration) { soundLoading = false; updateControls(); }
    }
  }

  function renderItems() {
    list.replaceChildren(...items.map((item) => {
      const input = h("input", { type: "radio", name: "native-alarm-music", value: item.id, "aria-label": item.name, disabled: !item.playable });
      input.checked = selected === item.id;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        selected = item.id;
        selectedName = `${item.name} · ${speaker.selectedOptions[0]?.textContent || ""}`;
        musicDirty = true;
        onChange();
        updateControls();
      });
      const entry = h("div", { class: "alarm-stations__option" });
      if (item.playable) entry.append(h("label", null, input, h("span", null, item.name)));
      else entry.append(h("span", null, item.name));
      if (item.expandable) {
        const open = h("button", { class: "btn", type: "button", "aria-label": `Open ${item.name}` }, "Open");
        open.addEventListener("click", () => {
          trail.push({ id: item.id, name: item.name });
          void loadMusic({ ...query, parent: item.id });
        });
        entry.append(open);
      }
      return entry;
    }));
    back.hidden = trail.length === 0;
  }

  async function loadMusic(params = {}, append = false) {
    const generation = ++musicGeneration;
    musicRequest?.abort();
    musicRequest = new AbortController();
    musicLoading = true;
    if (!append) { items = []; more.hidden = true; renderItems(); }
    musicStatus.textContent = "Loading native music choices...";
    updateControls();
    try {
      const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined));
      const data = await getJson(`api/alarm/music?${search}`, { signal: musicRequest.signal });
      if (generation !== musicGeneration) return;
      query = { source: data.source, speaker: data.speaker ?? undefined, category: data.category || undefined, parent: params.parent };
      source.replaceChildren(...data.sources.map((key) => h("option", { value: key }, sourceNames[key])));
      source.value = data.source;
      speaker.replaceChildren(...data.speakers.map((sp) => h("option", { value: sp.id, disabled: !sp.available }, `${sp.name}${sp.available ? "" : " (unavailable)"}`)));
      speaker.value = data.speaker ?? "";
      category.replaceChildren(...data.categories.map((cat) => h("option", { value: cat.key }, label(cat.key))));
      category.value = data.category;
      items = append ? [...items, ...data.items] : data.items;
      nextOffset = data.offset;
      more.hidden = !data.more;
      musicStatus.textContent = `${data.note}${!items.length ? " No music found in this list." : ""}`;
      renderItems();
    } catch (error) {
      if (generation !== musicGeneration) return;
      musicStatus.textContent = `Music choices unavailable: ${error.message} Your saved music is unchanged.`;
    } finally {
      if (generation === musicGeneration) { musicLoading = false; updateControls(); }
    }
  }

  defaults.addEventListener("click", () => {
    selected = null;
    selectedName = "Kiosk Alarm music default";
    musicDirty = true;
    onChange();
    renderItems();
    updateControls();
  });
  tone.addEventListener("change", () => { toneDirty = true; onChange(); });
  for (const control of [source, speaker, category]) control.addEventListener("change", () => {
    trail = [];
    void loadMusic({
      source: source.value,
      ...(control !== source ? { speaker: speaker.value } : {}),
      ...(control === category ? { category: category.value } : {}),
    });
  });
  back.addEventListener("click", () => {
    trail.pop();
    void loadMusic({ ...query, parent: trail.at(-1)?.id });
  });
  more.addEventListener("click", () => { void loadMusic({ ...query, offset: String(nextOffset) }, true); });
  retryMusic.addEventListener("click", () => { trail = []; void loadMusic(source.value ? { source: source.value } : {}); });
  retryTone.addEventListener("click", () => { void loadSounds(); });

  function close() {
    signature = "";
    alarm = null;
    musicGeneration++;
    soundGeneration++;
    musicRequest?.abort();
    soundRequest?.abort();
  }

  return {
    el, close,
    load(value) {
      const next = JSON.stringify([value.id, value.music_station_id, value.music_station_name, value.buzzer_sound_id]);
      if (signature === next) return;
      close();
      signature = next;
      alarm = value;
      musicDirty = toneDirty = soundStarted = musicStarted = musicLoading = soundLoading = false;
      selected = value.music_station_id ?? null;
      selectedName = `${value.music_station_name || "Kiosk Alarm music default"}${value.music_speaker_name ? ` · ${value.music_speaker_name}` : ""}`;
      items = [];
      trail = [];
      query = {};
      more.hidden = true;
      list.replaceChildren();
      source.replaceChildren(h("option", { value: "" }, "Configured Kiosk source"),
        Object.entries(sourceNames).map(([key, name]) => h("option", { value: key }, name)));
      source.value = value.music_source ?? "";
      speaker.replaceChildren();
      category.replaceChildren();
      tone.replaceChildren(h("option", { value: "" }, "Use Kiosk tone default"),
        h("option", { value: "builtin" }, "Kiosk built-in alarm"));
      if (value.buzzer_sound_id && value.buzzer_sound_id !== "builtin") tone.append(h("option", { value: value.buzzer_sound_id }, value.buzzer_sound_name));
      tone.value = value.buzzer_sound_id ?? "";
      toneStatus.textContent = musicStatus.textContent = "Reconnect to load choices. Saved selections are preserved.";
    },
    update(options) {
      disabled = options.disabled;
      type = options.type;
      el.hidden = !options.native;
      if (!el.hidden && alarm && !disabled) {
        if (!soundStarted) { soundStarted = true; void loadSounds(); }
        if (type === "Music" && !musicStarted) {
          musicStarted = true;
          void loadMusic(alarm.music_source ? { source: alarm.music_source, ...(alarm.music_speaker_id ? { speaker: alarm.music_speaker_id } : {}) } : {});
        }
      }
      updateControls();
    },
    values() {
      return {
        ...(type === "Music" && musicDirty ? { music_station_id: selected } : {}),
        ...(toneDirty ? { buzzer_sound_id: tone.value || null } : {}),
      };
    },
  };
}
