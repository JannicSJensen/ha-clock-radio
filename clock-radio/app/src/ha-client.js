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

  async request(apiPath, body) {
    const response = await this.fetch(`${this.url}/api/${apiPath}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
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

  callService(domain, service, data) {
    return this.request(`services/${domain}/${service}`, data);
  }
}
