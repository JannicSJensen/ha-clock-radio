import { h } from "../core/h.js";
import { icon } from "../core/icons.js";
import { createTimePicker, timeParts } from "../components/time-picker.js";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (value) => String(value).padStart(2, "0");
const validTime = (alarm) => Number.isInteger(alarm.hour) && alarm.hour >= 0 && alarm.hour <= 23
  && Number.isInteger(alarm.minute) && alarm.minute >= 0 && alarm.minute <= 59;
export function canEditAlarm(alarm) {
  return !alarm.deletion_pending && alarm.available && alarm.setup_complete && validTime(alarm) && ["Music", "Buzzer"].includes(alarm.type)
    && Number.isInteger(alarm.volume) && alarm.volume >= 0 && alarm.volume <= 100
    && Number.isInteger(alarm.duration) && alarm.duration >= 1 && alarm.duration <= 120;
}

export function alarmSettings(alarm, enabled = alarm.enabled) {
  return {
    id: alarm.id, enabled, type: alarm.type, hour: alarm.hour, minute: alarm.minute,
    volume: alarm.volume, duration: alarm.duration,
    days: Object.fromEntries(DAYS.map((day) => [day, alarm.days[day]])),
  };
}

export function repeatLabel(days) {
  const selected = DAYS.filter((day) => days[day]);
  if (selected.length === 7) return "Every day";
  if (!selected.length) return "No repeat days";
  if (selected.length === 5 && DAYS.slice(0, 5).every((day) => days[day])) return "Weekdays";
  if (selected.length === 2 && days.saturday && days.sunday) return "Weekends";
  return DAYS.flatMap((day, index) => days[day] ? [DAY_NAMES[index]] : []).join(", ");
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
  let picker = null;
  const pageStatus = h("p", { class: "form-status", role: "alert" });
  const list = h("div", { class: "alarm-list" });
  const addInfo = h("p", { class: "settings-hint" });
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
    return !busy && !saving && !deleting && ctx.canControl() && model.alarms.can_delete
      && (!model.alarms.deleting || model.alarms.deleting === id);
  }
  function openDelete(id) {
    const model = ctx.getModel();
    if (!deletionAllowed(model, id, pageBusy)) {
      ctx.toast("Deletion is unavailable. Check the HA package, connection and pending alarm operations.");
      return;
    }
    if (!model.alarms.alarms.some((alarm) => alarm.id === id)) {
      ctx.toast("This alarm is no longer configured.");
      return;
    }
    deleteId = id;
    deleteTitle.textContent = `Delete Alarm ${id}?`;
    deleteMessage.textContent = "This cannot be undone. Any ringing playback or snooze for this alarm will be stopped/cancelled. "
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
        ctx.toast(`Alarm ${id} deleted.`);
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
    repeat.textContent = repeatLabel(selectedDays);
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
  const fieldset = h("fieldset", { class: "settings-fieldset" },
    timeSlot, timeZone, createdInfo,
    h("section", { class: "alarm-editor__group" },
      row("Repeat", repeat),
      h("div", { class: "alarm-days", role: "group", "aria-label": "Repeat weekdays" }, dayButtons.map(([, button]) => button)),
      h("div", { class: "alarm-repeat-presets" }, presets)),
    h("section", { class: "alarm-editor__group" },
      row("Enabled", enabled.el),
      row("Alarm type", type),
      row("Volume", volumeLabel),
      h("div", { class: "alarm-editor__volume" }, volume),
      row("Wake timer", h("label", { class: "alarm-editor__duration" }, duration, h("span", null, "min")))),
    h("p", { class: "alarm-editor__hint" }, "The wake timer stops playback; it is not a snooze timer."),
    hint, reload);
  const form = h("form", { "aria-label": "Alarm editor" },
    h("header", { class: "alarm-editor__header" }, cancel, title, save),
    fieldset, status, remove);
  const dialog = h("dialog", { class: "alarm-editor", role: "dialog", "aria-labelledby": "alarm-editor-title" }, form);

  function loadEditor(alarm) {
    selectedDays = { ...alarm.days };
    picker.setTime(alarm.hour, alarm.minute);
    enabled.control.checked = alarm.enabled;
    type.value = alarm.type;
    volume.value = alarm.volume;
    duration.value = alarm.duration;
    repeat.textContent = repeatLabel(selectedDays);
    volumeLabel.textContent = `${alarm.volume}%`;
    for (const [day, button] of dayButtons) button.setAttribute("aria-pressed", String(selectedDays[day]));
  }
  function closeEditor() {
    if (deleteDialog.open) deleteDialog.close();
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener("close", () => {
    dialog.removeAttribute("aria-modal");
    activeId = null;
    dirty = false;
  });
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  cancel.addEventListener("click", closeEditor);
  form.addEventListener("input", markDirty);
  reload.addEventListener("click", () => {
    dirty = false;
    updateEditor(ctx.getModel(), false);
    status.textContent = "Saved values reloaded.";
    reload.hidden = true;
  });
  function updateEditor(model, busy) {
    if (activeId === null) return;
    const alarm = model.alarms.alarms.find((item) => item.id === activeId);
    if (!alarm) { closeEditor(); ctx.toast("This alarm is no longer configured."); return; }
    const available = canEditAlarm(alarm);
    const disabled = busy || saving || !ctx.canControl() || !available || Boolean(model.alarms.delete_error);
    fieldset.disabled = disabled;
    save.disabled = disabled;
    cancel.disabled = saving;
    remove.disabled = !deletionAllowed(model, activeId, busy);
    picker.setDisabled(disabled);
    if (!dirty && available) loadEditor(alarm);
    hint.textContent = model.alarms.delete_error || (!available ? "The HA alarm helpers are missing, unavailable, invalid or incomplete."
      : !ctx.canControl() ? "Read-only or disconnected. Changes cannot be saved." : "");
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
    title.textContent = `Edit Alarm ${id}`;
    timeZone.textContent = `Home Assistant time zone: ${model.clock.timeZone || "not available"}`;
    createdInfo.hidden = !created;
    createdInfo.textContent = created ? "This alarm is already stored in HA. Cancel leaves it disabled without applying your edits." : "";
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
      if (enabled.control.checked && !DAYS.some((day) => selectedDays[day])) throw new Error("Select at least one weekday before enabling the alarm.");
      const values = {
        id, enabled: enabled.control.checked, type: type.value, ...picker.getTime(),
        volume: Number(volume.value), duration: Number(duration.value), days: { ...selectedDays },
      };
      saving = true;
      status.textContent = "Saving...";
      updateEditor(ctx.getModel(), true);
      if (await ctx.write("api/settings/alarm", values)) {
        const record = rows.get(id);
        if (record) record.error = null;
        if (activeId === id) closeEditor();
        ctx.toast(`Alarm ${id} saved.`);
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
    const edit = h("button", { class: "alarm-row__edit", type: "button", "aria-label": `Edit Alarm ${id}` },
      h("span", { class: "alarm-row__clock" }, time, period), summary);
    edit.addEventListener("click", () => openEditor(id));
    const toggle = switchControl(`Enable Alarm ${id}`);
    const message = h("p", { class: "alarm-row__status", role: "status" });
    const resume = h("button", { class: "btn", type: "button", hidden: true }, "Finish setup");
    const remove = h("button", { class: "alarm-icon-button alarm-icon-button--danger", type: "button", "aria-label": `Delete Alarm ${id}`, title: `Delete Alarm ${id}` }, icon("delete"));
    remove.addEventListener("click", () => openDelete(id));
    const record = { edit, toggle: toggle.control, time, period, summary, message, resume, remove, error: null, saving: false };
    record.el = h("article", { class: "alarm-row", "aria-label": `Alarm ${id}` },
      h("div", { class: "alarm-row__main" }, edit, toggle.el, remove), message, resume);
    toggle.control.addEventListener("change", async () => {
      const model = ctx.getModel();
      const alarm = model.alarms.alarms.find((item) => item.id === id);
      const desired = toggle.control.checked;
      if (desired && !DAYS.some((day) => alarm.days[day])) {
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
      else pageStatus.textContent = "Home Assistant created no new alarm. Refresh and inspect its helpers.";
    } else pageStatus.textContent = ctx.writeError() || "The alarm could not be created.";
  });
  const el = h("div", { class: "settings alarm-page" },
    h("header", { class: "settings-heading alarm-page__heading" },
      h("div", null, h("h1", null, "Alarm configuration"), h("p", null, "Tap an alarm to edit. Swipe down for Music or up for Settings.")), add),
    addInfo, pageStatus, list, stop, dialog, deleteDialog);

  function update(model, busy) {
    pageBusy = busy;
    const alarms = model.alarms.alarms;
    const ids = alarms.map((alarm) => alarm.id);
    for (const [id, record] of rows) {
      if (ids.includes(id)) continue;
      record.el.remove();
      rows.delete(id);
      ctx.toast(`Alarm ${id} is no longer configured.`);
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
      record.summary.textContent = `Alarm ${alarm.id} · ${alarm.type || "Unavailable"} · ${repeatLabel(alarm.days)}`;
      record.edit.disabled = busy || !available;
      record.toggle.disabled = busy || record.saving || !ctx.canControl() || !available || Boolean(model.alarms.delete_error);
      record.remove.disabled = record.saving || !deletionAllowed(model, alarm.id, busy);
      if (!record.saving) record.toggle.checked = alarm.enabled;
      record.el.classList.toggle("is-enabled", alarm.enabled);
      record.message.textContent = record.error || (alarm.deletion_pending ? "Deletion is unfinished. Retry Delete to remove the remaining helpers safely."
        : record.saving ? "Saving..."
        : !alarm.setup_complete ? "Setup is incomplete. Finish setup before enabling."
        : !alarm.available ? `Missing or unavailable helpers: ${alarm.missing.join(", ")}.`
        : !canEditAlarm(alarm) ? "Invalid alarm settings. Check the Home Assistant helper values."
        : alarm.timer === "active" ? `Alarm is running${alarm.finishes_at ? ` until ${new Date(alarm.finishes_at).toLocaleTimeString()}` : ""}.`
        : model.alarms.snoozed?.id === alarm.id ? `Snoozed until ${new Date(model.alarms.snoozed.until).toLocaleTimeString()}.` : "");
      record.resume.hidden = alarm.deletion_pending || alarm.id <= 2 || (alarm.available && alarm.setup_complete);
      record.resume.disabled = busy || !ctx.canControl() || !model.alarms.can_create || alarm.enabled;
    }
    const incomplete = alarms.some((alarm) => alarm.id > 2 && (!alarm.available || !alarm.setup_complete));
    add.disabled = busy || !ctx.canControl() || !model.alarms.can_create || incomplete;
    addInfo.textContent = model.alarms.deleting ? "Finish the pending deletion before adding or deleting another alarm."
      : incomplete ? "Finish setting up the incomplete alarm before adding another."
      : model.alarms.can_create ? "Alarms run in Home Assistant. New alarms start disabled."
      : "Update the HA alarm package to the dynamic scheduler to enable Add alarm.";
    if (!model.alarms.can_delete) addInfo.textContent += " Delete requires the version 4 HA package and available deletion helpers/scripts.";
    stop.hidden = !model.alarms.active_player && !model.alarms.snoozed;
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
