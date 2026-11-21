import crypto from "node:crypto";
import { RequestError } from "./errors.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const dimSettings = {
  "screensaver.timeout_seconds": 600,
  "screensaver.dim_level": 0.1,
  "screensaver.screen_off_minutes": 0,
  "screensaver.dismiss_on_proximity": true,
  "screensaver.postpone_on_proximity": true,
  "screensaver.dismiss_on_proximity_screen_off_only": false,
  "screensaver.mode": "dim",
  "screensaver.enabled": true,
};
const guards = { "screensaver.schedule_enabled": false, "lockdown.enabled": false };
const keys = Object.keys({ ...dimSettings, ...guards });

function nativeState(raw, support, alarms) {
  if (!object(raw) || !Array.isArray(raw.settings) || raw.settings.length > 10000
      || !object(support) || typeof support.supported !== "boolean"
      || !object(alarms) || !["idle", "sunrise", "ringing", "snoozed"].includes(alarms.phase)
      || !Array.isArray(alarms.ids) || alarms.phase === "idle" && alarms.ids.length) {
    throw new RequestError("KS returned invalid proximity dimming status. Check its version and Remote Administration logs.", 502);
  }
  const values = {};
  for (const item of raw.settings) {
    if (!object(item) || !keys.includes(item.key)) continue;
    if (Object.hasOwn(values, item.key)) throw new RequestError("KS returned duplicate display settings.", 502);
    values[item.key] = item.value;
  }
  for (const [key, example] of Object.entries({ ...dimSettings, ...guards })) {
    const value = values[key];
    if (typeof value !== typeof example || typeof value === "number" && (!Number.isFinite(value) || value < 0)
        || key === "screensaver.dim_level" && value > 1 || key === "screensaver.mode" && (!value || value.length > 128)) {
      throw new RequestError("KS lacks valid native proximity dimming settings. Update KS or check its settings.", 502);
    }
  }
  return {
    values, supported: support.supported, alarm_phase: alarms.phase,
    revision: crypto.createHash("sha256").update(JSON.stringify(keys.map((key) => [key, values[key]]))).digest("hex"),
    enabled: values["screensaver.enabled"] && values["screensaver.mode"] === "dim",
    ready: support.supported && Object.entries({ ...dimSettings, ...guards }).every(([key, value]) => values[key] === value),
  };
}

export class KioskDimming {
  constructor({ client = null, configurationError = null, logger = console } = {}) {
    Object.assign(this, { client, configurationError, logger });
    this.connected = false;
    this.error = null;
    this.data = null;
    this.loading = null;
    this.busy = false;
    this.epoch = 0;
    this.checkedAt = 0;
  }

  snapshot() {
    const state = this.data;
    const conflict = state?.values["screensaver.schedule_enabled"] ? "KS screensaver schedules can override dimming. Disable or adjust them in KS before configuring this feature."
      : state?.values["lockdown.enabled"] ? "KS lockdown blocks proximity wake. Turn off lockdown before configuring dimming."
      : state && !state.supported ? "KS reports no supported proximity sensor. Check its device settings; call-only palm sensors may not detect movement."
      : null;
    return {
      configured: Boolean(this.client), device_id: this.client?.backendId ?? null,
      connected: this.connected, revision: state?.revision ?? null,
      supported: state?.supported ?? false, enabled: state?.enabled ?? false, ready: state?.ready ?? false,
      alarm_phase: this.connected ? state.alarm_phase : "unknown",
      native_mode: state?.values["screensaver.mode"] === "dim" ? "dim" : "other",
      can_configure: Boolean(this.connected && !this.busy && state.alarm_phase === "idle"
        && !state.values["screensaver.schedule_enabled"] && !state.values["lockdown.enabled"] && (state.supported || state.enabled)),
      error: this.configurationError || this.error || conflict || null,
    };
  }

  async read() {
    const epoch = this.epoch;
    try {
      const [raw, support, alarms] = await Promise.all([
        this.client.settings(), this.client.command("getProximitySupport"), this.client.command("alarmsStatus"),
      ]);
      const state = nativeState(raw, support, alarms);
      if (epoch === this.epoch) {
        this.data = state;
        this.connected = true;
        this.error = null;
        this.checkedAt = Date.now();
      }
      return state;
    } catch (error) {
      if (epoch === this.epoch) {
        this.connected = false;
        if (this.error !== error.message) this.logger.warn(error.message);
        this.error = error.message;
      }
      throw error;
    }
  }

  refresh(force = false) {
    if (!this.client) return Promise.resolve(this.snapshot());
    if (!force && this.connected && Date.now() - this.checkedAt < 60_000) return Promise.resolve(this.snapshot());
    this.loading ??= this.read().catch(() => this.snapshot()).finally(() => { this.loading = null; });
    return this.loading;
  }

  async save(body) {
    if (!object(body) || Object.keys(body).some((key) => !["enabled", "device_id", "revision"].includes(key))
        || typeof body.enabled !== "boolean" || !this.client || body.device_id !== this.client.backendId
        || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
      throw new RequestError("Choose proximity dimming for the configured KS device. Arbitrary settings and brightness commands are not accepted.");
    }
    if (this.busy) throw new RequestError("KS display settings are already being saved.", 409);
    this.busy = true;
    this.epoch++;
    try {
      const state = await this.read();
      if (state.revision !== body.revision) throw new RequestError("KS display settings changed. Reload values before saving.", 409);
      if (state.alarm_phase !== "idle") throw new RequestError("Wait until the native KS alarm, sunrise or snooze ends before changing dimming.", 409);
      if (state.values["screensaver.schedule_enabled"] || state.values["lockdown.enabled"]) throw new RequestError(this.snapshot().error, 409);
      if (body.enabled && !state.supported) throw new RequestError("KS has no supported proximity sensor.", 409);
      if (body.enabled || state.enabled) {
        const values = body.enabled ? dimSettings : { "screensaver.enabled": false };
        await this.client.settings(values);
        this.epoch++;
        const saved = await this.read();
        if (!Object.entries(values).every(([key, value]) => saved.values[key] === value)) {
          throw new RequestError("KS did not retain the proximity dimming settings. Inspect KS and reload values before retrying.", 502);
        }
      }
    } catch (error) {
      this.error = error.message;
      this.logger.warn(error.message);
      throw error;
    } finally { this.busy = false; }
    return this.snapshot();
  }
}
