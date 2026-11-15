import { getJson, postJson } from "./js/core/api.js";
import { onSwipe } from "./js/core/swipe.js";
import { getPref, setPref } from "./js/core/prefs.js";
import { makeTranslator } from "./js/lib/i18n.js";
import { createMusicPage } from "./js/pages/music.js";
import { createNowPlayingScreen } from "./js/components/nowplaying-screen.js";
import { createSettingsPages } from "./js/pages/settings.js";
import { createAlarmScreen } from "./js/components/alarm-screen.js";
import { snoozeKey } from "./js/components/snooze-panel.js";

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
let pending = 0;
let polling = null;
let currentSnoozeKey = null;
let snoozeStopping = false;
let snoozeError = "";
let snoozeConfirmation = null;

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
const ctx = {
  t: makeTranslator("en"), toast, canControl, getModel: () => model,
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
  write,
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
  if (current !== "alarms") settingsPages?.closeAlarmEditor();
  for (const [index, page] of pageIds.entries()) {
    $(`page-${page}`).hidden = page !== current;
    pageDots[index].classList.toggle("is-active", page === current);
  }
  $(`page-${current}`).tabIndex = -1;
  $(`page-${current}`).focus({ preventScroll: true });
  const position = `Page ${pageIds.indexOf(current) + 1} of ${pageIds.length}: ${PAGES[current]}`;
  $("page-indicator").setAttribute("aria-label", position);
  $("page-position").textContent = `${position}. Swipe up/down or use Page Up/Down to change pages.`;
  document.body.classList.toggle("on-clock", current === "clock");
  if (current !== "clock") document.body.classList.remove("is-night");
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" }, location.origin);
  if (current === "music") renderMusic();
}

function changePage(step) {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  location.hash = pageIds[(pageIds.indexOf(current) + step + pageIds.length) % pageIds.length];
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
    canStop: canControl() && model.alarms.can_stop && !model.alarms.active_error,
    status: !model.connected ? "Disconnected. Reconnect to cancel snooze."
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
  if (snoozeStopping || pending || !canControl() || !model.alarms.can_stop || model.alarms.active_error) {
    toast("Snooze cannot be stopped right now. Check the connection, permissions and HA alarm helpers.");
    return;
  }
  const key = snoozeKey(alarm);
  snoozeStopping = true;
  snoozeError = "";
  renderClock();
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
  document.title = model.config.title;
  document.documentElement.lang = model.config.locale;
  $("version").textContent = `v${model.version}`;
  $("connection").textContent = model.connected ? model.demo ? "Demo connected" : "Connected" : "Disconnected";
  $("connection").classList.toggle("online", model.connected);
  $("initial-loading").hidden = true;
  $("demo-notice").hidden = !model.demo;
  notice("connection-error", model.connection_error);
  notice("config-error", model.config_error);
  notice("clock-error", [model.clock.error, model.clock.night_error, model.alarms.active_error].filter(Boolean).join(" "));
  notice("missing-players", model.missing_players.length ? `Missing configured speakers: ${model.missing_players.join(", ")}` : "");
  $("read-only").hidden = !model.read_only;
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
  policy();
  if (!getPref("touch-navigation-hint")) {
    toast("Swipe up/down between pages (scroll to the edge first). Swipe left/right within clock panels. Keyboard: Page Up/Down.");
    setPref("touch-navigation-hint", true);
  }
}

async function poll() {
  if (polling) return polling;
  polling = (async () => {
    try {
      model = await getJson("api/state");
      render();
    } catch (error) {
      console.warn(error.message);
      if (model) {
        model.connected = false;
        model.connection_error = `Dashboard connection lost: ${error.message}`;
        render();
      } else {
        notice("connection-error", `Cannot reach the dashboard: ${error.message}`);
        $("connection").textContent = "Disconnected";
      }
    }
  })().finally(() => { polling = null; });
  return polling;
}

async function write(url, data) {
  if (!canControl()) { toast("The dashboard is read-only or disconnected."); return false; }
  pending++;
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
    settingsPages?.update(model, pending > 0);
    alarmScreen?.update(model, pending > 0);
    renderClock();
  }
}

frame.addEventListener("load", () => {
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" && !alarmScreen?.isOpen }, location.origin);
  if (model) frame.contentWindow?.postMessage({ type: "clock-radio-data", options: clockOptions() }, location.origin);
});
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
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
  onSwipe($(`page-${page}`), { vertical: changePage });
}
addEventListener("hashchange", navigate);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") nowPlaying?.close({ dismiss: true });
  if (["PageUp", "PageDown"].includes(event.key) && !event.target.closest("input,textarea,select,[role=dialog]")) {
    event.preventDefault();
    changePage(event.key === "PageDown" ? 1 : -1);
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
await poll();
setInterval(poll, 5000);
