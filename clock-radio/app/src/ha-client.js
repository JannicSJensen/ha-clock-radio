import WebSocket from "ws";
import { ALARM_SOUNDS, soundMediaPath } from "../web/js/lib/alarm-sounds.js";
import { RequestError } from "./errors.js";

export class HAClient {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("HA_URL must be an HTTP(S) URL without credentials, query or fragment.");
    }
    if (!token) throw new Error("A Home Assistant token is required.");
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(apiPath, body, { timeout = 8000 } = {}) {
    const response = await this.fetch(`${this.url}/api/${apiPath}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Home Assistant request failed (HTTP ${response.status}).`);
    return response.json();
  }

  async states() {
    const states = await this.request("states");
    if (!Array.isArray(states) || !states.every((state) => state && typeof state.entity_id === "string" && typeof state.state === "string")) {
      throw new Error("Home Assistant returned an invalid state list.");
    }
    return states;
  }

  callService(domain, service, data, options) {
    return this.request(`services/${domain}/${service}`, data, options);
  }

  async callServiceWithResponse(domain, service, data) {
    const result = await this.request(`services/${domain}/${service}?return_response`, data);
    if (!result || typeof result.service_response !== "object") throw new Error("Home Assistant did not return the requested service response.");
    return result.service_response;
  }

  async timeZone() {
    const config = await this.request("config");
    if (typeof config.time_zone !== "string") throw new Error("Home Assistant did not return its time zone.");
    new Intl.DateTimeFormat("en", { timeZone: config.time_zone });
    return config.time_zone;
  }

  async alarmSoundUrl(id) {
    if (!ALARM_SOUNDS.some((sound) => sound.id === id)) throw new RequestError("Unknown built-in alarm sound.");
    const config = await this.request("config");
    const base = config.internal_url || config.external_url;
    if (typeof base !== "string" || !URL.canParse(base)) throw new RequestError("Set a speaker-accessible Home Assistant internal URL in Settings > System > Network before choosing a built-in sound.", 409);
    const parsed = new URL(base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new RequestError("The Home Assistant URL for alarm sounds must be HTTP(S), without credentials, query or fragment.", 409);
    }
    const url = `${base.replace(/\/+$/, "")}${soundMediaPath(id)}`;
    const response = await this.fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/")) {
      throw new RequestError("The built-in sound is not accessible through Home Assistant. Update/restart Clock Radio to install sounds, check the HA internal URL and restart HA once if its www folder is new.", 409);
    }
    return url;
  }

  requestWs(message) {
    const base = new URL(this.url);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = base.pathname.replace(/\/+$/, "") + (this.url === "http://supervisor/core" ? "/websocket" : "/api/websocket");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base);
      const finish = (error, result) => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.close();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Home Assistant WebSocket request timed out.")), 8000);
      ws.on("error", (error) => finish(new Error(`Home Assistant WebSocket failed: ${error.message}`)));
      ws.on("close", () => finish(new Error("Home Assistant closed the WebSocket before answering.")));
      ws.on("message", (raw) => {
        let reply;
        try { reply = JSON.parse(raw.toString()); }
        catch { return finish(new Error("Home Assistant returned invalid WebSocket JSON.")); }
        if (reply.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
        else if (reply.type === "auth_invalid") finish(new Error("Home Assistant rejected the access token."));
        else if (reply.type === "auth_ok") ws.send(JSON.stringify({ ...message, id: 1 }));
        else if (reply.type === "result" && reply.id === 1) {
          if (reply.success) finish(null, reply.result);
          else finish(new Error(reply.error?.message ?? "Home Assistant WebSocket request failed."));
        }
      });
    });
  }
}
