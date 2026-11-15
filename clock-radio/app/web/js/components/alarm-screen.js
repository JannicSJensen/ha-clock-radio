import { h } from "../core/h.js";
import { icon, setIcon } from "../core/icons.js";
import { pictureUrl } from "../core/api.js";
import { clock, describeMedia, trackPosition } from "../lib/nowplaying.js";
import { createSlideToStop } from "./slide-to-stop.js";

export const alarmKey = (alarm) => alarm ? `${alarm.id}:${alarm.type}:${alarm.player}:${alarm.started_at ?? alarm.finishes_at ?? ""}` : null;
export function ringingTime(options, now = new Date()) {
  const parts = new Intl.DateTimeFormat(options.locale || undefined, {
    hour: "2-digit", minute: "2-digit", timeZone: options.timeZone,
    ...(options.timeFormat === "automatic" ? {} : { hour12: options.timeFormat === "12-hour" }),
  }).formatToParts(now);
  return {
    time: parts.filter((part) => ["hour", "literal", "minute"].includes(part.type)).map((part) => part.value).join("").trim(),
    period: parts.find((part) => part.type === "dayPeriod")?.value ?? "",
  };
}

export function createAlarmScreen(ctx, { onOpen, onClose }) {
  let active = null;
  let timer = null;
  let action = null;
  let confirmation = null;
  let busy = false;
  let error = "";
  let artwork = null;
  const heading = h("h1", { class: "ringing__label", id: "ringing-title", tabindex: "-1" }, icon("alarm"), "Alarm");
  const time = h("span", { class: "ringing__time" });
  const period = h("span", { class: "ringing__period" });
  const context = h("p", { class: "ringing__context" });
  const art = h("div", { class: "ringing-player__art" });
  const title = h("div", { class: "ringing-player__title" });
  const subtitle = h("div", { class: "ringing-player__subtitle" });
  const playIcon = icon("pause");
  const previous = h("button", { type: "button", "aria-label": "Previous track" }, icon("skip-previous"));
  const play = h("button", { type: "button", "aria-label": "Pause alarm music" }, playIcon);
  const next = h("button", { type: "button", "aria-label": "Next track" }, icon("skip-next"));
  const progress = h("progress", { max: "100", value: "0", "aria-label": "Alarm music playback position" });
  const elapsed = h("span", { class: "ringing-player__elapsed" });
  const volume = h("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": "Alarm music volume" });
  const miniPlayer = h("section", { class: "ringing-player", "aria-label": "Alarm music player" },
    h("div", { class: "ringing-player__media" }, art, h("div", { class: "ringing-player__text" }, title, subtitle)),
    h("div", { class: "ringing-player__progress" }, progress, elapsed),
    h("div", { class: "ringing-player__controls" }, previous, play, next),
    h("label", { class: "ringing-player__volume" }, icon("volume-high"), volume));
  const snooze = h("button", { class: "ringing__snooze", type: "button" }, "Snooze");
  const snoozeHint = h("p", { class: "ringing__hint" });
  const status = h("p", { class: "ringing__status", role: "status", "aria-live": "polite" });
  const slide = createSlideToStop(() => mutate("stop"));
  const el = h("dialog", { class: "ringing", role: "dialog", "aria-labelledby": "ringing-title" },
    h("div", { class: "ringing__layout" }, heading,
      h("div", { class: "ringing__clock" }, time, period), context, miniPlayer,
      h("div", { class: "ringing__actions" }, snooze, snoozeHint, slide.el, status)));
  el.addEventListener("cancel", (event) => event.preventDefault());

  function clearAction() {
    clearTimeout(confirmation);
    confirmation = null;
    action = null;
    slide.reset();
  }
  async function mutate(kind, data = {}) {
    if (!active || action || busy || !ctx.canControl()) return;
    const key = alarmKey(active);
    action = kind;
    error = "";
    paint();
    const ok = await (["stop", "snooze"].includes(kind)
      ? ctx.write(`api/alarm/${kind}`, {})
      : ctx.call("media_player", kind, active.player, data));
    if (alarmKey(active) !== key || !el.open) return;
    if (!ok) {
      error = ctx.writeError() || "The alarm command failed. Please try again.";
      clearAction();
    } else if (["stop", "snooze"].includes(kind)) {
      confirmation = setTimeout(() => {
        error = "Home Assistant has not confirmed the alarm ended. Check the HA scripts and try again.";
        clearAction();
        paint();
      }, 15000);
    } else clearAction();
    paint();
  }
  snooze.addEventListener("click", () => mutate("snooze"));
  previous.addEventListener("click", () => mutate("media_previous_track"));
  play.addEventListener("click", () => mutate("media_play_pause"));
  next.addEventListener("click", () => mutate("media_next_track"));
  volume.addEventListener("change", () => mutate("volume_set", { volume_level: Number(volume.value) / 100 }));

  function paintClock() {
    if (!active) return;
    const parts = ringingTime(ctx.getModel().clock);
    time.textContent = parts.time;
    period.textContent = parts.period;
    const player = ctx.getState(active.player);
    const position = trackPosition(player?.attributes, player?.state);
    progress.parentElement.hidden = !position;
    if (position) {
      progress.max = position.duration;
      progress.value = position.position;
      elapsed.textContent = `${clock(position.position)} / ${clock(position.duration)}`;
    }
  }
  function paint() {
    if (!active) return;
    const model = ctx.getModel();
    const locked = busy || Boolean(action) || !ctx.canControl();
    const player = ctx.getState(active.player);
    const attrs = player?.attributes ?? {};
    const supports = (flag) => Boolean((player?.supported_features ?? 0) & flag);
    const unavailable = !player || ["unavailable", "unknown"].includes(player.state);
    miniPlayer.hidden = active.type !== "Music";
    context.textContent = `${active.type} alarm`;
    const media = describeMedia(attrs, ctx.stations());
    title.textContent = media.title || "Alarm music";
    subtitle.textContent = unavailable ? "Speaker unavailable" : [media.subtitle, player.name, player.state === "paused" ? "Paused" : ""].filter(Boolean).join(" · ");
    const picture = pictureUrl(attrs.entity_picture);
    if (picture !== artwork) {
      artwork = picture;
      art.replaceChildren(picture ? h("img", { src: picture, alt: "" }) : icon("music"));
    }
    play.setAttribute("aria-label", player?.state === "paused" ? "Play alarm music" : "Pause alarm music");
    setIcon(playIcon, player?.state === "paused" ? "play" : "pause");
    previous.disabled = locked || unavailable || !supports(16);
    next.disabled = locked || unavailable || !supports(32);
    play.disabled = locked || unavailable || !supports(player?.state === "paused" ? 16384 : 1);
    volume.disabled = locked || unavailable || !supports(4) || !Number.isFinite(player?.volume_level);
    if (document.activeElement !== volume && Number.isFinite(player?.volume_level)) volume.value = String(Math.round(player.volume_level * 100));
    snooze.disabled = locked || !model.alarms.can_snooze;
    snoozeHint.textContent = model.alarms.can_snooze ? "Ring again in 10 minutes"
      : Number(model.alarms.scheduler_version) >= 6 ? "Snooze is unavailable. Check the HA alarm scripts and helpers."
      : "Update the HA alarm package to scheduler version 6 for reliable Snooze.";
    slide.setDisabled(locked || !model.alarms.can_stop);
    const policyMessage = !model.connected ? "Disconnected. Reconnect to stop or snooze the alarm."
      : model.read_only ? "Read-only. Use Home Assistant to stop or snooze the alarm."
      : "";
    status.textContent = [error, policyMessage].filter(Boolean).join(" ") || (action === "stop" ? "Waiting for Home Assistant to stop the alarm..."
      : action === "snooze" ? "Waiting for Home Assistant to snooze the alarm..."
      : action ? "Updating music..."
      : !model.alarms.can_stop ? "The HA alarm stop script is unavailable." : "");
    paintClock();
  }
  function update(model, pending) {
    busy = pending;
    const nextActive = model.alarms.backend === "kiosk_satellite" ? null : model.connected ? model.alarms.active : active;
    if (!nextActive) {
      if (el.open) {
        clearAction();
        clearInterval(timer);
        timer = null;
        active = null;
        el.removeAttribute("aria-modal");
        el.close();
        onClose();
      }
      return;
    }
    if (alarmKey(nextActive) !== alarmKey(active)) {
      clearAction();
      error = "";
    }
    active = nextActive;
    if (!el.open) {
      onOpen();
      el.setAttribute("aria-modal", "true");
      el.showModal();
      timer = setInterval(paintClock, 1000);
      paint();
      (snooze.disabled ? heading : snooze).focus();
    } else paint();
  }
  return { el, update, get isOpen() { return el.open; } };
}
