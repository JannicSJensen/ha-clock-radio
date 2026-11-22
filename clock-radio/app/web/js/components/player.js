import { pictureUrl } from "../core/api.js";
import { h } from "../core/h.js";
import { icon, setIcon } from "../core/icons.js";
import { createSlider } from "../core/slider.js";
import { isUnavailable } from "../lib/format.js";
import { format } from "../lib/i18n.js";
import { throttle } from "../lib/throttle.js";
import { pressable } from "../tiles/common.js";

const bg = (url) => `url("${String(url).replace(/"/g, "%22")}")`;
const volumeIcon = (level) => level === 0 ? "volume-off" : level < .34 ? "volume-low" : level < .67 ? "volume-medium" : "volume-high";
const mediaKey = (state) => `${state?.state}|${state?.attributes?.media_content_id}|${state?.attributes?.media_title}`;

export function clockPlayerId(model) {
  const id = model.music.default_player;
  if (!id || !model.connected || model.alarms.active || model.alarms.snoozed) return null;
  return model.players.some((player) => player.entity_id === id && player.state === "playing") ? id : null;
}

export function createPlayerPanel({ model, ctx }) {
  const { t, getState } = ctx;
  const selected = model.default_player;
  const target = () => selected && !isUnavailable(getState(selected)) ? selected : null;
  const player = () => getState(selected);
  const nameOf = (id) => getState(id)?.attributes?.friendly_name ?? id;
  let pending = null;
  let touchedVolumeAt = 0;
  const head = h("header", { class: "music__head" }, h("h1", { class: "radio__title" }, model.title));
  if (!selected) head.append(h("p", { class: "view__hint" }, "Choose media_player in the Home Assistant app configuration."));
  const art = h("div", { class: "np__art", role: "button", tabindex: "0", "aria-label": t("np_playing") }, icon("arrow-expand"));
  const title = h("div", { class: "np__title" });
  const sub = h("div", { class: "np__sub" });
  const textBox = h("div", { class: "np__text", role: "button", tabindex: "0", "aria-label": t("np_playing") }, title, sub);
  const playIcon = icon("play");
  const play = h("button", { class: "np__play", type: "button", "aria-label": t("np_play") }, playIcon);
  pressable(play, { onTap: () => target() && ctx.call("media_player", "media_play_pause", target()) });
  const volIcon = icon("volume-medium"), volValue = h("span", { class: "np__volvalue" });
  const sendVolume = throttle((value) => target() && ctx.call("media_player", "volume_set", target(), { volume_level: value / 100 }), 250);
  const volume = createSlider({
    label: t("volume"), orientation: "horizontal", min: 0, max: 100, step: 1, value: 0,
    onInput(value) {
      touchedVolumeAt = Date.now();
      volValue.textContent = `${value}%`;
      sendVolume(value);
    },
    onCommit(value) {
      touchedVolumeAt = Date.now();
      sendVolume.cancel();
      if (target()) ctx.call("media_player", "volume_set", target(), { volume_level: value / 100 });
    },
  });
  const bar = h("footer", { class: "np" }, art, textBox, play,
    h("div", { class: "np__volume", title: t("volume") }, volIcon, h("div", { class: "np__slider" }, volume.el), volValue));
  const openFull = () => { if (bar.classList.contains("is-openable")) ctx.openNowPlaying?.(selected); };
  for (const el of [art, textBox]) pressable(el, { onTap: openFull });

  function clearPending() { clearTimeout(pending?.timer); pending = null; }
  function setPending({ name, image }) {
    clearPending();
    pending = { name, image, key: mediaKey(player()), timer: setTimeout(() => { clearPending(); update(); }, 10000) };
    update();
  }
  function update() {
    const state = player(), attrs = state?.attributes ?? {}, control = target();
    const idle = !control || !["playing", "paused", "buffering"].includes(state.state);
    if (pending && mediaKey(state) !== pending.key && ["playing", "buffering"].includes(state?.state)) clearPending();
    const picture = pending ? pending.image : attrs.entity_picture ? pictureUrl(attrs.entity_picture) : "";
    art.style.backgroundImage = picture ? bg(picture) : "";
    art.classList.toggle("has-art", Boolean(picture));
    title.textContent = pending ? pending.name : idle ? t("nothing_playing") : attrs.media_title ?? "";
    sub.textContent = [!pending && !idle ? attrs.media_artist : null, selected ? format(t, "on_speaker", { name: nameOf(selected) }) : null].filter(Boolean).join(" · ");
    const playing = state?.state === "playing";
    setIcon(playIcon, playing ? "pause" : "play");
    play.setAttribute("aria-label", t(playing ? "np_pause" : "np_play"));
    play.disabled = idle || !ctx.canControl();
    bar.classList.toggle("is-openable", !idle && !pending);
    for (const el of [art, textBox]) {
      el.setAttribute("aria-disabled", String(idle || Boolean(pending)));
      el.tabIndex = idle || pending ? -1 : 0;
    }
    volume.setDisabled(!control || !ctx.canControl() || !(Number(attrs.supported_features) & 4));
    const level = attrs.volume_level;
    bar.classList.toggle("no-volume", !Number.isFinite(level));
    if (Number.isFinite(level)) {
      setIcon(volIcon, volumeIcon(level));
      if (Date.now() - touchedVolumeAt > 1200) {
        volume.setValue(Math.round(level * 100));
        volValue.textContent = `${Math.round(level * 100)}%`;
      }
    }
  }
  return { head, bar, target, player, nameOf, update, setPending, clearPending: () => { clearPending(); update(); },
    destroy() { clearPending(); sendVolume.cancel(); } };
}
