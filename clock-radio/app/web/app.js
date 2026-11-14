import { getJson, postJson } from "./js/core/api.js";
import { onSwipe } from "./js/core/swipe.js";
import { getPref, setPref } from "./js/core/prefs.js";
import { makeTranslator } from "./js/lib/i18n.js";
import { createMusicPage } from "./js/pages/music.js";
import { createNowPlayingScreen } from "./js/components/nowplaying-screen.js";
import { createSettingsPages } from "./js/pages/settings.js";
import { createAlarmScreen } from "./js/components/alarm-screen.js";

const $ = (id) => document.getElementById(id);
const frame = $("clock-frame");
const PAGES = { clock: "The Clock", music: "Music overview", alarms: "Alarm configuration", settings: "Settings" };
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
  for (const page of Object.keys(PAGES)) $(`page-${page}`).hidden = page !== current;
  $(`page-${current}`).tabIndex = -1;
  $(`page-${current}`).focus({ preventScroll: true });
  $("page-position").textContent = `${PAGES[current]}. Swipe up/down or use Page Up/Down to change pages.`;
  document.body.classList.toggle("on-clock", current === "clock");
  if (current !== "clock") document.body.classList.remove("is-night");
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" }, location.origin);
  if (current === "music") musicPage?.update();
}

function changePage(step) {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const pages = Object.keys(PAGES);
  location.hash = pages[(pages.indexOf(current) + step + pages.length) % pages.length];
}

function changeClockView(panel, step) {
  if (!model || alarmScreen?.isOpen || current !== "clock" || !["face", "widget"].includes(panel)) return;
  if (pending) return toast("Please wait for the current save to finish.");
  const views = panel === "face" ? ["analog", "analog-round", "digital"] : ["calendar", "weather", "date", "date-calendar"];
  const value = views[(Math.max(0, views.indexOf(model.config.clock[panel])) + step + views.length) % views.length];
  write("api/settings/clock", { ...model.config.clock, [panel]: value });
}

function renderClock() {
  const options = { ...model.clock };
  document.body.style.setProperty("--clock-night", options.nightColor);
  delete options.error;
  delete options.night_error;
  const live = new Set(["nightActive", "alarm", "weatherConfigured", "weatherPlace", "weatherCondition", "weatherTemperature", "weatherUnit", "weatherDate", "weatherHigh", "weatherLow"]);
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
  notice("clock-error", [model.clock.error, model.clock.night_error].filter(Boolean).join(" "));
  notice("missing-players", model.missing_players.length ? `Missing configured speakers: ${model.missing_players.join(", ")}` : "");
  $("read-only").hidden = !model.read_only;
  renderClock();
  const signature = JSON.stringify([model.music, model.config.locale]);
  if (signature !== musicSignature) {
    ctx.t = makeTranslator(model.config.locale);
    musicPage?.destroy();
    musicPage = createMusicPage(model.music, ctx);
    $("page-music").replaceChildren(musicPage.el);
    musicSignature = signature;
  }
  if (!settingsPages) {
    settingsPages = createSettingsPages(ctx);
    $("page-alarms").append(settingsPages.alarmsEl);
    $("page-settings").append(settingsPages.el);
  }
  if (!nowPlaying) {
    nowPlaying = createNowPlayingScreen(ctx, { enabled: () => false });
    document.body.append(nowPlaying.el);
  }
  musicPage.update();
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
  }
}

frame.addEventListener("load", () => {
  frame.contentWindow?.postMessage({ type: "clock-radio-visibility", visible: current === "clock" && !alarmScreen?.isOpen }, location.origin);
  if (model) frame.contentWindow?.postMessage({ type: "clock-radio-data", options: model.clock }, location.origin);
});
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  if (event.data?.type === "clock-radio-night") document.body.classList.toggle("is-night", current === "clock" && !alarmScreen?.isOpen && event.data.active === true);
  if (![1, -1].includes(event.data?.step)) return;
  if (event.data.type === "clock-radio-page") changePage(event.data.step);
  if (event.data.type === "clock-radio-view") changeClockView(event.data.panel, event.data.step);
});
for (const page of Object.keys(PAGES).filter((page) => page !== "clock")) {
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
