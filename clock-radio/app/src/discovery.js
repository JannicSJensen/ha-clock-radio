export async function discoverMusicAssistant(token, fetchImpl = globalThis.fetch) {
  const get = async (route) => {
    const response = await fetchImpl(`http://supervisor${route}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Supervisor discovery failed (HTTP ${response.status}).`);
    return (await response.json()).data;
  };
  const { addons } = await get("/addons");
  const running = addons.filter((addon) => /music[_ -]?assistant/i.test(`${addon.slug} ${addon.name}`) && addon.state === "started")
    .sort((a, b) => Number(/beta|dev/.test(a.slug)) - Number(/beta|dev/.test(b.slug)));
  for (const addon of running) {
    const info = await get(`/addons/${encodeURIComponent(addon.slug)}/info`);
    const hosts = info.host_network ? ["172.30.32.1"] : [info.ip_address, info.hostname].filter(Boolean);
    for (const host of hosts) {
      const url = `http://${host}:8095`;
      const response = await fetchImpl(`${url}/info`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).server_version) return url;
    }
  }
  throw new Error("No running Music Assistant app was found. Set music_assistant_url in app options.");
}
