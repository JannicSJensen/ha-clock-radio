import { onSwipe } from "../js/core/swipe.js";

const root = document.getElementById("root");
const page = (step) => parent.postMessage({ type: "clock-radio-page", step }, location.origin);
onSwipe(root, {
  vertical: page,
  horizontal(step, target) {
    if (root.classList.contains("full")) return;
    const panel = target.closest("#widget") ? "widget" : "face";
    parent.postMessage({ type: "clock-radio-view", panel, step }, location.origin);
  },
});
addEventListener("keydown", (event) => {
  if (["PageUp", "PageDown"].includes(event.key)) { event.preventDefault(); page(event.key === "PageDown" ? 1 : -1); }
});
