const $ = (id) => document.getElementById(id);
let model;
let selected = "";
let busy = false;
let stationSignature = "";
let clockSignature = "";
let timeFormatter;
let dateFormatter;

function notice(id, message) {
  $(id).textContent = message ?? "";
  $(id).hidden = !message;
}

function clock() {
  const now = new Date();
  $("clock").textContent = (timeFormatter ?? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(now);
  $("clock").dateTime = now.toISOString();
  if (dateFormatter) $("date").textContent = dateFormatter.format(now);
}

function render() {
  const config = model.config;
  document.title = config.title;
  document.documentElement.lang = config.locale;
  $("dashboard-title").textContent = config.title;
  $("version").textContent = `v${model.version}`;
  $("demo-notice").hidden = !model.demo;
  $("connection").textContent = model.connected ? (model.demo ? "Demo connected" : "Connected") : "Disconnected";
  $("connection").classList.toggle("online", model.connected);
  notice("connection-error", model.connection_error);
  notice("config-error", model.config_error);
  notice("missing-players", model.missing_players.length ? `Missing configured speakers: ${model.missing_players.join(", ")}` : "");
  const nextClockSignature = JSON.stringify([config.locale, config.time_zone, config.clock_24h, config.show_seconds]);
  if (clockSignature !== nextClockSignature) {
    document.querySelector(".clock-panel").classList.toggle("long-time", config.show_seconds || !config.clock_24h);
    const zone = config.time_zone ? { timeZone: config.time_zone } : {};
    timeFormatter = new Intl.DateTimeFormat(config.locale, { ...zone, hour: "2-digit", minute: "2-digit", ...(config.show_seconds ? { second: "2-digit" } : {}), hourCycle: config.clock_24h ? "h23" : "h12" });
    dateFormatter = new Intl.DateTimeFormat(config.locale, { ...zone, weekday: "long", day: "numeric", month: "long" });
    $("time-zone").textContent = timeFormatter.resolvedOptions().timeZone.replaceAll("_", " ");
    clockSignature = nextClockSignature;
    clock();
  }
  if (!model.players.some((player) => player.entity_id === selected)) {
    selected = model.players.find((player) => player.entity_id === config.default_player)?.entity_id
      ?? model.players.find((player) => !["unavailable", "unknown"].includes(player.state))?.entity_id
      ?? model.players[0]?.entity_id ?? "";
  }
  const speaker = $("speaker");
  const playerSignature = JSON.stringify(model.players.map(({ entity_id, name }) => [entity_id, name]));
  if (speaker.dataset.signature !== playerSignature) {
    speaker.replaceChildren(...(model.players.length
      ? model.players.map((player) => new Option(player.name, player.entity_id))
      : [new Option("No speakers found", "")]));
    speaker.dataset.signature = playerSignature;
  }
  speaker.value = selected;
  const player = model.players.find((item) => item.entity_id === selected);
  const disabled = busy || model.read_only || !model.connected || !player || ["unavailable", "unknown"].includes(player.state);
  const supports = (feature) => Boolean((player?.supported_features ?? 0) & feature);
  $("track-title").textContent = player?.title || "Choose a station";
  $("track-artist").textContent = player?.artist || player?.name || "Your radio, through Home Assistant.";
  $("player-state").textContent = player ? player.state.toUpperCase() : "READY WHEN YOU ARE";
  $("play-pause").textContent = player?.state === "playing" ? "Pause" : "Play";
  $("play-pause").disabled = disabled || !supports(player?.state === "playing" ? 1 : 16384);
  $("stop").disabled = disabled || !supports(4096);
  $("volume").disabled = disabled || !supports(4);
  if (document.activeElement !== $("volume")) {
    $("volume").value = Math.round((player?.volume_level ?? 0) * 100);
    $("volume-value").textContent = player?.volume_level == null ? "--" : `${$("volume").value}%`;
  }
  speaker.disabled = busy || !model.players.length;
  const nextSignature = JSON.stringify(config.stations);
  if (stationSignature !== nextSignature) {
    $("stations").replaceChildren(...config.stations.map((station, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "station";
      const number = document.createElement("span");
      number.textContent = `PRESET ${String(index + 1).padStart(2, "0")}`;
      const label = document.createElement("strong");
      label.textContent = station.name;
      button.append(number, label);
      button.addEventListener("click", () => command({ action: "play_station", station_id: station.id }));
      return button;
    }));
    stationSignature = nextSignature;
  }
  for (const button of $("stations").children) button.disabled = disabled || !supports(512);
  $("empty-stations").hidden = Boolean(config.stations.length);
  $("empty-players").hidden = Boolean(model.players.length);
  $("read-only").hidden = !model.read_only;
}

async function poll() {
  try {
    const response = await fetch("./api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard request failed (HTTP ${response.status}).`);
    model = await response.json();
    render();
  } catch (error) {
    if (model) {
      model.connected = false;
      model.connection_error = `Dashboard connection lost: ${error.message}`;
      render();
    } else {
      notice("connection-error", `Cannot reach the dashboard: ${error.message}`);
      $("connection").textContent = "Disconnected";
    }
  }
}

async function command(body) {
  if (busy) return;
  busy = true;
  notice("command-error", "");
  notice("command-status", "Sending command...");
  render();
  try {
    const response = await fetch("./api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, entity_id: selected }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Command failed (HTTP ${response.status}).`);
    notice("command-status", "Command sent.");
    await poll();
  } catch (error) {
    notice("command-status", "");
    notice("command-error", error.message);
  } finally {
    busy = false;
    render();
  }
}

$("speaker").addEventListener("change", (event) => { selected = event.target.value; render(); });
$("play-pause").addEventListener("click", () => command({ action: model.players.find((player) => player.entity_id === selected)?.state === "playing" ? "media_pause" : "media_play" }));
$("stop").addEventListener("click", () => command({ action: "media_stop" }));
$("volume").addEventListener("input", () => { $("volume-value").textContent = `${$("volume").value}%`; });
$("volume").addEventListener("change", () => command({ action: "volume_set", volume_level: Number($("volume").value) / 100 }));
$("night-mode").addEventListener("click", () => {
  const night = document.body.classList.toggle("night");
  $("night-mode").setAttribute("aria-pressed", String(night));
});
clock();
setInterval(clock, 1000);
await poll();
setInterval(poll, 5000);
