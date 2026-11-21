const managed = (id) => typeof id === "string" && /^clock-radio-[a-f0-9]{32}$/.test(id);
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const key = (context) => JSON.stringify(context);

export function validNativeRing(value) {
  const c = value?.context;
  return value?.ok === true && value.version === 1 && /^[a-f0-9]{32}$/.test(value.device)
    && c && ["idle", "sunrise", "ringing", "snoozed"].includes(c.phase)
    && Array.isArray(c.ids) && new Set(c.ids).size === c.ids.length && c.ids.every(managed)
    && Number.isSafeInteger(c.generation) && c.generation >= 0
    && (["idle", "sunrise"].includes(c.phase) || c.ids.length > 0 && stamp(c.at))
    && (c.phase !== "snoozed" || stamp(c.snoozedUntil))
    && Number.isInteger(value.snoozeMinutes) && value.snoozeMinutes > 0 && value.snoozeMinutes <= 120
    && Array.isArray(value.alarms) && value.alarms.length === c.ids.length
    && value.alarms.every((alarm, index) => alarm?.id === c.ids[index] && ["Music", "Buzzer"].includes(alarm.type)
      && ["label", "station", "speaker"].every((field) => typeof alarm[field] === "string" && alarm[field].length <= 4096));
}

export class KioskAlarmUI {
  constructor({ getModel, render, afterPaint, bridge = () => globalThis.kioskSatellite,
    visible = () => globalThis.document?.visibilityState === "visible", warn = (message) => console.warn(message), timeoutMs = 2500 }) {
    Object.assign(this, { getModel, render, afterPaint, bridge, visible, warn, timeoutMs });
    this.state = null;
    this.lease = null;
    this.error = "";
    this.running = null;
    this.action = false;
    this.epoch = 0;
  }

  eligible(model = this.getModel()) {
    const p = model?.alarms.presentation;
    return model?.alarms.backend === "kiosk_satellite" && model.alarms.connected
      && !model.read_only && !model.offline_snapshot && p?.requested && p.supported && p.enabled;
  }

  get message() {
    const model = this.getModel();
    const p = model?.alarms.presentation;
    if (!p?.requested) return "";
    if (!p.supported) return "Clock ringing UI needs KS dashboard-alarm support. Native controls remain enabled.";
    if (!p.enabled) return "Set Dashboard alarm UI URL in KS to enable the Clock ringing screen.";
    return this.error || (typeof this.bridge()?.alarmUi === "function"
      ? ""
      : "Open Clock Radio on the configured KS device to use its Clock ringing UI.");
  }

  async call(action, context) {
    const bridge = this.bridge();
    if (typeof bridge?.alarmUi !== "function") throw new Error("The native KS alarm bridge is unavailable.");
    let timer;
    try {
      const result = await Promise.race([
        bridge.alarmUi(action, context),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("KS alarm UI timed out. Native controls will return; check KS before retrying.")), this.timeoutMs); }),
      ]);
      if (result?.ok !== true) throw new Error(`KS alarm UI refused ${action}: ${result?.error ?? "invalid response"}. Native controls remain available.`);
      return result;
    } finally { clearTimeout(timer); }
  }

  async release() {
    this.epoch++;
    const leased = this.lease;
    this.lease = null;
    this.state = null;
    if (leased) {
      try { await this.call("release", leased); }
      catch (error) { this.warn(error.message); }
    }
  }

  refresh() {
    this.running ??= this.sync().finally(() => { this.running = null; });
    return this.running;
  }

  async sync() {
    if (this.action) return;
    if (!this.eligible() || !this.visible() || typeof this.bridge()?.alarmUi !== "function") {
      await this.release();
      this.render();
      return;
    }
    const epoch = this.epoch;
    try {
      const state = await this.call("status");
      if (epoch !== this.epoch) return;
      if (!validNativeRing(state)) throw new Error("KS alarm group is unsupported or contains unrelated alarms. Use the native KS controls.");
      if (state.device !== this.getModel().alarms.presentation.device) throw new Error("This KS device is not the configured alarm backend. Use its native controls.");
      this.state = state;
      this.error = "";
      this.render();
      if (state.context.phase !== "ringing") {
        if (this.lease) {
          await this.call("release", this.lease);
          this.lease = null;
        }
        return;
      }
      if (!await this.afterPaint()) throw new Error("Clock Radio could not show usable ringing controls. Use the native KS screen.");
      if (epoch !== this.epoch || !this.eligible() || !this.visible()) return;
      const result = await this.call("present", state.context);
      if (epoch !== this.epoch) {
        await this.call("release", state.context);
        return;
      }
      if (!validNativeRing(result) || result.device !== state.device || key(result.context) !== key(state.context)) {
        throw new Error("KS alarm changed before presentation was confirmed. Use the native controls.");
      }
      this.lease = state.context;
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (this.error !== error.message) this.warn(error.message);
      this.error = error.message;
      await this.release();
      this.render();
    }
  }

  apply(model) {
    if (model?.alarms.backend !== "kiosk_satellite") return model;
    const alarms = { ...model.alarms, active: null, snoozed: null, can_stop: false, can_snooze: false };
    const state = this.state;
    if (state && this.eligible(model) && this.visible() && state.device === alarms.presentation.device) {
      const c = state.context;
      alarms.native_phase = c.phase;
      const first = state.alarms[0];
      const alarm = first && {
        id: first.id, type: first.type, player: "", backend: "kiosk_satellite", native_context: c,
        label: state.alarms.map((alarm) => alarm.label).filter(Boolean).join(" · "),
        station: first.station, speaker: first.speaker, snooze_minutes: state.snoozeMinutes,
        started_at: c.at, ...(c.phase === "snoozed" ? { until: c.snoozedUntil } : {}),
      };
      if (c.phase === "ringing") alarms.active = alarm;
      if (c.phase === "snoozed") alarms.snoozed = alarm;
      alarms.can_stop = Boolean(alarms.active || alarms.snoozed);
      alarms.can_snooze = Boolean(alarms.active);
    }
    return { ...model, alarms };
  }

  async control(action, context) {
    if (!["stop", "snooze"].includes(action) || !this.eligible() || !this.visible() || this.action
        || !this.state || key(context) !== key(this.state.context)) throw new Error("This native alarm changed or its controls are unavailable.");
    this.action = true;
    this.epoch++;
    const device = this.state.device;
    try {
      const result = await this.call(action, context);
      if (!validNativeRing(result) || result.device !== device) throw new Error("KS has not confirmed the alarm action. Check its native controls before retrying.");
      this.state = result;
      this.lease = null;
      this.error = "";
      this.render();
      return true;
    } catch (error) {
      this.warn(error.message);
      this.error = error.message;
      await this.release();
      this.render();
      throw error;
    } finally { this.action = false; }
  }
}
