import { ui, uiFormat } from "../lib/ui-language.js";
import { h } from "../core/h.js";
import { createSlideToStop } from "./slide-to-stop.js";

export const snoozeKey = (alarm) => alarm ? `${alarm.id}:${alarm.type}:${alarm.until}${alarm.native_context ? ":" + JSON.stringify(alarm.native_context) : ""}` : null;

export function snoozeSeconds(until, now = Date.now()) {
  const deadline = Date.parse(until);
  if (!Number.isFinite(deadline)) throw new Error("Invalid snooze deadline.");
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function createSnoozePanel(onStop) {
  let data = null;
  let key = null;
  let disabled = null;
  const counter = h("div", { class: "snooze-panel__time", role: "timer", "aria-label": ui("Snooze time remaining"), "aria-live": "off" });
  const context = h("p", { class: "snooze-panel__context" });
  const status = h("p", { class: "snooze-panel__status", role: "status" });
  const slide = createSlideToStop(() => {
    if (data?.alarm && data.canStop && !data.busy && !data.stopping && snoozeSeconds(data.alarm.until) > 0) onStop(data.alarm);
  });
  slide.el.setAttribute("aria-label", ui("Slide to stop snooze"));
  const el = h("section", { class: "snooze-panel", "aria-label": ui("Snoozed alarm") },
    h("h2", null, ui("Snoozed")), counter, context, slide.el, status);

  function tick() {
    const seconds = data?.alarm ? snoozeSeconds(data.alarm.until) : 0;
    counter.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    const nextDisabled = Boolean(!data?.alarm || !data.canStop || data.busy || data.stopping || seconds === 0);
    if (disabled !== nextDisabled) {
      disabled = nextDisabled;
      slide.setDisabled(disabled);
    }
    const backend = data?.alarm?.backend === "kiosk_satellite" ? "Kiosk Satellite" : "Home Assistant";
    const message = data?.error || data?.status || (data?.stopping ? uiFormat("Waiting for {backend} to cancel snooze...", { backend })
      : seconds === 0 ? uiFormat("Waiting for {backend} to ring again...", { backend }) : ui("Slide to cancel this snooze."));
    if (status.textContent !== message) status.textContent = message;
  }
  return {
    el, tick,
    update(next) {
      if (snoozeKey(next?.alarm) !== key) slide.reset();
      data = next;
      key = snoozeKey(data?.alarm);
      context.textContent = data?.alarm ? uiFormat("{type} alarm", { type: ui(data.alarm.type) }) : "";
      tick();
    },
  };
}
