import { h } from "./h.js";
import { clamp } from "../lib/format.js";

/**
 * Pointer-driven slider. `orientation` is "vertical" (max at top) or "horizontal".
 * onInput fires while dragging, onCommit once on release.
 */
export function createSlider({ label, orientation = "horizontal", variant = "", min, max, step = 1, value, onInput, onCommit }) {
  const vertical = orientation === "vertical";
  const fill = h("div", { class: "slider__fill" });
  const knob = h("div", { class: "slider__knob" });
  const el = h("div", { class: `slider slider--${orientation}${variant ? ` slider--${variant}` : ""}`, role: "slider", tabindex: "0", "aria-label": label }, h("div", { class: "slider__track" }, fill), knob);

  let current = value;
  let dragging = false;

  const snap = (v) => clamp(Math.round((v - min) / step) * step + min, min, max);
  const ratioOf = (v) => (max === min ? 0 : (v - min) / (max - min));

  const paint = () => {
    const pct = `${ratioOf(current) * 100}%`;
    if (vertical) {
      fill.style.height = pct;
      knob.style.bottom = `calc(${pct} - var(--knob) / 2)`;
    } else {
      fill.style.width = pct;
      knob.style.left = `calc(${pct} - var(--knob) / 2)`;
    }
    el.setAttribute("aria-valuenow", String(current));
  };

  const fromEvent = (e) => {
    const rect = el.getBoundingClientRect();
    const raw = vertical ? 1 - (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
    return snap(min + clamp(raw, 0, 1) * (max - min));
  };

  el.addEventListener("pointerdown", (e) => {
    if (el.getAttribute("aria-disabled") === "true") return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    current = fromEvent(e);
    paint();
    onInput?.(current);
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const next = fromEvent(e);
    if (next === current) return;
    current = next;
    paint();
    onInput?.(current);
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    onCommit?.(current);
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
  el.addEventListener("keydown", (event) => {
    if (el.getAttribute("aria-disabled") === "true") return;
    const deltas = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step };
    if (!(event.key in deltas) && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    current = event.key === "Home" ? min : event.key === "End" ? max : snap(current + deltas[event.key]);
    paint();
    onCommit?.(current);
  });
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));
  el.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");

  paint();
  return {
    el,
    get dragging() {
      return dragging;
    },
    setValue(v) {
      if (dragging || v === current) return;
      current = clamp(v, min, max);
      paint();
    },
    setRange(newMin, newMax, newStep) {
      min = newMin;
      max = newMax;
      step = newStep ?? step;
      el.setAttribute("aria-valuemin", String(min));
      el.setAttribute("aria-valuemax", String(max));
      paint();
    },
    setDisabled(disabled) {
      el.setAttribute("aria-disabled", String(disabled));
      el.tabIndex = disabled ? -1 : 0;
      el.classList.toggle("is-locked", disabled);
      if (disabled) dragging = false;
    },
  };
}
