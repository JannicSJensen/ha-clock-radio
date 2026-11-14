import { h } from "../core/h.js";
import { CLOCK_CHOICES, parseClockOptions } from "../lib/clock-options.js";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const pad = (value) => String(value).padStart(2, "0");
const names = {
  widget: "Clock and widget", full: "Full-screen clock", analog: "Square analog",
  "analog-round": "Round analog", digital: "Digital", calendar: "Calendar",
  weather: "Weather", date: "Date", "date-calendar": "Date and calendar", none: "None",
  "60": "Smooth, 60 fps", "30": "Smooth, 30 fps", tick: "Ticking",
  automatic: "Automatic", "24-hour": "24-hour", "12-hour": "12-hour",
  off: "Off", always: "Always", schedule: "Schedule", entity: "Home Assistant entity",
  illuminance: "Room-light sensor (HA illuminance)", monday: "Monday", sunday: "Sunday", saturday: "Saturday",
};
const input = (name, type, props = {}) => h("input", { name, type, ...props });
const select = (name, values, labels = names) => h("select", { name }, values.map((value) => h("option", { value }, labels[value] ?? value)));
const field = (label, control) => h("label", { class: `setting-field${control.type === "checkbox" ? " setting-field--check" : ""}` }, h("span", null, label), control);
const group = (title, ...fields) => h("section", { class: "setting-group" }, h("h3", null, title), h("div", { class: "setting-grid" }, fields));

function setValues(form, values) {
  for (const [key, value] of Object.entries(values)) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    if (control.type === "checkbox") control.checked = value === true;
    else control.value = value ?? "";
  }
}

export function createSettingsPage(ctx) {
  const forms = [];
  function createForm(title, content, serialize, endpoint, getValues, available = () => true) {
    let dirty = false;
    const status = h("p", { class: "form-status", role: "status" });
    const save = h("button", { type: "submit", class: "btn btn--primary" }, "Save");
    const reload = h("button", { type: "button", class: "btn" }, "Reload values");
    const fieldset = h("fieldset", { class: "settings-fieldset" }, content, h("div", { class: "form-actions" }, save, reload));
    const form = h("form", { class: "settings-card", "aria-label": title }, h("h2", null, title), fieldset, status);
    const record = { form, update(model, busy) {
      fieldset.disabled = busy || !ctx.canControl() || !available(model);
      if (!dirty) setValues(form, getValues(model));
    } };
    forms.push(record);
    form.addEventListener("input", () => { dirty = true; status.textContent = "Unsaved changes"; });
    reload.addEventListener("click", () => {
      dirty = false;
      record.update(ctx.getModel(), false);
      status.textContent = "Values reloaded.";
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

  const clock = createForm("Clock appearance",
    [
      group("View",
        field("Layout", select("layout", CLOCK_CHOICES.layout)),
        field("Widget clock", select("face", CLOCK_CHOICES.face)),
        field("Full-screen clock", select("full_face", CLOCK_CHOICES.full_face)),
        field("Widget", select("widget", CLOCK_CHOICES.widget))),
      group("Time and calendar",
        field("Show seconds", input("seconds", "checkbox")),
        field("Second hand", select("second_hand", CLOCK_CHOICES.second_hand)),
        field("Time format", select("time_format", CLOCK_CHOICES.time_format)),
        field("Language", select("language", ["", "en", "fr", "de", "es", "it", "pt", "nl"], {
          "": "Automatic (device)", en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch",
        })),
        field("First weekday", select("week_start", CLOCK_CHOICES.week_start))),
      group("Colors",
        field("Primary", input("primary", "color")), field("Accent", input("accent", "color")),
        field("Seconds", input("seconds_color", "color")), field("Background", input("background", "color"))),
      group("Weather and next alarm",
        field("Weather entity", select("weather_entity", [""])),
        field("Place name (optional)", input("weather_name", "text", { maxlength: 256 })),
        field("Next alarm", select("next_alarm_entity", [""]))),
      group("Night mode",
        field("Mode", select("night_mode", CLOCK_CHOICES.night_mode)),
        field("Night entity / illuminance sensor", select("night_entity", [""])),
        field("Start hour", input("night_start", "number", { min: 0, max: 23, required: true })),
        field("End hour", input("night_end", "number", { min: 0, max: 23, required: true })),
        field("Sensor threshold", input("night_threshold", "number", { min: 0, max: 10000, step: "any", required: true })),
        field("Night color", input("night_color", "color")),
        field("Night brightness (%)", input("night_brightness", "number", { min: 20, max: 100, required: true }))),
    ],
    (form) => {
      const values = Object.fromEntries(new FormData(form));
      values.seconds = form.elements.namedItem("seconds").checked;
      for (const key of ["night_start", "night_end", "night_threshold", "night_brightness"]) values[key] = Number(values[key]);
      return parseClockOptions(values);
    }, "api/settings/clock", (model) => model.config.clock);
  clock.querySelector('[name="weather_entity"] option').textContent = "Not configured";
  clock.querySelector('[name="night_entity"] option').textContent = "Choose an entity";
  clock.querySelector('[name="next_alarm_entity"] option').textContent = "Use the two Clock Radio alarms";
  const clockInfo = h("p", { class: "settings-hint" });
  clock.append(clockInfo);

  const alarmMessages = [];
  const alarmForms = [1, 2].map((id) => {
    const message = h("p", { class: "settings-hint" });
    const active = h("p", { class: "alarm-countdown", role: "status" });
    alarmMessages.push({ id, message, active });
    return createForm(`Alarm ${id}`,
      [
        message, active,
        h("div", { class: "setting-grid" },
          field("Enabled", input("enabled", "checkbox")),
          field("Alarm type", select("type", ["Music", "Buzzer"])),
          field("Wake time", input("time", "time", { required: true })),
          field("Volume (%)", input("volume", "number", { min: 0, max: 100, required: true })),
          field("Wake timer (minutes)", input("duration", "number", { min: 1, max: 120, required: true }))),
        h("div", { class: "weekdays", role: "group", "aria-label": "Wake weekdays" }, DAYS.map((day) => field(day[0].toUpperCase() + day.slice(1, 3), input(day, "checkbox")))),
      ],
      (form) => {
        const value = (name) => form.elements.namedItem(name);
        const [hour, minute] = value("time").value.split(":").map(Number);
        return {
          id, enabled: value("enabled").checked, type: value("type").value, hour, minute,
          volume: Number(value("volume").value), duration: Number(value("duration").value),
          days: Object.fromEntries(DAYS.map((day) => [day, value(day).checked])),
        };
      }, "api/settings/alarm",
      (model) => {
        const alarm = model.alarms.alarms.find((item) => item.id === id);
        return {
          ...alarm, ...alarm.days, time: alarm.hour === null || alarm.minute === null ? "" : `${pad(alarm.hour)}:${pad(alarm.minute)}`,
        };
      }, (model) => model.alarms.alarms.find((alarm) => alarm.id === id).available);
  });

  const playback = createForm("Alarm playback",
    [
      h("p", { class: "settings-hint" }, "Both profiles use this speaker. A new alarm replaces the previous one; each wake timer stops playback when it finishes."),
      h("div", { class: "setting-grid" },
        field("Alarm speaker", select("player", [""])),
        field("Music source (Music Assistant URI or URL)", input("music_source", "text", { maxlength: 255, required: true })),
        field("Buzzer sound (absolute HTTP(S) URL)", input("buzzer_source", "text", { maxlength: 255, required: true }))),
    ],
    (form) => Object.fromEntries(new FormData(form)), "api/settings/alarm-playback",
    (model) => model.alarms, (model) => model.alarms.playback_missing.length === 0 && model.alarms.alarms.every((alarm) => alarm.available));
  const stop = h("button", { class: "btn", type: "button" }, "Stop active alarm");
  stop.addEventListener("click", () => ctx.write("api/alarm/stop", {}));
  const musicInfo = h("p", { class: "settings-hint" });
  const el = h("div", { class: "settings" },
    h("header", { class: "settings-heading" }, h("h1", null, "Settings"), h("p", null, "A clock for the room. Alarms that stay in Home Assistant.")),
    h("div", { class: "alarm-settings" }, ...alarmForms),
    playback, stop, clock,
    h("section", { class: "settings-card" }, h("h2", null, "Music Assistant"), musicInfo),
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
  return { el, update(model, busy) {
    const entities = model.clock_entities;
    optionsFor(clock.elements.namedItem("weather_entity"), entities.filter((item) => item.entity_id.startsWith("weather.")), "Not configured", model.config.clock.weather_entity);
    optionsFor(clock.elements.namedItem("night_entity"), entities.filter((item) => !item.entity_id.startsWith("weather.")), "Choose an entity", model.config.clock.night_entity);
    optionsFor(clock.elements.namedItem("next_alarm_entity"), entities.filter((item) => /^(sensor|input_datetime)\./.test(item.entity_id)), "Use the two Clock Radio alarms", model.config.clock.next_alarm_entity);
    optionsFor(playback.elements.namedItem("player"), model.players, "Choose a speaker", model.alarms.player);
    const language = clock.elements.namedItem("language");
    if (model.config.clock.language && ![...language.options].some((option) => option.value === model.config.clock.language)) language.add(new Option(model.config.clock.language, model.config.clock.language));
    for (const form of forms) form.update(model, busy);
    for (const { id, message, active } of alarmMessages) {
      const alarm = model.alarms.alarms.find((item) => item.id === id);
      message.textContent = alarm.available ? "Edits the existing HA helpers. No duplicate alarm is created." : `Missing or unavailable helpers: ${alarm.missing.join(", ")}. Install examples/home-assistant/clock_radio_alarms.yaml in HA.`;
      active.textContent = alarm.timer === "active" ? `Alarm is running${alarm.finishes_at ? ` until ${new Date(alarm.finishes_at).toLocaleTimeString()}` : ""}.` : "";
    }
    stop.hidden = !model.alarms.active_player;
    stop.disabled = busy || !ctx.canControl() || !model.alarms.can_stop;
    clockInfo.textContent = `Clock time zone: ${model.clock.timeZone || "this device"}. Alarm schedules always use Home Assistant's time zone. Room-light mode uses an HA illuminance sensor, with hysteresis; unavailable sensors retain their last state.`;
    musicInfo.textContent = model.music.library ? "Music Assistant browsing is configured. The read-only access token stays on the server." : "For Discover, Albums, Artists, Podcasts, Playlists, Search and Party, set music_assistant_token in the HA app options (Music Assistant → Settings → Profile). Set music_assistant_url if it is not discovered automatically. Restart the app after changing these options. Radio presets work without library access.";
  } };
}
