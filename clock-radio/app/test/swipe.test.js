import assert from "node:assert/strict";
import test from "node:test";
import { canScroll, onSwipe, swipeStep } from "../web/js/core/swipe.js";
import { NAVIGATION_CONTROLS, navigationKey } from "../web/js/core/navigation.js";

test("touch gestures distinguish page and panel axes and enforce actual thresholds", () => {
  assert.equal(swipeStep(-64, 0, 1200, "horizontal"), 1);
  assert.equal(swipeStep(64, 0, 1200, "horizontal"), -1);
  assert.equal(swipeStep(0, -64, 1200, "vertical"), 1);
  assert.equal(swipeStep(0, 64, 1200, "vertical"), -1);
  for (const [dx, dy, elapsed, axis] of [[-63, 0, 100, "horizontal"], [0, -63, 100, "vertical"], [-64, 0, 1201, "horizontal"], [-80, 60, 500, "horizontal"], [-100, 0, 500, "vertical"]]) {
    assert.equal(swipeStep(dx, dy, elapsed, axis), 0);
  }
});

test("keyboard arrows mirror the page and panel axes, while Page Up/Down keep working", () => {
  for (const [key, axis, step] of [
    ["ArrowLeft", "horizontal", -1], ["ArrowRight", "horizontal", 1],
    ["PageUp", "horizontal", -1], ["PageDown", "horizontal", 1],
    ["ArrowUp", "vertical", -1], ["ArrowDown", "vertical", 1],
  ]) {
    assert.deepEqual(navigationKey({ key }), { axis, step });
  }
  for (const key of ["Tab", "Enter", "Escape", "Home", "End", " "]) assert.equal(navigationKey({ key }), null);
});

test("keyboard navigation preserves shortcuts, repeated/handled keys and editable controls", () => {
  for (const field of ["defaultPrevented", "repeat", "altKey", "ctrlKey", "metaKey", "shiftKey"]) {
    for (const key of ["ArrowRight", "ArrowDown", "PageDown"]) assert.equal(navigationKey({ key, [field]: true }), null);
  }
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
    const target = { closest(selector) { assert.equal(selector, NAVIGATION_CONTROLS); return {}; } };
    assert.equal(navigationKey({ key, target }), null);
  }
});

function globalForTest(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

function surface(t) {
  globalForTest(t, "getComputedStyle", (el) => ({ overflowX: "visible", overflowY: "visible", ...el.style }));
  const root = Object.assign(new EventTarget(), {
    parentElement: null, scrollHeight: 100, clientHeight: 100, scrollTop: 0,
    scrollWidth: 100, clientWidth: 100, scrollLeft: 0, style: {},
    closest: () => null,
  });
  const child = { parentElement: root, closest: () => null, style: {} };
  function event(type, x, y, target = child, fingers = 1) {
    const touch = { clientX: x, clientY: y };
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      target: { value: target },
      touches: { value: type === "touchend" || type === "touchcancel" ? [] : Array(fingers).fill(touch) },
      changedTouches: { value: [touch] },
    });
    root.dispatchEvent(event);
    return event;
  }
  function swipe(dx, dy, target = child) {
    event("touchstart", 200, 200, target);
    const move = event("touchmove", 200 + dx, 200 + dy, target);
    const end = event("touchend", 200 + dx, 200 + dy, target);
    return { move, end };
  }
  return { root, child, event, swipe };
}

test("horizontal page gestures ignore vertical scrolling and protected controls", (t) => {
  const { root, child, swipe } = surface(t);
  const steps = [];
  onSwipe(root, { horizontal: (step) => steps.push(step) });
  assert.equal(swipe(-100, 0).end.defaultPrevented, true);
  assert.equal(swipe(100, 0).end.defaultPrevented, true);
  child.style.overflowY = "auto";
  Object.assign(child, { scrollHeight: 500, clientHeight: 100, scrollTop: 200 });
  const vertical = swipe(0, -100);
  assert.equal(vertical.move.defaultPrevented, false);
  assert.equal(vertical.end.defaultPrevented, false);
  child.closest = () => ({});
  assert.equal(swipe(-100, 0).end.defaultPrevented, false);
  assert.deepEqual(steps, [1, -1]);
});

test("horizontal scrollers consume a gesture until a new swipe starts at the edge", (t) => {
  const { root, child, event, swipe } = surface(t);
  Object.assign(child, { scrollWidth: 500, clientWidth: 100, scrollLeft: 100, style: { overflowX: "auto" } });
  const steps = [];
  onSwipe(root, { horizontal: (step) => steps.push(step) });
  assert.equal(canScroll(child, root, 1, "horizontal"), true);
  assert.equal(swipe(-100, 0).move.defaultPrevented, false);
  assert.equal(swipe(100, 0).end.defaultPrevented, false);
  event("touchstart", 200, 200);
  event("touchmove", 100, 200);
  child.scrollLeft = 400;
  event("touchend", 100, 200);
  assert.deepEqual(steps, [], "Reaching an edge during a scroll must not also navigate");
  assert.equal(canScroll(child, root, 1, "horizontal"), false);
  assert.equal(swipe(-100, 0).end.defaultPrevented, true);
  child.scrollLeft = 0;
  swipe(100, 0);
  assert.deepEqual(steps, [1, -1]);
});

test("scroll guards inspect ancestors but never scrollable elements beyond the boundary", (t) => {
  const { root, child } = surface(t);
  const outer = { style: { overflowX: "scroll", overflowY: "auto" }, scrollWidth: 500, clientWidth: 100, scrollLeft: 100,
    scrollHeight: 500, clientHeight: 100, scrollTop: 100, parentElement: null };
  root.parentElement = outer;
  assert.equal(canScroll(child, root, 1, "horizontal"), false);
  assert.equal(canScroll(child, root, -1), false);
  Object.assign(root, { style: { overflowY: "auto" }, scrollHeight: 500, scrollTop: 100 });
  assert.equal(canScroll(child, root, -1), true);
  root.scrollTop = 0;
  assert.equal(canScroll(child, root, -1), false);
});

test("vertical panel gestures receive their starting target and preserve scrolling", (t) => {
  const { root, child, swipe } = surface(t);
  const calls = [];
  onSwipe(root, { vertical: (step, target) => calls.push({ step, target }) });
  assert.equal(swipe(0, -100).move.defaultPrevented, true);
  swipe(0, 100);
  assert.deepEqual(calls, [{ step: 1, target: child }, { step: -1, target: child }]);
  assert.equal(swipe(-100, 0).end.defaultPrevented, false);
  Object.assign(child, { scrollHeight: 500, clientHeight: 100, scrollTop: 100, style: { overflowY: "auto" } });
  assert.equal(swipe(0, -100).end.defaultPrevented, false);
  assert.equal(calls.length, 2);
});

test("cancelled, multi-touch and detached gestures never navigate", (t) => {
  const { root, event, swipe } = surface(t);
  const steps = [];
  const stop = onSwipe(root, { horizontal: (step) => steps.push(step) });
  event("touchstart", 200, 200);
  event("touchcancel", 100, 200);
  event("touchend", 100, 200);
  event("touchstart", 200, 200, root, 2);
  event("touchend", 100, 200);
  event("touchstart", 200, 200);
  event("touchmove", 100, 200, root, 2);
  event("touchend", 100, 200);
  stop();
  swipe(-100, 0);
  assert.deepEqual(steps, []);
});

test("Clock iframe sends horizontal page navigation and vertical panel changes", async (t) => {
  const { root, swipe } = surface(t);
  let full = false, snoozed = false, alone = false;
  root.classList = { contains: (name) => name === "full" ? full : name === "alone" && alone };
  root.querySelector = () => snoozed;
  const messages = [];
  const keys = new Map();
  const focused = [];
  const face = { parentElement: root, style: {}, closest: (selector) => selector === ".panel" ? face : null, focus: () => focused.push("face") };
  const widget = { parentElement: root, style: {}, closest: (selector) => ["#widget", ".panel"].includes(selector) ? widget : null, focus: () => focused.push("widget") };
  globalForTest(t, "document", { getElementById: (id) => ({ root, clock: face, widget })[id] });
  globalForTest(t, "location", { origin: "http://clock-radio.example" });
  globalForTest(t, "parent", { postMessage: (data, origin) => {
    assert.equal(origin, "http://clock-radio.example");
    messages.push(data);
  } });
  globalForTest(t, "addEventListener", (type, callback) => keys.set(type, callback));
  await import("../web/clock/touch.js");
  swipe(-100, 0, face);
  swipe(100, 0, widget);
  swipe(0, -100, face);
  swipe(0, 100, widget);
  assert.deepEqual(messages, [
    { type: "clock-radio-page", step: 1 }, { type: "clock-radio-page", step: -1 },
    { type: "clock-radio-view", panel: "face", step: 1 }, { type: "clock-radio-view", panel: "widget", step: -1 },
  ]);
  full = true;
  swipe(0, -100, face);
  full = false; snoozed = true;
  swipe(0, -100, widget);
  assert.equal(messages.length, 4, "Full-screen and snoozed panels cannot change views");
  swipe(-100, 0, widget);
  assert.deepEqual(messages.at(-1), { type: "clock-radio-page", step: 1 });
  let prevented = false;
  keys.get("keydown")({ key: "PageDown", target: face, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(messages.at(-1), { type: "clock-radio-page", step: 1 });
  function key(key, target = face) {
    const event = { key, target, prevented: false, preventDefault() { this.prevented = true; } };
    keys.get("keydown")(event);
    return event;
  }
  assert.equal(key("ArrowDown").prevented, false, "Snoozed panels cannot change with the keyboard");
  snoozed = false;
  key("ArrowDown", widget);
  assert.deepEqual(messages.at(-1), { type: "clock-radio-view", panel: "widget", step: 1 });
  key("ArrowUp");
  assert.deepEqual(messages.at(-1), { type: "clock-radio-view", panel: "face", step: -1 });
  key("ArrowLeft");
  assert.deepEqual(messages.at(-1), { type: "clock-radio-page", step: -1 });
  key("ArrowRight", widget);
  assert.deepEqual(messages.at(-1), { type: "clock-radio-page", step: 1 });
  full = true;
  assert.equal(key("ArrowDown").prevented, false);
  full = false;
  const before = messages.length;
  const focusMessage = { origin: location.origin, source: parent, data: { type: "clock-radio-focus", panel: "widget", step: 1 } };
  keys.get("message")({ ...focusMessage, origin: "http://other.example" });
  keys.get("message")({ ...focusMessage, source: {} });
  keys.get("message")({ ...focusMessage, data: { ...focusMessage.data, panel: "invalid" } });
  assert.equal(messages.length, before);
  assert.deepEqual(focused, []);
  keys.get("message")(focusMessage);
  assert.deepEqual(focused, ["widget"]);
  assert.deepEqual(messages.at(-1), { type: "clock-radio-view", panel: "widget", step: 1 });
  keys.get("message")({ ...focusMessage, data: { type: "clock-radio-focus", panel: "face" } });
  assert.deepEqual(focused, ["widget", "face"]);
  assert.equal(messages.length, before + 1, "Restoring focus must not change the panel's view");
  alone = true;
  keys.get("message")(focusMessage);
  assert.equal(focused.at(-1), "face", "A hidden widget must not receive focus or be changed");
  assert.deepEqual(messages.at(-1), { type: "clock-radio-view", panel: "face", step: 1 });
});
