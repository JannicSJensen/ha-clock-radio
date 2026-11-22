import { ui } from "../lib/ui-language.js";
import { h } from "../core/h.js";
import { icon } from "../core/icons.js";

export const STOP_THRESHOLD = 90;
export const completesStop = (progress) => Number.isFinite(progress) && progress >= STOP_THRESHOLD;

export function createSlideToStop(onStop) {
  const knob = h("span", { class: "slide-stop__knob", "aria-hidden": "true" }, icon("stop"));
  const label = h("span", { class: "slide-stop__label", "aria-hidden": "true" }, ui("slide to stop"));
  const el = h("div", {
    class: "slide-stop", role: "slider", tabindex: "0", "aria-label": ui("Slide to stop alarm"),
    "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-orientation": "horizontal",
    "aria-description": ui("Drag the stop button to the right. Keyboard: End, then Enter to stop."),
  }, label, knob);
  let progress = 0;
  let disabled = false;
  let pointer = null;
  let startX = 0;

  function paint(value) {
    progress = Math.max(0, Math.min(100, value));
    const travel = Math.max(0, el.clientWidth - knob.offsetWidth - 12);
    knob.style.transform = `translateX(${travel * progress / 100}px)`;
    label.style.opacity = String(1 - progress / 100);
    el.setAttribute("aria-valuenow", String(Math.round(progress)));
    el.setAttribute("aria-valuetext", completesStop(progress) ? ui("Ready to stop") : ui("Slide right to stop"));
  }
  function reset() {
    const id = pointer;
    pointer = null;
    if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id);
    paint(0);
  }
  knob.addEventListener("pointerdown", (event) => {
    if (disabled || pointer !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    pointer = event.pointerId;
    startX = event.clientX;
    paint(0);
    el.focus();
    el.setPointerCapture(pointer);
  });
  el.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    const travel = el.clientWidth - knob.offsetWidth - 12;
    if (travel > 0) paint((event.clientX - startX) / travel * 100);
  });
  el.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointer) return;
    const complete = !disabled && completesStop(progress);
    reset();
    if (complete) onStop();
  });
  el.addEventListener("pointercancel", reset);
  el.addEventListener("lostpointercapture", reset);
  el.addEventListener("blur", reset);
  el.addEventListener("keydown", (event) => {
    if (disabled) return;
    if (!["ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (["Enter", " "].includes(event.key)) {
      const complete = completesStop(progress);
      reset();
      if (complete) onStop();
    } else paint(event.key === "Home" ? 0 : event.key === "End" ? 100 : progress + (event.key === "ArrowRight" ? 10 : -10));
  });
  paint(0);
  return {
    el, reset,
    setDisabled(value) {
      disabled = value;
      el.setAttribute("aria-disabled", String(value));
      el.tabIndex = value ? -1 : 0;
      if (value) reset();
    },
  };
}
