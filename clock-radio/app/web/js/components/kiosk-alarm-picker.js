import { h } from "../core/h.js";
import { getJson } from "../core/api.js";

const MUSIC_SOURCE = "ma";
const MUSIC_SPEAKER = "show-01";
const label = (value) => value.replace(/[_-]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
const row = (name, control) => h("div", { class: "alarm-editor__row" }, h("span", null, name), control);

function fixedMusicSpeaker(data) {
  if (data?.source !== MUSIC_SOURCE || !Array.isArray(data.speakers)) throw new Error("Kiosk did not confirm Music Assistant. Check its configuration on Kiosk.");
  const matches = data.speakers.filter(({ name }) => name === MUSIC_SPEAKER);
  if (!matches.length) throw new Error(`Music Assistant speaker "${MUSIC_SPEAKER}" was not found. Check its name and refresh the choices.`);
  if (matches.length !== 1) throw new Error(`More than one Music Assistant speaker is named "${MUSIC_SPEAKER}". Give the speakers unique names.`);
  if (matches[0].available !== true) throw new Error(`Music Assistant speaker "${MUSIC_SPEAKER}" is unavailable. Reconnect it and refresh the choices.`);
  if (typeof matches[0].id !== "string" || !matches[0].id) throw new Error("Kiosk returned an invalid music speaker choice.");
  return matches[0].id;
}

export async function kioskAlarmMusicOptions(params = {}, options = {}) {
  const read = (query) => getJson(`api/alarm/music?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined))}`, options);
  const query = { ...params, source: MUSIC_SOURCE };
  let data = await read(query);
  const speaker = fixedMusicSpeaker(data);
  if (data.speaker !== speaker) data = await read({ ...query, speaker });
  if (fixedMusicSpeaker(data) !== speaker || data.speaker !== speaker) throw new Error(`Kiosk did not confirm Music Assistant playback on "${MUSIC_SPEAKER}". Refresh the choices.`);
  return data;
}

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
  const category = h("select", { "aria-label": "Alarm music category" });
  const summary = h("p", { class: "alarm-editor__hint" });
  const musicStatus = h("p", { class: "alarm-editor__hint", role: "status" });
  const back = h("button", { class: "btn", type: "button", hidden: true }, "Back to music list");
  const list = h("div", { class: "alarm-stations__list", role: "radiogroup", "aria-label": "Native alarm music" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, "More music");
  const retryMusic = h("button", { class: "btn", type: "button" }, "Refresh music choices");
  const music = h("section", { class: "alarm-stations" }, h("h3", null, "Alarm music"), summary,
    row("Browse", category), back, musicStatus, list, more, retryMusic);
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
    for (const control of [category, back, more, retryMusic, ...list.querySelectorAll("input, button")]) {
      control.disabled = disabled || musicLoading;
    }
    tone.disabled = disabled || soundLoading;
    retryTone.disabled = disabled || soundLoading;
    toneStatus.hidden = !toneStatus.textContent;
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
      toneStatus.textContent = "";
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
        selectedName = `${item.name} · ${MUSIC_SPEAKER}`;
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
      const data = await kioskAlarmMusicOptions(params, { signal: musicRequest.signal });
      if (generation !== musicGeneration) return;
      query = { source: data.source, speaker: data.speaker ?? undefined, category: data.category || undefined, parent: params.parent };
      category.replaceChildren(...data.categories.map((cat) => h("option", { value: cat.key }, label(cat.key))));
      category.value = data.category;
      items = append ? [...items, ...data.items] : data.items;
      nextOffset = data.offset;
      more.hidden = !data.more;
      musicStatus.textContent = `New selections use Music Assistant on ${MUSIC_SPEAKER}. Save applies the choice; nothing plays now.${!items.length ? " No music found in this list." : ""}`;
      renderItems();
    } catch (error) {
      if (generation !== musicGeneration) return;
      musicStatus.textContent = `Music choices unavailable: ${error.message} Your saved music is unchanged.`;
    } finally {
      if (generation === musicGeneration) { musicLoading = false; updateControls(); }
    }
  }

  tone.addEventListener("change", () => { toneDirty = true; onChange(); });
  category.addEventListener("change", () => {
    trail = [];
    void loadMusic({ speaker: query.speaker, category: category.value });
  });
  back.addEventListener("click", () => {
    trail.pop();
    void loadMusic({ ...query, parent: trail.at(-1)?.id });
  });
  more.addEventListener("click", () => { void loadMusic({ ...query, offset: String(nextOffset) }, true); });
  retryMusic.addEventListener("click", () => { trail = []; void loadMusic(); });
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
          void loadMusic();
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
