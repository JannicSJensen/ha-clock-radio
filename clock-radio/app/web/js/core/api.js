import { ui, uiFormat } from "../lib/ui-language.js";

export async function getJson(url, options = {}) {
  const { timeout = 30_000, signal, ...request } = options;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Request timeout must be a positive number.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    const response = await fetch(`./${url}`, { cache: "no-store", ...request, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error != null ? ui(data.error) : uiFormat("Request failed (HTTP {status}).", { status: response.status }));
    return data;
  } catch (error) {
    if (timedOut) {
      const uncertain = request.method === "POST" ? ui(" The change may still complete. Check saved values before retrying.") : "";
      throw new Error(uiFormat("Request timed out after {seconds} seconds.", { seconds: timeout / 1000 }) + uncertain);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function postJson(url, data) {
  const timeout = url === "api/kiosk/update/check" ? 75_000 : /^api\/alarm\/(?:create|delete)$/.test(url) ? 120_000 : 30_000;
  return getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), timeout });
}

export function pictureUrl(value) {
  if (typeof value !== "string" || !/^api\/(player|music)\/image\//.test(value)) return "";
  return `./${value}`;
}
