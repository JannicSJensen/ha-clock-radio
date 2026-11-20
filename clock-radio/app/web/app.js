import { getJson, postJson } from "./js/core/api.js";
import { onSwipe } from "./js/core/swipe.js";
import { navigationKey } from "./js/core/navigation.js";
import { getPref, setPref } from "./js/core/prefs.js";
import { makeTranslator } from "./js/lib/i18n.js";
import { createMusicPage } from "./js/pages/music.js";
import { createNowPlayingScreen } from "./js/components/nowplaying-screen.js";
import { createSettingsPages } from "./js/pages/settings.js";
import { createAlarmScreen } from "./js/components/alarm-screen.js";
import { snoozeKey } from "./js/components/snooze-panel.js";
import { IdleReturn } from "./js/core/idle-return.js";
import { SnapshotStore, offlineStatus } from "./js/core/snapshot.js";
import { KioskAlarmUI } from "./js/core/kiosk-alarm-ui.js";

const $ = (id) => document.getElementById(id);
const frame = $("clock-frame");
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--banner-height", `${entry.contentRect.height}px`);
}).observe(document.querySelector(".banners"));
const PAGES = { clock: "The Clock", alarms: "Alarm configuration", music: "Music overview", settings: "Settings" };
const pageIds = Object.keys(PAGES);
const pageDots = pageIds.map(() => {
  const dot = document.createElement("span");
  dot.className = "page-indicator__dot";
  dot.setAttribute("aria-hidden", "true");
  return dot;
});
$("page-indicator").append(...pageDots);
let model = null;
let current = "clock";
let musicPage = null;
let musicSignature = "";
let settingsPages = null;
let nowPlaying = null;
let alarmScreen = null;
let clockSignature = "";
let clockRevision = 0;
let clockDataSignature = "";
let focusedClockPanel = "face";
let pending = 0;
let polling = null;
let currentSnoozeKey = null;
let snoozeStopping = false;
let snoozeError = "";
let snoozeConfirmation = null;
const idleReturn = new IdleReturn();
const activePointers = new Set();
const snapshots = new SnapshotStore();
const kioskAlarmUi = new KioskAlarmUI({
  getModel: () => model,
  render: () => { if (model) render(); },
  afterPaint: async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return alarmScreen?.controlsReady === true;
  },
});
setInterval(() => kioskAlarmUi.refresh(), 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") kioskAlarmUi.release().then(() => { if (model) render(); });
  else kioskAlarmUi.refresh();
});
window.addEventListener("pagehide", () => kioskAlarmUi.release());

function checkIdleReturn() {
  if (idleReturn.expired({
    minutes: model?.config.return_to_clock_minutes,
    paused: !model || current === "clock" || pending > 0 || activePointers.size > 0
      || Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')),
  })) location.hash = "clock";
}

function notice(id, message) {
  $(id).textContent = message ?? "";
  $(id).hidden = !message;
}
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4500);
}
const canControl = () => Boolean(model?.connected && !model.read_only);
const canControlAlarms = () => Boolean(model && !model.read_only && !model.offline_snapshot && (model.alarms.connected ?? model.connected));
const canControlKiosk = () => Boolean(model?.kiosk_update?.connected && !model.read_only && !model.offline_snapshot);
const ctx = {
  t: makeTranslator("en"), toast, canControl, canControlAlarms, getModel: () => model,
  getState: (id) => model?.players.find((player) => player.entity_id === id) ?? null,
  musicPlayers: () => model?.music.players ?? [],
  stations: () => model?.music.stations ?? [],
  navigate: (page) => { location.hash = page; },
  openNowPlaying: (id) => !alarmScreen?.isOpen && nowPlaying?.open(id),
  playRadio: (entity_id, station_id) => write("api/radio/play", { entity_id, station_id }),
  playMusic: (entity_id, request) => write("api/music/play", { ...request, entity_id }),
  call: (domain, action, entity_id, data = {}) => {
    if (domain !== "media_player") throw new Error("Only scoped media controls are supported.");
    return write("api/command", { action, entity_id, ...data });
  },
  writeError: () => $("command-error").textContent,
  nativeAlarmControl: (action, context) => kioskAlarmUi.control(action, context),
  write, refresh: poll,
};

function policy() {
  for (const el of document.querySelectorAll("[data-mutation]")) {
    if (el.tagName === "BUTTON") el.disabled = !canControl();
    else {
      el.setAttribute("aria-disabled", String(!canControl()));
      el.tabIndex = canControl() ? 0 : -1;
    }
  }
}
new MutationObserver(policy).observe($("page-music"), { subtree: true, childList: true });

function navigate() {
  if (alarmScreen?.isOpen) {
    history.replaceState(null, "", `#${current}`);
    return;
  }
  current = Object.hasOwn(PAGES, location.hash.slice(1)) ? location.hash.slice(1) : "clock";
  idleReturn.reset();
  if (current !== "alarms") settingsPages?.closeAlarmEditor();
  for (const [index, page] of pageIds.entries()) {
    $(`page-${page}`).hidden = page !== current;
    pageDots[index].classList.toggle("is-active", page === current);
  }
  $(`page-${current}`).tabIndex = -1;
  $(`page-${current}`).focus({ preventScroll: true });
  const position = `Page ${pageIds.indexOf(current) + 1} of ${pageIds.length}: ${PAGES[current]}`;
  $("page-indicator").setAttribute("aria-label", position);
  $("page-position").textContent = `${position}. Swipe left/right or use Left/Right arrows or Page Up/Down to change pages.`;
  document.body.classList.toggle("on-clock", current === "clock");
  if (current !== "clock") document.body.classList.remove("is-night");
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" }, location.origin);
  if (current === "music") renderMusic();
  checkIdleReturn();
}

function changePage(step) {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const active = Object.hasOwn(PAGES, location.hash.slice(1)) ? location.hash.slice(1) : current;
  location.hash = pageIds[(pageIds.indexOf(active) + step + pageIds.length) % pageIds.length];
}

function changeClockView(panel, step) {
  if (!model || alarmScreen?.isOpen || current !== "clock" || !["face", "widget"].includes(panel)) return;
  if (model.alarms.snoozed) return toast("Clock panels return to normal when snooze ends.");
  if (pending) return toast("Please wait for the current save to finish.");
  const views = panel === "face" ? ["analog", "analog-round", "digital"] : ["calendar", "weather", "date", "date-calendar"];
  const value = views[(Math.max(0, views.indexOf(model.config.clock[panel])) + step + views.length) % views.length];
  write("api/settings/clock", { ...model.config.clock, [panel]: value });
}

function clockOptions() {
  const options = { ...model.clock };
  delete options.error;
  delete options.night_error;
  const alarm = model.alarms.active ? null : model.alarms.snoozed;
  const key = snoozeKey(alarm);
  if (key !== currentSnoozeKey) {
    clearTimeout(snoozeConfirmation);
    snoozeStopping = false;
    snoozeError = "";
    currentSnoozeKey = key;
  }
  if (alarm) {
    options.layout = "widget";
    options.widget = "snooze";
  }
  options.snooze = {
    alarm, stopping: snoozeStopping, error: snoozeError, busy: pending > 0,
    canStop: canControlAlarms() && model.alarms.can_stop && !model.alarms.active_error,
    status: model.alarms.backend === "kiosk_satellite" ? kioskAlarmUi.error
      : !model.connected ? "Disconnected. Reconnect to cancel snooze."
      : model.read_only ? "Read-only. Use Home Assistant to cancel snooze."
      : model.alarms.active_error || (!model.alarms.can_stop ? "The HA alarm stop script is unavailable." : ""),
  };
  return options;
}

function renderClock() {
  const options = clockOptions();
  document.body.style.setProperty("--clock-night", options.nightColor);
  const live = new Set(["snooze", "nightActive", "alarm", "weatherConfigured", "weatherPlace", "weatherCondition", "weatherTemperature", "weatherUnit", "weatherDate", "weatherHigh", "weatherLow"]);
  const signature = JSON.stringify(Object.fromEntries(Object.entries(options).filter(([key]) => !live.has(key))));
  if (signature !== clockSignature) {
    frame.src = `./clock/index.html?view=${++clockRevision}#${encodeURIComponent(JSON.stringify(options))}`;
    clockSignature = signature;
    clockDataSignature = "";
  } else if (JSON.stringify(options) !== clockDataSignature) {
    frame.contentWindow?.postMessage({ type: "clock-radio-data", options }, location.origin);
  }
  clockDataSignature = JSON.stringify(options);
}

async function stopSnooze(target) {
  const alarm = model?.alarms.snoozed;
  if (!alarm || model.alarms.active || snoozeKey(target) !== snoozeKey(alarm) || Date.parse(alarm.until) <= Date.now()) {
    toast("This snooze has ended or changed. Waiting for its current state.");
    await poll();
    return;
  }
  if (snoozeStopping || pending || !canControlAlarms() || !model.alarms.can_stop || model.alarms.active_error) {
    toast("Snooze cannot be stopped right now. Check the connection, permissions and HA alarm helpers.");
    return;
  }
  const key = snoozeKey(alarm);
  snoozeStopping = true;
  snoozeError = "";
  renderClock();
  if (alarm.backend === "kiosk_satellite") {
    try { await kioskAlarmUi.control("stop", alarm.native_context); }
    catch (error) { snoozeError = error.message; }
    finally { snoozeStopping = false; render(); }
    return;
  }
  const ok = await write("api/alarm/stop", { snoozed: { id: alarm.id, type: alarm.type, until: alarm.until } });
  if (snoozeKey(model.alarms.snoozed) !== key || model.alarms.active) return;
  if (!ok) {
    snoozeStopping = false;
    snoozeError = ctx.writeError() || "Snooze was not cancelled. Please try again.";
  } else {
    snoozeConfirmation = setTimeout(() => {
      if (currentSnoozeKey !== key) return;
      snoozeStopping = false;
      snoozeError = "Home Assistant has not confirmed cancellation. Check HA and try again.";
      renderClock();
    }, 15000);
  }
  renderClock();
}

function renderMusic() {
  if (!model || (current !== "music" && !musicPage)) return;
  const signature = JSON.stringify([model.music, model.config.locale]);
  if (signature !== musicSignature) {
    musicPage?.destroy();
    musicPage = createMusicPage(model.music, ctx);
    $("page-music").replaceChildren(musicPage.el);
    musicSignature = signature;
  }
  musicPage.update();
}

function render() {
  if (!model) return;
  model = kioskAlarmUi.apply(model);
  document.title = model.config.title;
  document.documentElement.lang = model.config.locale;
  $("version").textContent = `v${model.version}`;
  $("connection").textContent = model.connected ? model.demo ? "Demo connected" : "Connected" : "Disconnected";
  $("connection").classList.toggle("online", model.connected);
  $("initial-loading").hidden = true;
  $("demo-notice").hidden = !model.demo;
  notice("connection-error", model.connection_error);
  notice("offline-status", offlineStatus(model));
  notice("snapshot-error", snapshots.error);
  const native = model.alarms.backend === "kiosk_satellite";
  notice("alarm-backend", native ? `Experimental Kiosk alarms: ${model.alarms.connected ? `connected (${model.alarms.native_phase})` : model.alarms.error || "offline"}. ${kioskAlarmUi.message || "Kiosk supplies the native ringing screen."}` : "");
  notice("config-error", model.config_error);
  notice("clock-error", [model.clock.error, model.clock.night_error, model.alarms.active_error].filter(Boolean).join(" "));
  notice("missing-players", model.missing_players.length ? `Missing configured speakers: ${model.missing_players.join(", ")}` : "");
  $("read-only").hidden = !model.read_only || Boolean(model.offline_snapshot);
  renderClock();
  ctx.t = makeTranslator(model.config.locale);
  renderMusic();
  if (!settingsPages) {
    settingsPages = createSettingsPages(ctx);
    $("page-alarms").append(settingsPages.alarmsEl);
    $("page-settings").append(settingsPages.el);
  }
  if (!nowPlaying) {
    nowPlaying = createNowPlayingScreen(ctx, { enabled: () => false });
    document.body.append(nowPlaying.el);
  }
  nowPlaying.update();
  settingsPages.update(model, pending > 0);
  if (!alarmScreen) {
    alarmScreen = createAlarmScreen(ctx, {
      onOpen: () => {
        settingsPages.closeAlarmEditor();
        nowPlaying.close({ dismiss: true });
        document.body.classList.remove("is-night");
        frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: false }, location.origin);
      },
      onClose: navigate,
    });
    document.body.append(alarmScreen.el);
  }
  alarmScreen.update(model, pending > 0);
  checkIdleReturn();
  policy();
  if (!getPref("keyboard-navigation-hint")) {
    toast("Pages: swipe left/right, Left/Right arrows or Page Up/Down. Clock panels: swipe up/down, or Tab/click a panel and use Up/Down arrows. Tap Music tabs to switch categories.");
    setPref("keyboard-navigation-hint", true);
  }
}

async function poll() {
  if (polling) return polling;
  polling = (async () => {
    try {
      const next = await getJson("api/state", { timeout: 8000 });
      if (next.alarms.backend === "kiosk_satellite") {
        model = next;
        if (!next.alarms.connected) {
          const cached = snapshots.restore(next.alarms.error);
          if (cached?.alarms.backend === "kiosk_satellite" && cached.alarms.backend_id === next.alarms.backend_id) {
            model.alarms = { ...cached.alarms, error: next.alarms.error };
          }
        }
        if (!pending) snapshots.save(model);
      } else if (next.connected || next.kiosk_update?.connected) {
        model = next;
        if (!pending) snapshots.save(model);
      } else {
        const cached = snapshots.restore(next.connection_error);
        model = cached && cached.alarms.backend === "home_assistant" ? cached : next;
      }
      render();
    } catch (error) {
      console.warn(error.message);
      model = snapshots.restore(`Dashboard connection lost: ${error.message}`) ?? model;
      if (model) {
        model.connected = false;
        model.connection_error = `Dashboard connection lost: ${error.message}`;
        render();
      } else {
        notice("connection-error", `Cannot reach the dashboard: ${error.message}`);
        notice("offline-status", "Offline. No saved snapshot is available. Reconnect to load clock settings and alarms.");
        notice("snapshot-error", snapshots.error);
        $("initial-loading").textContent = "Cannot connect. No saved snapshot is available.";
        $("connection").textContent = "Disconnected";
      }
    }
  })().finally(() => { polling = null; });
  return polling;
}

async function write(url, data) {
  const alarmWrite = /^api\/(?:alarm\/|settings\/alarm(?:$|-playback$))/.test(url);
  if (!(url === "api/kiosk/update/install" ? canControlKiosk() : alarmWrite ? canControlAlarms() : canControl())) { toast("The requested backend is read-only or disconnected."); return false; }
  pending++;
  checkIdleReturn();
  notice("command-error", "");
  settingsPages?.update(model, true);
  alarmScreen?.update(model, true);
  renderClock();
  try {
    await postJson(url, data);
    await poll();
    return true;
  } catch (error) {
    console.warn(error.message);
    notice("command-error", error.message);
    await poll();
    return false;
  } finally {
    pending--;
    if (!pending && model) snapshots.save(model);
    notice("snapshot-error", snapshots.error);
    checkIdleReturn();
    settingsPages?.update(model, pending > 0);
    alarmScreen?.update(model, pending > 0);
    renderClock();
  }
}

frame.addEventListener("load", () => {
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" && !alarmScreen?.isOpen }, location.origin);
  if (model) frame.contentWindow?.postMessage({ type: "clock-radio-data", options: clockOptions() }, location.origin);
  if (current === "clock" && document.activeElement === frame) {
    frame.contentWindow?.postMessage({ type: "clock-radio-focus", panel: focusedClockPanel }, location.origin);
  }
});
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  if (event.data?.type === "clock-radio-panel-focus" && ["face", "widget"].includes(event.data.panel)) focusedClockPanel = event.data.panel;
  if (event.data?.type === "clock-radio-night") document.body.classList.toggle("is-night", current === "clock" && !alarmScreen?.isOpen && event.data.active === true);
  if (event.data?.type === "clock-radio-stop-snooze") {
    stopSnooze(event.data.snoozed);
    return;
  }
  if (![1, -1].includes(event.data?.step)) return;
  if (event.data.type === "clock-radio-page") changePage(event.data.step);
  if (event.data.type === "clock-radio-view") changeClockView(event.data.panel, event.data.step);
});
for (const page of pageIds.filter((page) => page !== "clock")) {
  onSwipe($(`page-${page}`), { horizontal: changePage });
}
addEventListener("hashchange", navigate);
for (const type of ["pointermove", "keydown", "input", "wheel", "scroll", "touchstart", "touchmove", "touchend"]) {
  addEventListener(type, () => idleReturn.reset(), { capture: true, passive: true });
}
addEventListener("pointerdown", (event) => {
  activePointers.add(event.pointerId);
  idleReturn.reset();
  checkIdleReturn();
}, { capture: true, passive: true });
for (const type of ["pointerup", "pointercancel"]) {
  addEventListener(type, (event) => {
    activePointers.delete(event.pointerId);
    idleReturn.reset();
    checkIdleReturn();
  }, { capture: true, passive: true });
}
addEventListener("blur", () => { activePointers.clear(); checkIdleReturn(); });
document.addEventListener("visibilitychange", () => { activePointers.clear(); checkIdleReturn(); });
addEventListener("keydown", (event) => {
  if (event.key === "Escape") nowPlaying?.close({ dismiss: true });
  const action = navigationKey(event);
  if (!action || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  if (action.axis === "horizontal") {
    event.preventDefault();
    changePage(action.step);
  } else if (current === "clock" && model) {
    event.preventDefault();
    frame.contentWindow?.postMessage({ type: "clock-radio-focus", panel: focusedClockPanel, step: action.step }, location.origin);
  }
});
$("fullscreen").hidden = !document.fullscreenEnabled;
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) { toast(`Cannot enter full screen: ${error.message}`); }
});
addEventListener("fullscreenchange", () => { $("fullscreen").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
navigate();
model = snapshots.restore("Checking the connection to Home Assistant.");
if (model) render();
else notice("snapshot-error", snapshots.error);
await poll();
setInterval(poll, 5000);
setInterval(checkIdleReturn, 1000);
addEventListener("online", poll);
