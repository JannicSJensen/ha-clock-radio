import { RequestError } from "./errors.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function versionParts(value) {
  if (typeof value !== "string" || value.length > 64 || !/^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._+-]+)?$/.test(value)) return null;
  const parts = value.match(/\d+/g).slice(0, 3).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function newerKioskVersion(remote, current) {
  const a = versionParts(remote), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function updateState(raw, alarms) {
  if (!object(raw) || !versionParts(raw.currentVersion)
      || raw.availableVersion !== null && !versionParts(raw.availableVersion)
      || raw.progress !== null && (!Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1)
      || raw.installing !== undefined && typeof raw.installing !== "boolean"
      || raw.canRelaunch !== undefined && typeof raw.canRelaunch !== "boolean"
      || raw.silent !== undefined && typeof raw.silent !== "boolean"
      || raw.lastOutcome != null && !["silent", "confirm", "cancelled", "failed", "uptodate"].includes(raw.lastOutcome)
      || !object(alarms) || !["idle", "sunrise", "ringing", "snoozed"].includes(alarms.phase)
      || !Array.isArray(alarms.ids) || alarms.phase === "idle" && alarms.ids.length) {
    throw new RequestError("KS returned invalid update or native alarm status. Check its version and Remote Administration logs.", 502);
  }
  if (raw.availableVersion && !newerKioskVersion(raw.availableVersion, raw.currentVersion)) {
    throw new RequestError("KS advertised an update that is not newer than its installed version. Check its update source.", 502);
  }
  return {
    current_version: raw.currentVersion, available_version: raw.availableVersion,
    progress: raw.progress, installing: raw.installing === true,
    can_relaunch: raw.canRelaunch ?? null, silent: raw.silent ?? null,
    last_outcome: raw.lastOutcome ?? null, alarm_phase: alarms.phase,
  };
}

export class KioskUpdates {
  constructor({ client = null, configurationError = null, logger = console, checkTimeoutMs = 60_000 }) {
    Object.assign(this, { client, configurationError, logger, checkTimeoutMs });
    this.connected = false;
    this.error = null;
    this.checkError = null;
    this.requestError = null;
    this.data = null;
    this.updatedAt = null;
    this.checkedAt = null;
    this.loading = null;
    this.checking = false;
    this.installRequest = false;
    this.pending = null;
    this.completed = false;
    this.epoch = 0;
  }

  snapshot() {
    const state = this.data;
    const running = state?.progress != null || state?.installing;
    return {
      configured: Boolean(this.client), device_id: this.client?.backendId ?? null,
      connected: this.connected, updated_at: this.updatedAt, checked_at: this.checkedAt,
      current_version: state?.current_version ?? null, available_version: state?.available_version ?? null,
      progress: state?.progress ?? null, installing: state?.installing ?? false,
      alarm_phase: this.connected ? state.alarm_phase : "unknown",
      can_relaunch: state?.can_relaunch ?? null, silent: state?.silent ?? null,
      last_outcome: state?.last_outcome ?? null,
      request_state: this.pending ? this.pending.uncertain ? "unknown" : "requested" : this.completed ? "completed" : "idle",
      error: this.configurationError || this.error || this.checkError || this.requestError || null,
      can_check: Boolean(this.client && !this.checking && !this.installRequest && !running),
      can_install: Boolean(this.connected && state?.available_version && state.alarm_phase === "idle"
        && !running && !this.checking && !this.installRequest && !this.pending && !this.checkError && !this.requestError),
    };
  }

  async read() {
    const epoch = this.epoch;
    try {
      const [status, alarms] = await Promise.all([
        this.client.command("getUpdateStatus"), this.client.command("alarmsStatus"),
      ]);
      const state = updateState(status, alarms);
      if (epoch === this.epoch) {
        const previousOutcome = this.data?.last_outcome;
        this.data = state;
        this.connected = true;
        this.error = null;
        this.updatedAt = new Date().toISOString();
        if (state.progress === null && !state.installing && ["failed", "cancelled"].includes(state.last_outcome)
            && (previousOutcome !== state.last_outcome || this.pending?.observed)) {
          this.requestError = "KS reported a failed or cancelled update. Inspect KS and check for updates before manually retrying.";
        }
        if (this.pending) {
          if (state.progress !== null || state.installing) {
            this.pending.observed = true;
            this.pending.uncertain = false;
            this.requestError = null;
          }
          if (newerKioskVersion(state.current_version, this.pending.current)) {
            this.pending = null;
            this.requestError = null;
            this.checkError = null;
            this.completed = true;
          } else if (this.pending.observed && state.progress === null && !state.installing
              && ["failed", "cancelled", "uptodate"].includes(state.last_outcome)) {
            this.pending = null;
          }
        }
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

  refresh() {
    if (!this.client) return Promise.resolve(this.snapshot());
    this.loading ??= this.read().catch(() => this.snapshot()).finally(() => { this.loading = null; });
    return this.loading;
  }

  async check() {
    if (!this.client) throw new RequestError(this.configurationError || "Configure the KS address and Remote Administration password or Remote API token in the HA app options.", 409);
    if (!this.snapshot().can_check) throw new RequestError("A KS update operation is already running. Wait and check its status.", 409);
    this.checking = true;
    this.epoch++;
    try {
      const state = await this.read();
      if (state.progress !== null || state.installing) throw new RequestError("KS is already downloading or installing an update.", 409);
      const result = await this.client.command("checkUpdateNow", {}, false, this.checkTimeoutMs);
      if (!object(result) || typeof result.reachable !== "boolean") throw new RequestError("KS returned an invalid update check result.", 502);
      if (!result.reachable) throw new RequestError("KS could not reach its configured update source. Check the KS network and update-source settings.", 502);
      this.epoch++;
      await this.read();
      this.checkedAt = new Date().toISOString();
      this.checkError = null;
      if (this.data.progress === null && !this.data.installing) {
        this.pending = null;
        this.requestError = null;
        this.completed = false;
      }
    } catch (error) {
      this.checkError = error.message;
      this.logger.warn(error.message);
      throw error;
    } finally { this.checking = false; }
    return this.snapshot();
  }

  async install(body) {
    if (!object(body) || Object.keys(body).some((key) => !["version", "device_id", "confirmed"].includes(key))
        || !versionParts(body.version) || body.confirmed !== true
        || !this.client || body.device_id !== this.client.backendId) {
      throw new RequestError("Confirm an available update for the configured KS device. APK URLs and other command fields are not accepted.");
    }
    if (this.installRequest || this.checking || this.pending) throw new RequestError("A KS update was already requested. Check its status before manually retrying.", 409);
    this.installRequest = true;
    this.epoch++;
    try {
      const state = await this.read();
      if (state.alarm_phase !== "idle") throw new RequestError("Wait until the native KS alarm, sunrise or snooze has ended before updating.", 409);
      if (state.progress !== null || state.installing) throw new RequestError("KS is already downloading or installing an update.", 409);
      if (!state.available_version) throw new RequestError("KS has no newer version available.", 409);
      if (state.available_version !== body.version) throw new RequestError("The available KS version changed. Check again and confirm the new offer.", 409);
      if (this.checkError || this.requestError) throw new RequestError("Check for KS updates again before manually retrying installation.", 409);
      this.pending = { current: state.current_version, uncertain: false, observed: false };
      this.completed = false;
      this.epoch++;
      if (await this.client.command("installUpdate", {}, true) !== true) throw new RequestError("KS did not acknowledge the update request. Check native update status before retrying.", 502);
      this.epoch++;
      return this.snapshot();
    } catch (error) {
      if (this.pending) {
        this.pending.uncertain = true;
        this.requestError = `${error.message} Check KS before manually retrying; installation is never retried automatically.`;
      }
      throw error;
    } finally { this.installRequest = false; }
  }
}
