import { RequestError } from "./errors.js";

const DAY = 24 * 60 * 60 * 1000;

export class KioskAuth {
  constructor({ url, token, password = "", fetchImpl = globalThis.fetch, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url, password, fetch: fetchImpl, timeoutMs, now });
    this.token = password ? "" : token;
    this.renewAt = 0;
    this.retryAt = 0;
    this.failures = 0;
    this.error = null;
    this.login = null;
  }

  async getToken() {
    if (!this.password || this.token && this.now() < this.renewAt) return this.token;
    if (this.login) return this.login;
    if (this.now() < this.retryAt) throw this.error;
    this.login = this.authenticate().catch((error) => {
      this.defer(error);
      throw error;
    }).finally(() => { this.login = null; });
    return this.login;
  }

  defer(error) {
    this.error = error;
    this.failures = Math.min(this.failures + 1, 6);
    this.retryAt = this.now() + Math.min(30_000 * 2 ** (this.failures - 1), 15 * 60_000);
  }

  reject(token) {
    if (!this.password || this.token !== token) return;
    this.token = "";
    this.defer(new RequestError("Kiosk Satellite refused the API token. Automatic login will retry shortly; check Remote Administration settings.", 502));
  }

  async authenticate() {
    // Renew a day early, measured from before login rather than response time.
    const started = this.now();
    let response, body;
    try {
      response = await this.fetch(`${this.url}/api/login`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: this.password, ttl_days: 7 }),
      });
      body = await response.text();
    } catch {
      throw new RequestError("Kiosk Satellite login could not be reached or timed out. Automatic login will retry.", 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RequestError("Kiosk Satellite refused the Remote Administration password. Check kiosk_satellite_password in the HA app configuration.", 502);
    }
    if (!response.ok) throw new RequestError(`Kiosk Satellite login failed (HTTP ${response.status}). Automatic login will retry.`, 502);
    let result;
    try {
      if (body.length > 64_000) throw new Error();
      result = JSON.parse(body);
      if (typeof result?.token !== "string" || !result.token || result.token.length > 16_000 || /\s/.test(result.token)) throw new Error();
    } catch {
      throw new RequestError("Kiosk Satellite login returned an invalid token response. Check its Remote Administration version and settings.", 502);
    }
    this.token = result.token;
    this.renewAt = started + 6 * DAY;
    this.retryAt = 0;
    this.failures = 0;
    this.error = null;
    return this.token;
  }
}
