import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigStore } from "../src/config.js";
import { HAClient } from "../src/ha-client.js";
import { Dashboard } from "../src/dashboard.js";
import { createServer } from "../src/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

test("static assets revalidate, compress and reuse reads without caching live API data", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-assets-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const filename = path.join(dir, "styles.css");
  const source = ".clock { color: #fff; }\n".repeat(512);
  const modified = new Date("2025-01-01T00:00:00Z");
  fs.writeFileSync(filename, source);
  fs.utimesSync(filename, modified, modified);
  fs.mkdirSync(path.join(dir, "fonts"));
  fs.writeFileSync(path.join(dir, "fonts/test.woff2"), Buffer.alloc(2048, 1));
  const reads = new Map();
  const readFile = fsPromises.readFile;
  t.mock.method(fsPromises, "readFile", async (file, ...args) => {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    return readFile(file, ...args);
  });
  let revision = 0;
  const dashboard = { connected: true, payload: () => ({ revision: ++revision }), playerImage: async () => ({ type: "image/png", body: Buffer.from("image") }) };
  const server = createServer({ dashboard, webRoot: dir, logger: { warn() {} } });
  const url = await listen(server);
  t.after(() => close(server));
  const identity = { "Accept-Encoding": "identity" };
  const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${url}/styles.css`, { headers: identity })));
  assert.deepEqual(await Promise.all(responses.map((response) => response.text())), Array(6).fill(source));
  assert.equal(reads.get(filename), 1);
  const etag = responses[0].headers.get("etag");
  assert.ok(etag);
  assert.equal(responses[0].headers.get("cache-control"), "private, no-cache");
  assert.equal(responses[0].headers.get("vary"), "Accept-Encoding");
  const cached = await fetch(`${url}/styles.css`, { headers: { ...identity, "If-None-Match": `"old", W/${etag}` } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const head = await fetch(`${url}/styles.css`, { method: "HEAD", headers: identity });
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(source));
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${url}/styles.css`, { method: "HEAD", headers: { ...identity, "If-None-Match": "*" } })).status, 304);
  for (const encoding of ["gzip", "*;q=1", "br, gzip;q=0.5"]) {
    const compressed = await fetch(`${url}/styles.css`, { headers: { "Accept-Encoding": encoding } });
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.ok(Number(compressed.headers.get("content-length")) < source.length / 5);
    assert.notEqual(compressed.headers.get("etag"), etag);
    assert.equal(await compressed.text(), source);
    assert.equal((await fetch(`${url}/styles.css`, { headers: { "Accept-Encoding": encoding, "If-None-Match": compressed.headers.get("etag") } })).status, 304);
  }
  for (const encoding of ["br", "gzip;q=0", "gzip;q=0, *;q=1"]) {
    const uncompressed = await fetch(`${url}/styles.css`, { headers: { "Accept-Encoding": encoding } });
    assert.equal(uncompressed.headers.get("content-encoding"), null);
    assert.equal(uncompressed.headers.get("etag"), etag);
    assert.equal(await uncompressed.text(), source);
  }
  assert.equal(reads.get(filename), 1);
  const updated = source.replaceAll("#fff", "#000");
  fs.writeFileSync(filename, updated);
  fs.utimesSync(filename, modified, modified);
  const changed = await fetch(`${url}/styles.css`, { headers: { ...identity, "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal(await changed.text(), updated);
  assert.equal(reads.get(filename), 2);
  fs.unlinkSync(filename);
  const missing = await fetch(`${url}/styles.css`, { headers: { ...identity, "If-None-Match": changed.headers.get("etag") } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  fs.writeFileSync(filename, source);
  assert.equal((await fetch(`${url}/styles.css`, { headers: identity })).status, 200);
  const font = await fetch(`${url}/fonts/test.woff2`);
  assert.equal(font.headers.get("content-encoding"), null);
  const fontTag = font.headers.get("etag");
  assert.equal((await fetch(`${url}/fonts/test.woff2`, { headers: { "If-None-Match": fontTag } })).status, 304);
  assert.equal((await fetch(`${url}/fonts//test.woff2`, { headers: { "If-None-Match": fontTag } })).status, 304);
  assert.equal(reads.get(path.join(dir, "fonts/test.woff2")), 1);
  const icon = await fetch(`${url}/icons/stop.svg`);
  assert.equal(icon.headers.get("cache-control"), "private, no-cache");
  assert.equal((await fetch(`${url}/icons/stop.svg`, { headers: { "If-None-Match": icon.headers.get("etag") } })).status, 304);
  for (const route of ["/api/state", "/health", "/api/player/image/media_player.room"]) {
    const live = await fetch(`${url}${route}`, { headers: { "If-None-Match": "*" } });
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.equal(live.headers.get("etag"), null);
    await live.arrayBuffer();
  }
  assert.deepEqual(await (await fetch(`${url}/api/state`)).json(), { revision: 2 });
});

test("HTTP foundation works end to end with HA, hot reload, error paths and ingress-relative assets", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-radio-http-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  let failure = false;
  let serviceFailure = false;
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    res.setHeader("Content-Type", "application/json");
    if (failure) { res.writeHead(500); return res.end("{}"); }
    if (req.url === "/api/states") return res.end(JSON.stringify([{ entity_id: "media_player.room", state: "playing", attributes: { supported_features: 20997 } }]));
    if (req.url === "/api/config") return res.end(JSON.stringify({ time_zone: "Europe/Copenhagen" }));
    if (serviceFailure) { res.writeHead(500); return res.end("{}"); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.end("[]");
  });
  const haUrl = await listen(mock);
  t.after(() => close(mock));
  const store = new ConfigStore({ dir, example: path.join(root, "examples/dashboard.yaml"), logger: { warn() {} } });
  const dashboard = new Dashboard({ mediaPlayer: "media_player.room", ha: new HAClient({ url: haUrl, token: "test-secret" }), configStore: store, version: "0.1.0", logger: { warn() {} } });
  await dashboard.refresh();
  const server = createServer({ dashboard, webRoot: path.join(root, "web"), logger: { warn() {} } });
  const url = await listen(server);
  t.after(() => close(server));
  const send = (body, headers = { "Content-Type": "application/json" }) => fetch(`${url}/api/command`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  const html = await home.text();
  assert.match(html, /href="\.\/styles.css"/);
  assert.match(html, /src="\.\/app.js"/);
  assert.match(html, /id="page-indicator"[^>]+role="img"[^>]+aria-label="Page position"/);
  assert.deepEqual([...html.matchAll(/<section id="page-([^"]+)"/g)].map((match) => match[1]), ["clock", "alarms", "music", "settings"]);
  const js = await (await fetch(`${url}/app.js`)).text();
  assert.match(js, /getJson\("api\/state"/);
  assert.match(js, /const PAGES = \{ clock: "The Clock", alarms: "Alarm configuration", music: "Music overview", settings: "Settings" \}/);
  const alarms = await (await fetch(`${url}/js/pages/alarms.js`)).text();
  assert.doesNotMatch(alarms, /Tap an alarm to edit|Swipe down for|Alarms run in Home Assistant\. New alarms start disabled/);
  assert.match(alarms, /addInfo\.hidden = !addInfo\.textContent/);
  assert.doesNotMatch(alarms, /[Aa]larm \$\{/);
  const alarmScreen = await (await fetch(`${url}/js/components/alarm-screen.js`)).text();
  assert.doesNotMatch(alarmScreen, /[Aa]larm \$\{/);
  const api = await (await fetch(`${url}/js/core/api.js`)).text();
  assert.match(api, /fetch\(`\.\/\$\{url\}`/);
  const styles = await fetch(`${url}/styles.css`);
  assert.equal(styles.status, 200);
  const css = await styles.text();
  assert.match(css, /html, body\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /\.page\s*\{[^}]*background:\s*var\(--bg\)/);
  const tokens = await fetch(`${url}/css/tokens.css`);
  assert.equal(tokens.status, 200);
  assert.match(await tokens.text(), /--bg:\s*#000;/);
  const musicStyles = await fetch(`${url}/css/music.css`);
  assert.equal(musicStyles.status, 200);
  assert.match(await musicStyles.text(), /\.np\s*\{[^}]*background:\s*#000;/);
  assert.equal((await fetch(`${url}/app.js`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  assert.equal((await fetch(`${url}/api/command`)).status, 405);
  assert.equal((await fetch(`${url}/styles.css`, { method: "POST" })).status, 405);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.connected, true);
  assert.ok(!JSON.stringify(state).includes("test-secret"));
  assert.equal((await (await fetch(`${url}/health`)).json()).ok, true);
  const body = { action: "media_pause", entity_id: "media_player.room" };
  assert.equal((await send(body)).status, 200);
  assert.deepEqual(calls[0], { url: "/api/services/media_player/media_pause", body: { entity_id: "media_player.room" } });
  assert.equal((await send(body, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await send(body, { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status, 403);
  serviceFailure = true;
  const serviceError = await send(body);
  assert.equal(serviceError.status, 502);
  assert.ok((await serviceError.json()).error);
  serviceFailure = false;
  assert.equal((await send("{")).status, 400);
  assert.equal((await send(JSON.stringify({ value: "x".repeat(4200) }))).status, 413);
  assert.equal((await send({ ...body, entity_id: "media_player.other" })).status, 403);
  dashboard.readOnly = true;
  assert.equal((await send(body)).status, 403);
  dashboard.readOnly = false;
  fs.writeFileSync(store.file, "title: Reloaded\nplayers: [media_player.other]\n");
  assert.equal((await send(body)).status, 200);
  assert.equal(dashboard.payload().config.title, "Reloaded");
  dashboard.mediaPlayer = "media_player.other";
  assert.equal((await send(body)).status, 403);
  dashboard.mediaPlayer = "media_player.room";
  fs.writeFileSync(store.file, "title: Reloaded\nplayers: [media_player.room]\n");
  failure = true;
  const offline = await send(body);
  assert.equal(offline.status, 503);
  assert.match((await offline.json()).error, /disconnected/);
  failure = false;
  await dashboard.refresh();
  assert.equal(dashboard.connected, true);
  assert.equal(calls.length, 2);
});
