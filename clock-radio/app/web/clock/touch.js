import { onSwipe } from "../js/core/swipe.js";
import { NAVIGATION_CONTROLS, navigationKey } from "../js/core/navigation.js";

const root = document.getElementById("root");
const page = (step) => parent.postMessage({ type: "clock-radio-page", step }, location.origin);
const panelName = (target) => target.closest("#widget") ? "widget" : "face";
function changeView(step, target) {
  if (root.classList.contains("full") || root.querySelector(".snooze-panel")) return false;
  parent.postMessage({ type: "clock-radio-view", panel: panelName(target), step }, location.origin);
  return true;
}
onSwipe(root, {
  horizontal: page,
  vertical: changeView,
});
root.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(NAVIGATION_CONTROLS)) event.target.closest(".panel")?.focus({ preventScroll: true });
});
root.addEventListener("focusin", (event) => {
  parent.postMessage({ type: "clock-radio-panel-focus", panel: panelName(event.target) }, location.origin);
});
addEventListener("keydown", (event) => {
  const action = navigationKey(event);
  if (!action) return;
  if (action.axis === "horizontal") { event.preventDefault(); page(action.step); }
  else if (changeView(action.step, event.target)) event.preventDefault();
});
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "clock-radio-focus"
      || !["face", "widget"].includes(event.data.panel)) return;
  const widgetVisible = !["full", "alone", "mini-player"].some((name) => root.classList.contains(name));
  const panel = document.getElementById(event.data.panel === "widget" && widgetVisible ? "widget" : "clock");
  panel.focus({ preventScroll: true });
  if ([1, -1].includes(event.data.step)) changeView(event.data.step, panel);
});
