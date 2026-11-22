import { ui } from "../lib/ui-language.js";
import { h } from "../core/h.js";

const ROW_HEIGHT = 44;

export function timeParts(hour, minute, hour12 = false) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("The alarm time must have an hour from 0 to 23 and a minute from 0 to 59.");
  }
  return { hour: hour12 ? hour % 12 || 12 : hour, minute, period: hour >= 12 ? 1 : 0 };
}

export function to24Hour(hour, period, hour12 = false) {
  if (!Number.isInteger(hour) || hour < (hour12 ? 1 : 0) || hour > (hour12 ? 12 : 23)
      || ![0, 1].includes(period)) throw new Error("Invalid alarm hour or AM/PM selection.");
  return hour12 ? hour % 12 + period * 12 : hour;
}

function createWheel(label, values, format, onInput) {
  let current = values[0];
  let disabled = false;
  const items = values.map((value, index) => h("div", {
    class: "time-wheel__value", dataset: { index }, "aria-hidden": "true",
  }, format(value)));
  const el = h("div", {
    class: "time-wheel", role: "spinbutton", tabindex: "0", "aria-label": label,
    "aria-valuemin": values[0], "aria-valuemax": values.at(-1),
  }, items);
  const indexAtScroll = () => Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / ROW_HEIGHT)));
  function paint() {
    el.setAttribute("aria-valuenow", String(current));
    el.setAttribute("aria-valuetext", format(current));
    for (let index = 0; index < items.length; index++) items[index].classList.toggle("is-selected", values[index] === current);
  }
  function setValue(value, notify = false) {
    const index = values.indexOf(value);
    if (index < 0) throw new Error(`Invalid ${label.toLowerCase()} selection.`);
    const changed = current !== value;
    current = value;
    el.scrollTop = index * ROW_HEIGHT;
    paint();
    if (changed && notify) onInput();
  }
  el.addEventListener("scroll", () => {
    if (disabled) { el.scrollTop = values.indexOf(current) * ROW_HEIGHT; return; }
    const next = values[indexAtScroll()];
    if (next === current) return;
    current = next;
    paint();
    onInput();
  });
  el.addEventListener("click", (event) => {
    if (disabled) return;
    const item = event.target.closest("[data-index]");
    if (item) setValue(values[Number(item.dataset.index)], true);
  });
  el.addEventListener("keydown", (event) => {
    if (disabled) return;
    const steps = { ArrowUp: 1, ArrowDown: -1, PageUp: 5, PageDown: -5 };
    if (!(event.key in steps) && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1
      : Math.max(0, Math.min(values.length - 1, values.indexOf(current) + steps[event.key]));
    setValue(values[index], true);
  });
  paint();
  return {
    el, setValue,
    get value() { return disabled ? current : values[indexAtScroll()]; },
    setDisabled(value) {
      disabled = value;
      el.tabIndex = value ? -1 : 0;
      el.setAttribute("aria-disabled", String(value));
    },
  };
}

export function createTimePicker({ hour12 = false, onInput }) {
  const hours = createWheel(ui("Hour"), Array.from({ length: hour12 ? 12 : 24 }, (_, index) => hour12 ? index + 1 : index),
    (value) => hour12 ? String(value) : String(value).padStart(2, "0"), onInput);
  const minutes = createWheel(ui("Minute"), Array.from({ length: 60 }, (_, index) => index),
    (value) => String(value).padStart(2, "0"), onInput);
  const period = createWheel(ui("AM or PM"), [0, 1], (value) => value ? "PM" : "AM", onInput);
  const el = h("div", { class: `time-picker${hour12 ? " time-picker--12h" : ""}`, "aria-label": ui("Wake time") },
    h("div", { class: "time-picker__selection", "aria-hidden": "true" }),
    hours.el, h("span", { class: "time-picker__colon", "aria-hidden": "true" }, ":"), minutes.el,
    hour12 ? period.el : null);
  el.style.setProperty("--wheel-row", `${ROW_HEIGHT}px`);
  return {
    el,
    setTime(hour, minute) {
      const parts = timeParts(hour, minute, hour12);
      hours.setValue(parts.hour);
      minutes.setValue(parts.minute);
      period.setValue(parts.period);
    },
    getTime() { return { hour: to24Hour(hours.value, period.value, hour12), minute: minutes.value }; },
    setDisabled(value) {
      for (const wheel of [hours, minutes, period]) wheel.setDisabled(value);
    },
    focus() { hours.el.focus(); },
  };
}
