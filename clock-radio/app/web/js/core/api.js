export async function getJson(url, options = {}) {
  const response = await fetch(`./${url}`, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (HTTP ${response.status}).`);
  return data;
}

export function postJson(url, data) {
  return getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

export function pictureUrl(value) {
  if (typeof value !== "string" || !/^api\/(player|music)\/image\//.test(value)) return "";
  return `./${value}`;
}
