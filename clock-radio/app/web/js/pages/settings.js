import { h } from "../core/h.js";
import { icon } from "../core/icons.js";
import { CLOCK_CHOICES, parseClockOptions } from "../lib/clock-options.js";
import { createAlarmPage } from "./alarms.js";
import { getJson, postJson } from "../core/api.js";

const names = {
  widget: "Clock and widget", full: "Full-screen clock", analog: "Square analog",
  "analog-round": "Round analog", digital: "Digital", calendar: "Calendar",
  weather: "Weather", date: "Date", "date-calendar": "Date and calendar", none: "None",
  "60": "Smooth, 60 fps", "30": "Smooth, 30 fps", tick: "Ticking",
  automatic: "Automatic", "24-hour": "24-hour", "12-hour": "12-hour",
  off: "Off", always: "Always", schedule: "Schedule", sun: "Sun (below horizon)", entity: "Home Assistant entity",
  illuminance: "Room-light sensor (HA illuminance)", monday: "Monday", sunday: "Sunday", saturday: "Saturday",
};
const input = (name, type, props = {}) => h("input", { name, type, ...props });
const select = (name, values, labels = names) => h("select", { name }, values.map((value) => h("option", { value }, labels[value] ?? value)));
const field = (label, control) => {
  const kind = control.tagName === "SELECT" ? "select" : control.type;
  const value = kind === "checkbox"
    ? h("span", { class: "setting-toggle" }, control, h("span", { class: "setting-toggle__track", "aria-hidden": "true" }))
    : kind === "select" ? h("span", { class: "setting-control" }, control, icon("chevron-down")) : control;
  return h("label", { class: `setting-field setting-field--${kind}` }, h("span", { class: "setting-field__label" }, label), value);
};
const groupIcons = { view: "view-dashboard-outline", time: "calendar-clock", colors: "palette", weather: "weather-partly-cloudy", night: "weather-night", music: "music-note", updates: "download", dimming: "weather-night" };
const group = (title, name, fields, hint) => h("section", { class: `setting-group setting-group--${name}` },
  h("h3", null, h("span", { class: "setting-group__icon" }, icon(groupIcons[name])), title),
  h("div", { class: "setting-grid" }, fields), hint);
const sourceValue = () => h("span", { class: "setting-source__value" });
const source = (label, value) => h("div", { class: "setting-source" }, h("span", null, label), value);

function setValues(form, values) {
  for (const [key, value] of Object.entries(values)) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    if (control.type === "checkbox") control.checked = value === true;
    else control.value = value ?? "";
  }
}

export function kioskUpdateMessage(update, offline = false) {
  if (offline) return "Offline. Reconnect to check KS updates or install.";
  if (!update?.configured) return update?.error || "Set the Kiosk Satellite address and Remote API token in the HA app configuration to enable updates with either alarm backend.";
  if (!update.connected) return update.error || "Connecting to the configured KS device.";
  if (update.progress !== null) return `Downloading on KS: ${Math.round(update.progress * 100)}%.`;
  if (update.installing) return "KS is installing the update and may restart.";
  if (update.error) return update.error;
  if (update.request_state === "completed") return `KS now runs ${update.current_version}.`;
  if (update.last_outcome === "failed") return "The native KS update failed. Check its Remote Administration logs before manually retrying.";
  if (update.last_outcome === "cancelled") return "The native KS download was cancelled.";
  if (update.request_state === "unknown") return "The update request is unconfirmed. Check KS before manually retrying; requests are never retried automatically.";
  if (update.request_state === "requested") return update.last_outcome === "confirm"
    ? "Confirm installation on the KS device screen. If you cancel there, check for updates again before manually retrying."
    : "Update requested. Waiting for KS to report the installed version; it may restart.";
  if (update.alarm_phase !== "idle") return "A native KS alarm, sunrise or snooze is active. Installation is blocked until it ends.";
  if (update.available_version) return `KS reports a newer release: ${update.available_version}.`;
  return update.checked_at ? "KS reports it is up to date." : "No update is currently reported by KS. Check for updates to verify.";
}

export function kioskDimmingMessage(dimming, offline = false) {
  if (offline) return "Offline. Reconnect to change native KS dimming. Its saved behavior continues on KS.";
  if (!dimming?.configured) return dimming?.error || "Set the KS address and Remote API token in the HA app configuration to use its proximity sensor with either alarm backend.";
  if (!dimming.connected) return dimming.error || "Connecting to the configured KS device.";
  if (dimming.error) return dimming.error;
  if (dimming.alarm_phase !== "idle") return "A native KS alarm, sunrise or snooze is active. Wait before changing dimming.";
  if (dimming.ready) return "Configured on KS: dim to 10% after 10 minutes of inactivity. Proximity keeps it awake or restores the saved brightness.";
  if (dimming.enabled) return "KS has a different native Dim configuration. Save with dimming enabled to apply 10 minutes, 10% and proximity wake.";
  return "Proximity dimming is off. Other native screensaver modes are left unchanged when this option is off.";
}

export function createSettingsPages(ctx) {
  const forms = [];
  function createForm(title, content, serialize, endpoint, getValues, available = () => true, canControl = ctx.canControl) {
    let dirty = false;
    const status = h("p", { class: "form-status", role: "status" }, "Changes apply when you save.");
    const save = h("button", { type: "submit", class: "btn btn--primary" }, "Save changes");
    const reload = h("button", { type: "button", class: "btn settings-reload", "aria-label": "Reload values", title: "Reload saved values" }, icon("reload"));
    const fieldset = h("fieldset", { class: "settings-fieldset" }, h("div", { class: "settings-sections" }, content),
      h("div", { class: "form-actions" }, status, reload, save));
    const form = h("form", { class: "settings-card settings-clock", "aria-label": title }, h("h2", { class: "sr-only" }, title), fieldset);
    const record = { form, update(model, busy) {
      fieldset.disabled = busy || !canControl() || !available(model);
      if (!dirty) setValues(form, getValues(model));
    } };
    forms.push(record);
    form.addEventListener("input", () => { dirty = true; status.textContent = "Unsaved changes"; });
    reload.addEventListener("click", async () => {
      try {
        if (endpoint === "api/kiosk/dimming/save") {
          await getJson("api/kiosk/dimming");
          await ctx.refresh();
        }
        dirty = false;
        record.update(ctx.getModel(), false);
        status.textContent = "Values reloaded.";
      } catch (error) {
        status.textContent = error.message;
        ctx.toast(error.message);
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        status.textContent = "Saving...";
        const values = serialize(form);
        if (await ctx.write(endpoint, values)) {
          dirty = false;
          record.update(ctx.getModel(), false);
          status.textContent = "Saved.";
        } else status.textContent = "Not saved. See the error message.";
      } catch (error) {
        status.textContent = error.message;
        ctx.toast(error.message);
      }
    });
    return form;
  }

  const weatherEntity = sourceValue();
  const sunEntity = sourceValue();
  const nightOverride = sourceValue();
  const weatherInfo = h("p", { class: "settings-hint" }, "Set weather_entity in the Home Assistant app configuration and restart to change the weather source. Empty disables weather.");
  const clockInfo = h("p", { class: "settings-hint" });
  const nightInfo = h("p", { class: "settings-hint" }, "Sun mode enables night colors below the horizon. Set sun_entity in the HA app configuration and restart to change its source. Night entity, hours and threshold are ignored in Sun mode. Room-light mode uses hysteresis; unavailable sensors retain the last night state. To test colors, set input_select.clock_radio_night_override in HA to Day or Night, then return it to Auto to resume the configured mode.");
  const clock = createForm("Clock appearance",
    [
      group("View", "view", [
        field("Layout", select("layout", CLOCK_CHOICES.layout)),
        field("Widget clock", select("face", CLOCK_CHOICES.face)),
        field("Full-screen clock", select("full_face", CLOCK_CHOICES.full_face)),
        field("Widget", select("widget", CLOCK_CHOICES.widget))]),
      group("Time and calendar", "time", [
        field("Show seconds", input("seconds", "checkbox")),
        field("Second hand", select("second_hand", CLOCK_CHOICES.second_hand)),
        field("Time format", select("time_format", CLOCK_CHOICES.time_format)),
        field("Language", select("language", ["", "en", "fr", "de", "es", "it", "pt", "nl"], {
          "": "Automatic (device)", en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch",
        })),
        field("First weekday", select("week_start", CLOCK_CHOICES.week_start))], clockInfo),
      group("Colors", "colors", [
        field("Primary", input("primary", "color")), field("Accent", input("accent", "color")),
        field("Seconds", input("seconds_color", "color")), field("Background", input("background", "color"))]),
      group("Weather and next alarm", "weather", [
        source("Weather entity", weatherEntity),
        field("Place name (optional)", input("weather_name", "text", { maxlength: 256, placeholder: "Use entity name" })),
        field("Next alarm", select("next_alarm_entity", [""]))], weatherInfo),
      group("Night mode", "night", [
        field("Mode", select("night_mode", CLOCK_CHOICES.night_mode)),
        source("Sun entity", sunEntity),
        source("Manual color test (HA)", nightOverride),
        field("Night entity / illuminance sensor", select("night_entity", [""])),
        field("Start hour", input("night_start", "number", { min: 0, max: 23, required: true })),
        field("End hour", input("night_end", "number", { min: 0, max: 23, required: true })),
        field("Sensor threshold", input("night_threshold", "number", { min: 0, max: 10000, step: "any", required: true })),
        field("Night color", input("night_color", "color")),
        field("Night brightness (%)", input("night_brightness", "number", { min: 20, max: 100, required: true }))], nightInfo),
    ],
    (form) => {
      const values = Object.fromEntries(new FormData(form));
      values.weather_entity = ctx.getModel().config.clock.weather_entity;
      values.seconds = form.elements.namedItem("seconds").checked;
      for (const key of ["night_start", "night_end", "night_threshold", "night_brightness"]) values[key] = Number(values[key]);
      return parseClockOptions(values);
    }, "api/settings/clock", (model) => model.config.clock);
  clock.querySelector('[name="night_entity"] option').textContent = "Choose an entity";
  clock.querySelector('[name="next_alarm_entity"] option').textContent = "Use the Clock Radio alarms";
  const musicInfo = h("p", { class: "settings-hint" });
  const musicState = sourceValue();
  const dimmingState = h("p", { class: "settings-hint", role: "status", "aria-live": "polite" });
  let dimmingTarget = null;
  const dimming = createForm("Proximity screen dimming", [
    group("Proximity screen dimming", "dimming", [
      field("Enable proximity dimming", input("enabled", "checkbox")),
    ], h("div", null, dimmingState, h("p", { class: "settings-hint" },
      "Uses the configured KS device's sensor and hardware brightness, with either alarm backend. Saving enabled sets its native Dim screensaver to 10 minutes and 10%, enables proximity wake/postpone and disables automatic screensaver screen-off. Clock Radio remains visible. KS restores its saved brightness; adaptive brightness still applies. Touch and other native activity can also reset the idle timer. No browser timer or HA connection is required."))),
  ], (form) => {
    return { enabled: form.elements.namedItem("enabled").checked, ...dimmingTarget };
  }, "api/kiosk/dimming/save", (model) => {
    dimmingTarget = { device_id: model.kiosk_dimming?.device_id, revision: model.kiosk_dimming?.revision };
    return { enabled: model.kiosk_dimming?.enabled === true };
  },
  (model) => model.kiosk_dimming?.can_configure === true, ctx.canControlKioskDimming);
  dimming.classList.remove("settings-clock");
  dimming.classList.add("settings-dimming");
  const installedVersion = sourceValue(), availableVersion = sourceValue();
  const updateStatus = h("p", { class: "settings-hint", role: "status", "aria-live": "polite" });
  const updateHint = h("p", { class: "settings-hint" },
    "Updates target the KS device configured in the HA app, not another browser's device. KS uses its own update source and installer. It may restart, need reopening manually or require confirmation on its screen; avoid updating near an alarm.");
  const downloadProgress = h("progress", { class: "kiosk-update-progress", max: "1", value: "0", "aria-label": "KS update download progress", hidden: true });
  const checkUpdate = h("button", { type: "button", class: "btn" }, "Check for updates");
  const installUpdate = h("button", { type: "button", class: "btn btn--primary", disabled: true }, "Install KS update");
  const updateTitle = h("h2", { id: "kiosk-update-title" }, "Update Kiosk Satellite?");
  const updateConfirmation = h("p", { id: "kiosk-update-message" });
  const updateDialogStatus = h("p", { class: "form-status", role: "status" });
  const cancelUpdate = h("button", { type: "button", class: "btn" }, "Cancel");
  const confirmUpdate = h("button", { type: "button", class: "btn btn--primary" }, "Install on KS");
  const updateDialog = h("dialog", { class: "alarm-editor alarm-delete", role: "dialog", "aria-labelledby": "kiosk-update-title", "aria-describedby": "kiosk-update-message" },
    updateTitle, updateConfirmation, updateDialogStatus, h("div", { class: "alarm-delete__actions" }, cancelUpdate, confirmUpdate));
  let checkingUpdate = false, requestingUpdate = false, updateError = "", updateErrorVersion = null, updateBusy = false, chosenUpdate = null;

  function updateKiosk(model, busy) {
    updateBusy = busy;
    const update = model.kiosk_update;
    const offline = model.offline_snapshot === true;
    if (update?.connected && (update.progress !== null || update.installing
        || update.request_state === "completed" && update.current_version !== updateErrorVersion)) updateError = "";
    const canInstall = Boolean(update?.can_install && !offline && !model.read_only && !busy && !checkingUpdate && !requestingUpdate);
    installedVersion.textContent = offline ? "Unavailable offline" : update?.current_version || "Not available";
    availableVersion.textContent = offline ? "Unavailable offline" : update?.available_version || "Not reported";
    checkUpdate.disabled = offline || busy || checkingUpdate || requestingUpdate || !update?.can_check;
    checkUpdate.textContent = checkingUpdate ? "Checking..." : "Check for updates";
    installUpdate.disabled = !canInstall;
    downloadProgress.hidden = offline || update?.progress == null;
    downloadProgress.value = update?.progress ?? 0;
    updateStatus.textContent = checkingUpdate ? "Checking KS's configured update source..." : updateError || kioskUpdateMessage(update, offline);
    if (updateDialog.open) {
      confirmUpdate.disabled = !canInstall;
      cancelUpdate.disabled = requestingUpdate;
      if (!requestingUpdate && (offline || model.read_only || !update?.connected
          || update.device_id !== chosenUpdate?.device_id || update.available_version !== chosenUpdate?.version)) {
        updateError = "The KS update offer or connection changed. Check again before installing.";
        updateErrorVersion = update?.current_version ?? null;
        updateDialog.close();
        updateStatus.textContent = updateError;
      } else updateDialogStatus.textContent = canInstall ? "" : requestingUpdate ? "Sending the update request to KS..." : kioskUpdateMessage(update, offline);
    }
  }
  updateDialog.addEventListener("close", () => { chosenUpdate = null; updateDialog.removeAttribute("aria-modal"); });
  updateDialog.addEventListener("cancel", (event) => { if (requestingUpdate) event.preventDefault(); });
  cancelUpdate.addEventListener("click", () => updateDialog.close());
  checkUpdate.addEventListener("click", async () => {
    if (checkUpdate.disabled) return;
    checkingUpdate = true;
    updateError = "";
    updateKiosk(ctx.getModel(), updateBusy);
    try { await postJson("api/kiosk/update/check", {}); }
    catch (error) {
      updateError = error.message;
      updateErrorVersion = ctx.getModel().kiosk_update?.current_version ?? null;
      console.warn(error.message);
    }
    finally {
      await ctx.refresh();
      checkingUpdate = false;
      updateKiosk(ctx.getModel(), updateBusy);
    }
  });
  installUpdate.addEventListener("click", () => {
    if (installUpdate.disabled) return;
    const update = ctx.getModel().kiosk_update;
    chosenUpdate = { version: update.available_version, device_id: update.device_id, confirmed: true };
    updateError = "";
    updateConfirmation.textContent = `Install the latest release on the configured KS device (currently ${chosenUpdate.version}, running ${update.current_version})? KS chooses and downloads the update package using its configured update source. It may restart, interrupt playback, need reopening manually or require Android confirmation on its screen. A newer release published during download may be selected by KS.`;
    updateDialog.setAttribute("aria-modal", "true");
    updateDialog.showModal();
    updateKiosk(ctx.getModel(), updateBusy);
    cancelUpdate.focus();
  });
  confirmUpdate.addEventListener("click", async () => {
    if (confirmUpdate.disabled || !chosenUpdate || requestingUpdate) return;
    const request = chosenUpdate;
    updateErrorVersion = ctx.getModel().kiosk_update.current_version;
    requestingUpdate = true;
    updateKiosk(ctx.getModel(), updateBusy);
    try {
      if (!await ctx.write("api/kiosk/update/install", request)) updateError = ctx.writeError() || "The KS update request was not confirmed. Check KS before manually retrying.";
    } catch (error) { updateError = error.message; console.warn(error.message); }
    finally {
      requestingUpdate = false;
      updateDialog.close();
      updateKiosk(ctx.getModel(), updateBusy);
    }
  });
  const alarms = createAlarmPage({ ...ctx, canControl: ctx.canControlAlarms ?? ctx.canControl });
  const el = h("div", { class: "settings settings--ios" },
    h("nav", { class: "settings-navigation", "aria-label": "Settings navigation" },
      h("a", { href: "#alarms" }, icon("chevron-left"), "Alarms"),
      h("a", { href: "#clock" }, icon("clock-outline"), "The Clock")),
    h("header", { class: "settings-heading" },
      h("p", { class: "settings-kicker" }, "Clock Radio"),
      h("h1", null, "Settings"), h("p", null, "Your clock, colors and night-time routine.")),
    clock,
    dimming,
    group("Music Assistant", "music", [source("Library browsing", musicState)], musicInfo),
    group("Kiosk Satellite updates", "updates", [
      source("Installed KS version", installedVersion), source("Available KS version", availableVersion),
    ], h("div", null, downloadProgress, h("div", { class: "kiosk-update-actions" }, checkUpdate, installUpdate), updateStatus, updateHint)),
    updateDialog,
    h("p", { class: "settings-hint settings-navigation-hint" }, "Swipe left/right between pages, or use Left/Right arrows or Page Up/Down. On the Clock, Tab/click a panel and use Up/Down arrows. Alarm configuration has its own page."),
  );

  function optionsFor(control, list, first, keep = "") {
    const signature = JSON.stringify([list, keep]);
    if (control.dataset.options === signature) return;
    const selected = control.value;
    const options = [new Option(first, ""), ...list.map((item) => new Option(item.name, item.entity_id))];
    if (keep && !list.some((item) => item.entity_id === keep)) options.push(new Option(`${keep} (missing)`, keep));
    control.replaceChildren(...options);
    control.value = selected;
    control.dataset.options = signature;
  }
  return { el, alarmsEl: alarms.el, closeAlarmEditor: alarms.closeEditor, update(model, busy) {
    dimmingState.textContent = kioskDimmingMessage(model.kiosk_dimming, model.offline_snapshot === true);
    alarms.update(model, busy);
    updateKiosk(model, busy);
    const entities = model.clock_entities;
    weatherEntity.textContent = model.config.clock.weather_entity || "Not configured";
    sunEntity.textContent = model.config.sun_entity;
    const override = model.night_override;
    nightOverride.textContent = override.available ? override.value : override.error ? `${override.value} (unavailable)` : "Not installed (Auto)";
    musicState.textContent = !model.connected ? "Unavailable offline" : model.music.library ? "Configured" : "Not configured";
    optionsFor(clock.elements.namedItem("night_entity"), entities.filter((item) => !item.entity_id.startsWith("weather.")), "Choose an entity", model.config.clock.night_entity);
    optionsFor(clock.elements.namedItem("next_alarm_entity"), entities.filter((item) => /^(sensor|input_datetime)\./.test(item.entity_id)), "Use the Clock Radio alarms", model.config.clock.next_alarm_entity);
    const language = clock.elements.namedItem("language");
    if (model.config.clock.language && ![...language.options].some((option) => option.value === model.config.clock.language)) language.add(new Option(model.config.clock.language, model.config.clock.language));
    for (const form of forms) form.update(model, busy);
    clockInfo.textContent = `Clock time zone: ${model.clock.timeZone || "this device"}. Alarm schedules use ${model.alarms.backend === "kiosk_satellite" ? "the Kiosk device's local time zone" : "Home Assistant's time zone"}.`;
    musicInfo.textContent = !model.connected ? "Reconnect to view Music Assistant configuration and library browsing."
      : model.music.library ? "Music Assistant browsing is configured. The read-only access token stays on the server." : "For Discover, Albums, Artists, Podcasts, Playlists and Search, set music_assistant_token in the HA app options (Music Assistant → Settings → Profile). Set music_assistant_url if it is not discovered automatically. Restart the app after changing these options. Radio presets work without library access.";
  } };
}
