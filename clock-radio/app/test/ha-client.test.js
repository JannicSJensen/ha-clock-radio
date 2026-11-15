import assert from "node:assert/strict";
import test from "node:test";
import { HAClient } from "../src/ha-client.js";

test("HA client keeps credentials on server requests and uses Supervisor-compatible API paths", async () => {
  const calls = [];
  const ha = new HAClient({
    url: "http://supervisor/core/", token: "secret-test-token",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response("[]"); },
  });
  await ha.states();
  await ha.callService("media_player", "media_pause", { entity_id: "media_player.room" });
  assert.equal(calls[0].url, "http://supervisor/core/api/states");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-test-token");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url, "http://supervisor/core/api/services/media_player/media_pause");
  assert.deepEqual(JSON.parse(calls[1].options.body), { entity_id: "media_player.room" });
});

test("HA failures and malformed state lists are explicit", async () => {
  const ha = new HAClient({ url: "http://ha", token: "test", fetchImpl: async () => new Response("private response", { status: 401 }) });
  await assert.rejects(ha.states(), /HTTP 401/);
  for (const response of ["{}", '[{"entity_id":"media_player.room"}]']) {
    const invalid = new HAClient({ url: "http://ha", token: "test", fetchImpl: async () => new Response(response) });
    await assert.rejects(invalid.states(), /invalid state list/);
  }
});

test("deletion preparation extends its timeout without changing ordinary HA requests", async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    timeouts.push(timeout);
    return new AbortController().signal;
  });
  const ha = new HAClient({ url: "http://ha", token: "test", fetchImpl: async () => new Response("[]") });
  await ha.states();
  await ha.callService("script", "clock_radio_prepare_delete", { alarm: 3 }, { timeout: 60000 });
  assert.deepEqual(timeouts, [8000, 60000]);
});

test("HA connection rejects missing credentials and unsafe URLs", () => {
  for (const url of ["ftp://host", "http://user:pass@host", "http://host/?token=secret", undefined]) {
    assert.throws(() => new HAClient({ url, token: "test" }));
  }
  assert.throws(() => new HAClient({ url: "http://ha" }), /token/);
});

test("built-in sound URLs use HA's public address and never send authentication to public audio", async () => {
  const calls = [];
  const ha = new HAClient({
    url: "http://supervisor/core", token: "test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith("/api/config")
        ? Response.json({ internal_url: "http://ha.lan:8123/", external_url: "https://external.example" })
        : new Response(null, { headers: { "Content-Type": "audio/wav" } });
    },
  });
  assert.equal(await ha.alarmSoundUrl("morning-light"), "http://ha.lan:8123/local/clock-radio/sounds/v1/morning-light.wav");
  assert.equal(calls[1].options.method, "HEAD");
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, "error");
  await assert.rejects(ha.alarmSoundUrl("missing"), /Unknown/);
});

test("missing, unsafe or inaccessible HA sound URLs fail explicitly", async () => {
  for (const config of [{}, { internal_url: "http://user:pass@ha" }, { internal_url: "ftp://ha" }, { internal_url: "https://ha?secret=1" }]) {
    const ha = new HAClient({ url: "http://ha", token: "test", fetchImpl: async () => Response.json(config) });
    await assert.rejects(ha.alarmSoundUrl("round-bell"), /Home Assistant/);
  }
  for (const response of [new Response(null, { status: 404 }), new Response("login", { headers: { "Content-Type": "text/html" } })]) {
    const ha = new HAClient({
      url: "http://ha", token: "test",
      fetchImpl: async (url) => url.endsWith("/api/config") ? Response.json({ external_url: "https://ha" }) : response,
    });
    await assert.rejects(ha.alarmSoundUrl("round-bell"), /not accessible/);
  }
});
