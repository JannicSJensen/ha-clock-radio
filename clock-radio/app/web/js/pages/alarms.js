import { h } from "../core/h.js";
import { icon } from "../core/icons.js";
import { createTimePicker, timeParts } from "../components/time-picker.js";
import { ALARM_SOUNDS, soundFile } from "../lib/alarm-sounds.js";
import { createKioskAlarmPicker } from "../components/kiosk-alarm-picker.js";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (value) => String(value).padStart(2, "0");
const validTime = (alarm) => Number.isInteger(alarm.hour) && alarm.hour >= 0 && alarm.hour <= 23
  && Number.isInteger(alarm.minute) && alarm.minute >= 0 && alarm.minute <= 59;
export function canEditAlarm(alarm) {
  return !alarm.deletion_pending && !alarm.native_busy && alarm.available && alarm.setup_complete && validTime(alarm) && ["Music", "Buzzer"].includes(alarm.type)
    && (alarm.backend === "kiosk_satellite" || Number.isInteger(alarm.volume) && alarm.volume >= 0 && alarm.volume <= 100
    && Number.isInteger(alarm.duration) && alarm.duration >= 1 && alarm.duration <= 120);
}

export function alarmSettings(alarm, enabled = alarm.enabled) {
  return {
    id: alarm.id, enabled, type: alarm.type, hour: alarm.hour, minute: alarm.minute,
    ...(alarm.backend === "kiosk_satellite" ? {} : { volume: alarm.volume, duration: alarm.duration }),
    days: Object.fromEntries(DAYS.map((day) => [day, alarm.days[day]])),
  };
}

export function repeatLabel(days, once = false) {
  const selected = DAYS.filter((day) => days[day]);
  if (selected.length === 7) return "Every day";
  if (!selected.length) return once ? "Once" : "No repeat days";
  if (selected.length === 5 && DAYS.slice(0, 5).every((day) => days[day])) return "Weekdays";
  if (selected.length === 2 && days.saturday && days.sunday) return "Weekends";
  return DAYS.flatMap((day, index) => days[day] ? [DAY_NAMES[index]] : []).join(", ");
}

export function alarmLabel(alarm, hour12) {
  const parts = validTime(alarm) ? timeParts(alarm.hour, alarm.minute, hour12) : null;
  const time = parts
    ? `${hour12 ? parts.hour : pad(parts.hour)}:${pad(parts.minute)}${hour12 ? parts.period ? " PM" : " AM" : ""}`
    : "--:--";
  return `${time} · ${alarm.type || "Unavailable"} · ${repeatLabel(alarm.days, alarm.backend === "kiosk_satellite")}`;
}

function hour12For(model) {
  const clock = model.config.clock;
  if (clock.time_format !== "automatic") return clock.time_format === "12-hour";
  return new Intl.DateTimeFormat(clock.language || navigator.language, { hour: "numeric" }).resolvedOptions().hour12;
}

const switchControl = (label, name) => {
  const control = h("input", { type: "checkbox", role: "switch", "aria-label": label, name });
  return { control, el: h("label", { class: "alarm-switch" }, control, h("span", { "aria-hidden": "true" })) };
};

export function createAlarmPage(ctx) {
  const rows = new Map();
  let activeId = null;
  let dirty = false;
  let saving = false;
  let pageBusy = false;
  let deleting = false;
  let deleteId = null;
  let selectedDays = {};
  let selectedStation = null;
  let stationDirty = false;
  let stationSignature = "";
  let soundDirty = false;
  let previewSequence = 0;
  const stationInputs = new Map();
  let picker = null;
  const pageStatus = h("p", { class: "form-status", role: "alert" });
  const list = h("div", { class: "alarm-list" });
  const addInfo = h("p", { class: "settings-hint", hidden: true });
  const add = h("button", { class: "alarm-icon-button alarm-icon-button--accent", type: "button", "aria-label": "Add alarm" }, icon("plus"));
  const stop = h("button", { class: "btn", type: "button" }, "Stop active alarm");
  stop.addEventListener("click", () => ctx.write("api/alarm/stop", {}));
  const title = h("h2", { id: "alarm-editor-title" });
  const cancel = h("button", { class: "alarm-icon-button", type: "button", "aria-label": "Cancel alarm changes" }, icon("close"));
  const save = h("button", { class: "alarm-icon-button alarm-icon-button--accent", type: "submit", "aria-label": "Save alarm" }, icon("check"));
  const timeSlot = h("div");
  const timeZone = h("p", { class: "alarm-editor__hint" });
  const createdInfo = h("p", { class: "alarm-editor__hint", hidden: true });
  const repeat = h("span", { class: "alarm-editor__value" });
  const enabled = switchControl("Enable this alarm", "enabled");
  const type = h("select", { name: "type", "aria-label": "Alarm type" },
    h("option", { value: "Music" }, "Music"), h("option", { value: "Buzzer" }, "Buzzer"));
  const stationHint = h("p", { class: "alarm-editor__hint", role: "status" });
  const stationList = h("div", { class: "alarm-stations__list", role: "radiogroup", "aria-label": "Alarm radio station" });
  const stationPicker = h("section", { class: "alarm-stations", hidden: true },
    h("h3", null, "Radio station"), stationHint, stationList);
  const savedSound = h("option", { value: "saved", disabled: true, hidden: true }, "Saved HA sound");
  const sound = h("select", { name: "buzzer_sound_id", "aria-label": "Buzzer sound" },
    h("option", { value: "" }, "Use shared HA default"),
    ALARM_SOUNDS.map(({ id, name }) => h("option", { value: id }, name)), savedSound);
  const soundHint = h("p", { class: "alarm-editor__hint", role: "status" });
  const preview = h("button", { class: "btn", type: "button" }, "Preview sound");
  const audio = h("audio", { preload: "none" });
  const soundPicker = h("section", { hidden: true },
    h("div", { class: "alarm-editor__row" }, h("span", null, "Sound"), sound), soundHint, preview);
  const volume = h("input", { id: "alarm-volume", name: "volume", type: "range", min: 0, max: 100, step: 1, "aria-label": "Volume" });
  const volumeLabel = h("output", { for: "alarm-volume", class: "alarm-editor__value" });
  const duration = h("input", { name: "duration", type: "number", min: 1, max: 120, step: 1, required: true, "aria-label": "Wake timer (minutes)" });
  const status = h("p", { class: "form-status", role: "status" });
  const hint = h("p", { class: "alarm-editor__hint" });
  const reload = h("button", { class: "btn", type: "button", hidden: true }, "Reload saved values");
  const remove = h("button", { class: "btn alarm-editor__delete", type: "button" }, "Delete alarm");
  const deleteTitle = h("h2", { id: "alarm-delete-title" });
  const deleteMessage = h("p", { id: "alarm-delete-message" });
  const deleteStatus = h("p", { class: "form-status", role: "status" });
  const keep = h("button", { class: "btn", type: "button" }, "Keep alarm");
  const confirm = h("button", { class: "btn btn--danger", type: "button" }, "Delete alarm");
  const deleteDialog = h("dialog", { class: "alarm-editor alarm-delete", role: "dialog", "aria-labelledby": "alarm-delete-title", "aria-describedby": "alarm-delete-message" },
    deleteTitle, deleteMessage, deleteStatus, h("div", { class: "alarm-delete__actions" }, keep, confirm));

  function deletionAllowed(model, id, busy) {
    const alarm = model.alarms.alarms.find((item) => item.id === id);
    if (model.alarms.backend === "kiosk_satellite" && (!alarm || alarm.enabled || alarm.native_busy)) return false;
    return !busy && !saving && !deleting && ctx.canControl() && model.alarms.can_delete
      && (!model.alarms.deleting || model.alarms.deleting === id);
  }
  function openDelete(id) {
    const model = ctx.getModel();
    if (!deletionAllowed(model, id, pageBusy)) {
      ctx.toast("Deletion is unavailable. Check the HA package, connection and pending alarm operations.");
      return;
    }
    const alarm = model.alarms.alarms.find((alarm) => alarm.id === id);
    if (!alarm) {
      ctx.toast("This alarm is no longer configured.");
      return;
    }
    deleteId = id;
    deleteTitle.textContent = "Delete alarm?";
    deleteMessage.textContent = model.alarms.backend === "kiosk_satellite"
      ? `${alarmLabel(alarm, hour12For(model))}. This permanently removes this Clock Radio test alarm from Kiosk Satellite. HA schedules and other native alarms are not changed.`
      : `${alarmLabel(alarm, hour12For(model))}. This cannot be undone. Any ringing playback or snooze for this alarm will be stopped/cancelled. `
        + (id <= 2 ? "The bundled profile will be disabled and hidden; its YAML helpers remain in HA." : "This alarm's helpers will be removed from HA.");
    deleteStatus.textContent = "";
    deleteDialog.setAttribute("aria-modal", "true");
    deleteDialog.showModal();
    update(model, pageBusy);
    keep.focus();
  }
  remove.addEventListener("click", () => openDelete(activeId));
  keep.addEventListener("click", () => deleteDialog.close());
  deleteDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!deleting) deleteDialog.close();
  });
  deleteDialog.addEventListener("cancel", (event) => { if (deleting) event.preventDefault(); });
  deleteDialog.addEventListener("close", () => {
    deleteDialog.removeAttribute("aria-modal");
    deleteId = null;
  });
  confirm.addEventListener("click", async () => {
    if (deleteId === null || confirm.disabled || deleting) return;
    const id = deleteId;
    deleting = true;
    deleteStatus.textContent = "Deleting...";
    pageStatus.textContent = "";
    update(ctx.getModel(), true);
    try {
      if (await ctx.write("api/alarm/delete", { id })) {
        if (activeId === id) closeEditor();
        if (deleteDialog.open) deleteDialog.close();
        ctx.toast("Alarm deleted.");
      } else {
        deleteStatus.textContent = ctx.writeError() || "The alarm was not deleted. Check HA and retry.";
        pageStatus.textContent = deleteStatus.textContent;
      }
    } catch (error) {
      deleteStatus.textContent = error.message;
      pageStatus.textContent = error.message;
    } finally {
      deleting = false;
      update(ctx.getModel(), false);
    }
  });

  function markDirty() {
    if (activeId === null) return;
    dirty = true;
    status.textContent = "Unsaved changes";
    volumeLabel.textContent = `${volume.value}%`;
    repeat.textContent = repeatLabel(selectedDays, ctx.getModel().alarms.backend === "kiosk_satellite");
    for (const [day, button] of dayButtons) button.setAttribute("aria-pressed", String(selectedDays[day]));
  }
  const dayButtons = DAYS.map((day, index) => {
    const button = h("button", { class: "alarm-day", type: "button", "aria-label": day[0].toUpperCase() + day.slice(1), "aria-pressed": "false" }, DAY_NAMES[index][0]);
    button.addEventListener("click", () => { selectedDays[day] = !selectedDays[day]; markDirty(); });
    return [day, button];
  });
  const presets = [["Every day", 7], ["Weekdays", 5]].map(([label, count]) => {
    const button = h("button", { class: "alarm-repeat-preset", type: "button" }, label);
    button.addEventListener("click", () => {
      selectedDays = Object.fromEntries(DAYS.map((day, index) => [day, index < count]));
      markDirty();
    });
    return button;
  });
  const row = (label, control) => h("div", { class: "alarm-editor__row" }, h("span", null, label), control);
  const volumeSettings = h("div", null, row("Volume", volumeLabel), h("div", { class: "alarm-editor__volume" }, volume),
    row("Wake timer", h("label", { class: "alarm-editor__duration" }, duration, h("span", null, "min"))),
    h("p", { class: "alarm-editor__hint" }, "The wake timer stops playback; it is not a snooze timer."));
  const nativeSettings = h("p", { class: "alarm-editor__hint", hidden: true },
    "Kiosk device local time. No repeat days means once. Volume, Snooze length and Silence after are device-wide Kiosk settings. Native scheduling and ringing stay on Kiosk.");
  const nativeMusicSettings = h("p", { class: "alarm-editor__hint", hidden: true },
    "Choose music, its speaker and a fallback tone here. Music still needs the selected HA/MA/Sonos source and network. Direct-URL native alarms are not supported by this Kiosk version. If music cannot play, Kiosk uses the saved native tone.");
  const nativePicker = createKioskAlarmPicker({ onChange: markDirty });
  const fieldset = h("fieldset", { class: "settings-fieldset" },
    timeSlot, timeZone, createdInfo,
    h("section", { class: "alarm-editor__group" },
      row("Repeat", repeat),
      h("div", { class: "alarm-days", role: "group", "aria-label": "Repeat weekdays" }, dayButtons.map(([, button]) => button)),
      h("div", { class: "alarm-repeat-presets" }, presets)),
    h("section", { class: "alarm-editor__group" },
      row("Enabled", enabled.el),
      row("Alarm type", type),
      stationPicker, soundPicker, nativePicker.el, volumeSettings, nativeSettings, nativeMusicSettings),
    hint, reload);
  const form = h("form", { "aria-label": "Alarm editor" },
    h("header", { class: "alarm-editor__header" }, cancel, title, save),
    fieldset, status, remove);
  const dialog = h("dialog", { class: "alarm-editor", role: "dialog", "aria-labelledby": "alarm-editor-title" }, form);

  function loadEditor(alarm) {
    if (alarm.backend === "kiosk_satellite") nativePicker.load(alarm);
    selectedDays = { ...alarm.days };
    picker.setTime(alarm.hour, alarm.minute);
    enabled.control.checked = alarm.enabled;
    type.value = alarm.type;
    selectedStation = alarm.music_station_id ?? (alarm.music_source_set ? "saved" : null);
    stationDirty = false;
    const savedSoundId = alarm.buzzer_sound_id ?? (alarm.buzzer_source_set ? "saved" : "");
    if (sound.value !== savedSoundId && audio.getAttribute("src")) stopPreview();
    sound.value = savedSoundId;
    savedSound.hidden = !alarm.buzzer_source_set || Boolean(alarm.buzzer_sound_id);
    soundDirty = false;
    volume.value = alarm.volume ?? 0;
    duration.value = alarm.duration ?? 1;
    repeat.textContent = repeatLabel(selectedDays, alarm.backend === "kiosk_satellite");
    volumeLabel.textContent = `${alarm.volume}%`;
    for (const [day, button] of dayButtons) button.setAttribute("aria-pressed", String(selectedDays[day]));
  }
  function closeEditor() {
    if (deleteDialog.open) deleteDialog.close();
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener("close", () => {
    nativePicker.close();
    stopPreview();
    dialog.removeAttribute("aria-modal");
    activeId = null;
    dirty = false;
  });
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  cancel.addEventListener("click", closeEditor);
  form.addEventListener("input", markDirty);
  type.addEventListener("change", () => updateEditor(ctx.getModel(), pageBusy));
  reload.addEventListener("click", () => {
    dirty = false;
    nativePicker.close();
    updateEditor(ctx.getModel(), false);
    status.textContent = "Saved values reloaded.";
    reload.hidden = true;
  });
  function updateEditor(model, busy) {
    if (activeId === null) return;
    const alarm = model.alarms.alarms.find((item) => item.id === activeId);
    if (!alarm) { closeEditor(); ctx.toast("This alarm is no longer configured."); return; }
    const available = canEditAlarm(alarm);
    const native = model.alarms.backend === "kiosk_satellite";
    volumeSettings.hidden = native;
    nativeSettings.hidden = !native;
    const disabled = busy || saving || !ctx.canControl() || !available || Boolean(model.alarms.delete_error);
    fieldset.disabled = disabled;
    save.disabled = disabled;
    cancel.disabled = saving;
    remove.disabled = !deletionAllowed(model, activeId, busy);
    picker.setDisabled(disabled);
    if (!dirty && available) loadEditor(alarm);
    nativeMusicSettings.hidden = !native || type.value !== "Music";
    nativePicker.update({ native, disabled, type: type.value });
    updateStations(model, alarm, disabled);
    updateSounds(alarm, disabled);
    hint.textContent = model.alarms.delete_error || (native && alarm.native_busy ? "Stop this alarm on Kiosk before editing or deleting it."
      : !available ? "The HA alarm helpers are missing, unavailable, invalid or incomplete."
      : !ctx.canControl() ? "Read-only or disconnected. Changes cannot be saved." : "");
  }
  function stopPreview() {
    previewSequence++;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    preview.textContent = "Preview sound";
  }
  sound.addEventListener("change", () => {
    stopPreview();
    soundDirty = true;
    markDirty();
    updateEditor(ctx.getModel(), pageBusy);
  });
  preview.addEventListener("click", async () => {
    if (audio.getAttribute("src")) { stopPreview(); return; }
    const selected = ALARM_SOUNDS.find(({ id }) => id === sound.value);
    if (!selected || preview.disabled) return;
    const sequence = ++previewSequence;
    audio.src = soundFile(selected.id);
    preview.textContent = "Stop preview";
    try { await audio.play(); }
    catch (error) {
      if (sequence !== previewSequence) return;
      stopPreview();
      status.textContent = `Sound preview failed: ${error.message}`;
    }
  });
  audio.addEventListener("ended", stopPreview);
  audio.addEventListener("error", () => {
    if (!audio.getAttribute("src")) return;
    stopPreview();
    status.textContent = "Sound preview failed. Check the connection and reload the app.";
  });
  function updateSounds(alarm, disabled) {
    if (alarm.backend === "kiosk_satellite") {
      soundPicker.hidden = true;
      if (audio.getAttribute("src")) stopPreview();
      return;
    }
    soundPicker.hidden = type.value !== "Buzzer";
    sound.disabled = disabled || !alarm.can_select_sound;
    preview.disabled = sound.disabled || !ALARM_SOUNDS.some(({ id }) => id === sound.value);
    if (soundPicker.hidden || disabled) {
      if (audio.getAttribute("src")) stopPreview();
    }
    soundHint.textContent = !ctx.getModel().connected ? "Offline. Reconnect to preview or change this alarm's sound."
      : alarm.buzzer_source_error || (!alarm.can_select_sound
      ? "Update the HA alarm package to scheduler version 7 to choose a sound for each alarm."
      : `${ALARM_SOUNDS.find(({ id }) => id === sound.value)?.description ?? "Keep the shared HA Buzzer sound."} Preview plays on this device only; Save applies the sound to this alarm.`);
  }
  function updateStations(model, alarm, disabled) {
    stationPicker.hidden = model.alarms.backend === "kiosk_satellite" || type.value !== "Music";
    if (stationPicker.hidden) return;
    const stations = model.alarms.radio_stations ?? [];
    const radioError = model.alarms.radio_error;
    const unavailable = !alarm.can_select_radio;
    stationHint.textContent = !model.connected ? "Offline. Reconnect to view or change radio stations." : alarm.music_source_error
      || (unavailable ? "Update the HA alarm package to version 5, including its per-alarm Music Source helpers, to choose a station."
        : radioError || (!stations.length ? "No radio stations in Music Assistant. Add radios to its library; the list refreshes automatically."
          : "Choose a radio for this alarm only. Save applies your selection; no music plays now."));
    const options = [
      { id: null, name: "Use shared HA default", image: null },
      ...stations,
    ];
    if (selectedStation && !stations.some((station) => station.id === selectedStation)) {
      options.push({ id: selectedStation, name: "Saved station (not in the current library)", image: null, saved: true });
    }
    const signature = JSON.stringify(options);
    if (signature !== stationSignature) {
      stationSignature = signature;
      stationInputs.clear();
      stationList.replaceChildren(...options.map((station) => {
        const input = h("input", { type: "radio", name: "alarm-radio", value: station.id ?? "", "aria-label": station.name });
        input.addEventListener("change", () => {
          if (!input.checked) return;
          selectedStation = station.id;
          stationDirty = true;
          markDirty();
        });
        stationInputs.set(station.id, input);
        const art = h("span", { class: "alarm-stations__art", "aria-hidden": "true" }, icon("radio"));
        if (station.image) {
          const image = h("img", { src: station.image, alt: "", loading: "lazy", onerror: () => image.remove() });
          art.append(image);
        }
        return h("label", { class: "alarm-stations__option" }, input, art, h("span", null, station.name));
      }));
    }
    for (const option of options) {
      const input = stationInputs.get(option.id);
      input.checked = option.id === selectedStation;
      input.disabled = disabled || unavailable || Boolean(option.saved) || (option.id !== null && Boolean(radioError));
    }
  }
  function openEditor(id, created = false) {
    const model = ctx.getModel();
    const alarm = model.alarms.alarms.find((item) => item.id === id);
    if (!alarm || !canEditAlarm(alarm)) {
      ctx.toast("Finish setup and check the Home Assistant alarm helpers before editing.");
      return;
    }
    activeId = id;
    dirty = false;
    status.textContent = "";
    reload.hidden = true;
    title.textContent = "Edit alarm";
    const native = model.alarms.backend === "kiosk_satellite";
    timeZone.textContent = native ? "Schedule uses the Kiosk device's local time zone, which may differ from this clock." : `Home Assistant time zone: ${model.clock.timeZone || "not available"}`;
    createdInfo.hidden = !created;
    createdInfo.textContent = created ? `This alarm is already stored in ${native ? "Kiosk Satellite" : "HA"}. Cancel leaves it disabled without applying your edits.` : "";
    picker = createTimePicker({ hour12: hour12For(model), onInput: markDirty });
    timeSlot.replaceChildren(picker.el);
    dialog.setAttribute("aria-modal", "true");
    dialog.showModal();
    loadEditor(alarm);
    updateEditor(model, false);
    if (ctx.canControl()) picker.focus();
    else cancel.focus();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || save.disabled) return;
    const id = activeId;
    try {
      const native = ctx.getModel().alarms.backend === "kiosk_satellite";
      if (!native && enabled.control.checked && !DAYS.some((day) => selectedDays[day])) throw new Error("Select at least one weekday before enabling the alarm.");
      const values = {
        id, enabled: enabled.control.checked, type: type.value, ...picker.getTime(),
        ...(!native ? { volume: Number(volume.value), duration: Number(duration.value) } : {}), days: { ...selectedDays },
      };
      if (native) Object.assign(values, nativePicker.values());
      if (stationDirty && !native) values.music_station_id = selectedStation;
      if (soundDirty && !native) values.buzzer_sound_id = sound.value || null;
      saving = true;
      status.textContent = "Saving...";
      updateEditor(ctx.getModel(), true);
      if (await ctx.write("api/settings/alarm", values)) {
        const record = rows.get(id);
        if (record) record.error = null;
        if (activeId === id) closeEditor();
        ctx.toast("Alarm saved.");
      } else {
        status.textContent = ctx.writeError() || "Alarm settings were not saved.";
        reload.hidden = false;
      }
    } catch (error) {
      status.textContent = error.message;
      reload.hidden = false;
    } finally {
      saving = false;
      update(ctx.getModel(), false);
    }
  });

  function createRow(id) {
    const time = h("span", { class: "alarm-row__time" });
    const period = h("span", { class: "alarm-row__period" });
    const summary = h("span", { class: "alarm-row__summary" });
    const edit = h("button", { class: "alarm-row__edit", type: "button", "aria-label": "Edit alarm" },
      h("span", { class: "alarm-row__clock" }, time, period), summary);
    edit.addEventListener("click", () => openEditor(id));
    const toggle = switchControl("Enable alarm");
    const message = h("p", { class: "alarm-row__status", role: "status" });
    const resume = h("button", { class: "btn", type: "button", hidden: true }, "Finish setup");
    const remove = h("button", { class: "alarm-icon-button alarm-icon-button--danger", type: "button", "aria-label": "Delete alarm", title: "Delete alarm" }, icon("delete"));
    remove.addEventListener("click", () => openDelete(id));
    const record = { edit, toggle: toggle.control, time, period, summary, message, resume, remove, error: null, saving: false };
    record.el = h("article", { class: "alarm-row", "aria-label": "Alarm" },
      h("div", { class: "alarm-row__main" }, edit, toggle.el, remove), message, resume);
    toggle.control.addEventListener("change", async () => {
      const model = ctx.getModel();
      const alarm = model.alarms.alarms.find((item) => item.id === id);
      const desired = toggle.control.checked;
      if (model.alarms.backend !== "kiosk_satellite" && desired && !DAYS.some((day) => alarm.days[day])) {
        record.error = "Select repeat weekdays in the editor before enabling this alarm.";
        update(ctx.getModel(), false);
        return;
      }
      record.saving = true;
      record.error = null;
      try {
        if (!await ctx.write("api/settings/alarm", alarmSettings(alarm, desired))) {
          record.error = ctx.writeError() || "The alarm enabled state was not saved.";
        }
      } catch (error) { record.error = error.message; }
      finally { record.saving = false; update(ctx.getModel(), false); }
    });
    resume.addEventListener("click", async () => {
      if (await ctx.write("api/alarm/create", { id })) openEditor(id);
      else pageStatus.textContent = ctx.writeError() || "Alarm setup was not completed.";
    });
    return record;
  }
  add.addEventListener("click", async () => {
    pageStatus.textContent = "";
    const before = new Set(ctx.getModel().alarms.alarms.map((alarm) => alarm.id));
    if (await ctx.write("api/alarm/create", {})) {
      const created = ctx.getModel().alarms.alarms.find((alarm) => !before.has(alarm.id));
      if (created) openEditor(created.id, true);
      else pageStatus.textContent = "The alarm backend confirmed no new alarm. Refresh and inspect its state.";
    } else pageStatus.textContent = ctx.writeError() || "The alarm could not be created.";
  });
  const el = h("div", { class: "settings alarm-page" },
    h("header", { class: "settings-heading alarm-page__heading" },
      h("h1", null, "Alarm configuration"), add),
    addInfo, pageStatus, list, stop, dialog, deleteDialog);

  function update(model, busy) {
    pageBusy = busy;
    const native = model.alarms.backend === "kiosk_satellite";
    const alarms = model.alarms.alarms;
    const ids = alarms.map((alarm) => alarm.id);
    for (const [id, record] of rows) {
      if (ids.includes(id)) continue;
      record.el.remove();
      rows.delete(id);
      ctx.toast("An alarm is no longer configured.");
    }
    const hour12 = hour12For(model);
    for (const alarm of alarms) {
      if (!rows.has(alarm.id)) {
        const record = createRow(alarm.id);
        rows.set(alarm.id, record);
        list.append(record.el);
      }
      const record = rows.get(alarm.id);
      const available = canEditAlarm(alarm);
      if (validTime(alarm)) {
        const parts = timeParts(alarm.hour, alarm.minute, hour12);
        record.time.textContent = `${hour12 ? parts.hour : pad(parts.hour)}:${pad(parts.minute)}`;
        record.period.textContent = hour12 ? parts.period ? "PM" : "AM" : "";
      } else { record.time.textContent = "--:--"; record.period.textContent = ""; }
      record.summary.textContent = `${alarm.type || "Unavailable"}${alarm.type === "Buzzer" && alarm.buzzer_sound_name ? ` · ${alarm.buzzer_sound_name}` : ""} · ${repeatLabel(alarm.days, native)}`;
      const label = alarmLabel(alarm, hour12);
      record.el.setAttribute("aria-label", `Alarm: ${label}`);
      record.edit.setAttribute("aria-label", `Edit alarm: ${label}`);
      record.toggle.setAttribute("aria-label", `Enable alarm: ${label}`);
      record.remove.setAttribute("aria-label", `Delete alarm: ${label}`);
      record.remove.title = `Delete alarm: ${label}`;
      record.edit.disabled = busy || !available;
      record.toggle.disabled = busy || record.saving || !ctx.canControl() || !available || Boolean(model.alarms.delete_error);
      record.remove.disabled = record.saving || !deletionAllowed(model, alarm.id, busy);
      if (!record.saving) record.toggle.checked = alarm.enabled;
      record.el.classList.toggle("is-enabled", alarm.enabled);
      record.message.textContent = record.error || (alarm.deletion_pending ? "Deletion is unfinished. Retry Delete to remove the remaining helpers safely."
        : record.saving ? "Saving..."
        : !alarm.setup_complete ? "Setup is incomplete. Finish setup before enabling."
        : !alarm.available ? `Missing or unavailable helpers: ${alarm.missing.join(", ")}.`
        : alarm.native_busy ? "Stop this alarm on Kiosk before editing or deleting it."
        : native && alarm.enabled ? "Disable this native alarm before deleting it. Use Kiosk's ringing screen for Stop and Snooze."
        : !canEditAlarm(alarm) ? "Invalid alarm settings. Check the Home Assistant helper values."
        : alarm.timer === "active" ? `Alarm is running${alarm.finishes_at ? ` until ${new Date(alarm.finishes_at).toLocaleTimeString()}` : ""}.`
        : model.alarms.snoozed?.id === alarm.id ? `Snoozed until ${new Date(model.alarms.snoozed.until).toLocaleTimeString()}.` : "");
      record.resume.hidden = native || alarm.deletion_pending || alarm.id <= 2 || (alarm.available && alarm.setup_complete);
      record.resume.disabled = busy || !ctx.canControl() || !model.alarms.can_create || alarm.enabled;
    }
    const incomplete = alarms.some((alarm) => alarm.id > 2 && (!alarm.available || !alarm.setup_complete));
    add.disabled = busy || !ctx.canControl() || !model.alarms.can_create || incomplete;
    addInfo.textContent = native ? model.alarms.error || ""
      : !model.connected ? "Offline. Saved schedules are read-only; reconnect to change alarms."
      : model.alarms.deleting ? "Finish the pending deletion before adding or deleting another alarm."
      : incomplete ? "Finish setting up the incomplete alarm before adding another."
      : model.alarms.can_create ? ""
      : "Update the HA alarm package to the dynamic scheduler to enable Add alarm.";
    if (!native && model.connected && !model.alarms.can_delete) addInfo.textContent += " Delete requires the version 4 HA package and available deletion helpers/scripts.";
    addInfo.hidden = !addInfo.textContent;
    stop.hidden = native || !model.alarms.active_player && !model.alarms.snoozed;
    stop.textContent = model.alarms.snoozed ? "Cancel snoozed alarm" : "Stop active alarm";
    stop.disabled = busy || !ctx.canControl() || !model.alarms.can_stop;
    if (model.alarms.active_error || model.alarms.delete_error) pageStatus.textContent = model.alarms.active_error || model.alarms.delete_error;
    keep.disabled = deleting;
    confirm.disabled = deleteId === null || !deletionAllowed(model, deleteId, busy);
    if (deleteId !== null && !alarms.some((alarm) => alarm.id === deleteId) && !deleting) deleteDialog.close();
    updateEditor(model, busy);
  }
  return { el, update, closeEditor };
}
