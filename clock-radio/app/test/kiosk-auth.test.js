import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { KioskAuth } from "../src/kiosk-auth.js";
import { KioskAlarms } from "../src/kiosk-alarms.js";
import { createKioskDemo, DEMO_KIOSK_PASSWORD, DEMO_KIOSK_TOKEN } from "../dev/kiosk-fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
const options = { url: "http://192.0.2.1:2324", password: "fictional admin password" };

test("manual tokens never log in or renew", async () => {
  const auth = new KioskAuth({ ...options, password: "", token: "manual-token",
    fetchImpl() { assert.fail("Manual mode must not log in"); }, now: () => 1000 * DAY });
  assert.equal(await auth.getToken(), "manual-token");
  auth.reject("manual-token");
  assert.equal(await auth.getToken(), "manual-token");
});

test("automatic login takes precedence, deduplicates requests and renews at six days", async () => {
  let now = 0;
  const requests = [];
  const auth = new KioskAuth({ ...options, token: "ignored-manual-token", now: () => now,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return reply({ token: `issued-token-${requests.length}` });
    } });
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]),
    ["issued-token-1", "issued-token-1", "issued-token-1"]);
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, `${options.url}/api/login`);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(init.body), { password: options.password, ttl_days: 7 });
  assert.ok(init.signal instanceof AbortSignal);
  now = 6 * DAY - 1;
  assert.equal(await auth.getToken(), "issued-token-1");
  assert.equal(requests.length, 1);
  now++;
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken()]), ["issued-token-2", "issued-token-2"]);
  assert.equal(requests.length, 2);
});

test("login failures are sanitized, shared, backed off and recover without a restart", async () => {
  let now = 0, calls = 0, fail = true;
  const auth = new KioskAuth({ ...options, token: "must-not-fall-back", now: () => now,
    fetchImpl: async () => {
      calls++;
      return fail ? reply({ error: `secret ${options.password}` }, 401) : reply({ token: "recovered" });
    } });
  const results = await Promise.allSettled([auth.getToken(), auth.getToken(), auth.getToken()]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /refused the Remote Administration password/);
    assert.ok(!result.reason.message.includes(options.password));
  }
  for (const wait of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    assert.equal(auth.retryAt - now, wait);
    const before = calls;
    now += wait - 1;
    await assert.rejects(auth.getToken(), /password/);
    assert.equal(calls, before);
    now++;
    await assert.rejects(auth.getToken(), /password/);
    assert.equal(calls, before + 1);
  }
  fail = false;
  now = auth.retryAt;
  assert.equal(await auth.getToken(), "recovered");
  assert.equal(auth.failures, 0);
  assert.equal(auth.retryAt, 0);
  assert.equal(auth.error, null);
});

test("login rejects HTTP errors, malformed tokens and transport failures without echoing secrets", async () => {
  for (const fetchImpl of [
    async () => reply({ token: "secret" }, 429),
    async () => reply({ token: "secret" }, 500),
    async () => new Response("secret is not JSON"),
    async () => reply(null),
    async () => reply({ token: "" }),
    async () => reply({ token: "secret\nvalue" }),
    async () => reply({ token: 123 }),
    async () => reply({ token: "x".repeat(16_001) }),
    async () => new Response("x".repeat(64_001)),
    async () => { throw new Error("secret transport failure"); },
  ]) {
    const auth = new KioskAuth({ ...options, fetchImpl, now: () => 0 });
    await assert.rejects(auth.getToken(), (error) => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
    assert.equal(auth.token, "");
    assert.equal(auth.retryAt, 30_000);
  }
});

test("login timeout is explicit and backed off", async () => {
  const auth = new KioskAuth({ ...options, timeoutMs: 5, now: () => 0,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("Timeout did not abort")), 1000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(auth.getToken(), /login could not be reached or timed out/);
  assert.equal(auth.retryAt, 30_000);
});

test("failed renewal reports errors rather than using an old or manual token", async () => {
  let now = 0, fail = false;
  const paths = [];
  const client = new KioskAlarms({ ...options, token: "ignored", now: () => now,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/api/login")) return fail ? reply({}, 503) : reply({ token: "issued" });
      return reply({ ok: true, data: {} });
    } });
  await client.command("alarmsStatus");
  now = 6 * DAY;
  fail = true;
  await assert.rejects(client.command("alarmSave", {}, true), /login failed/);
  assert.deepEqual(paths, ["/api/login", "/api/commands/alarmsStatus", "/api/login"]);
});

test("rejected reads, alarm mutations, settings and updates are never automatically replayed", async () => {
  for (const status of [401, 403]) {
    for (const operation of [
      (client) => client.command("alarmsStatus"),
      (client) => client.command("alarmSave", { alarm: {} }, true),
      (client) => client.command("alarmDelete", { id: "fictional" }, true),
      (client) => client.settings({ "screensaver.enabled": true }),
      (client) => client.command("installUpdate", {}, true),
    ]) {
      let now = 0, reject = true, logins = 0;
      const calls = [];
      const client = new KioskAlarms({ ...options, now: () => now,
        fetchImpl: async (url, init) => {
          if (url.endsWith("/api/login")) return reply({ token: `issued-${++logins}` });
          calls.push({ url, init });
          return reject ? reply({}, status) : reply({ ok: true, data: {} });
        } });
      await assert.rejects(operation(client), /operation was not retried/);
      assert.equal(calls.length, 1);
      assert.equal(logins, 1);
      await assert.rejects(client.command("alarmsStatus"), /Automatic login will retry/);
      assert.equal(logins, 1);
      assert.equal(calls.length, 1);
      now = 30_000;
      reject = false;
      await client.command("alarmsStatus");
      assert.equal(logins, 2);
      assert.equal(calls.length, 2);
      assert.ok(calls[1].url.endsWith("/api/commands/alarmsStatus"));
      assert.equal(calls[1].init.headers.Authorization, "Bearer issued-2");
    }
  }
});

test("late rejections of an old token cannot invalidate a newer token", async () => {
  let now = 0, issued = 0;
  const auth = new KioskAuth({ ...options, now: () => now,
    fetchImpl: async () => reply({ token: `issued-${++issued}` }) });
  const old = await auth.getToken();
  now = 6 * DAY;
  assert.equal(await auth.getToken(), "issued-2");
  auth.reject(old);
  assert.equal(await auth.getToken(), "issued-2");
  assert.equal(issued, 2);
});

test("alarms, settings and update status share one login against the real HTTP fixture", async (t) => {
  const fixture = createKioskDemo();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    const closed = once(fixture.server, "close");
    fixture.server.close(); fixture.server.closeAllConnections();
    await closed;
  });
  const client = new KioskAlarms({ url: `http://127.0.0.1:${fixture.server.address().port}`, password: DEMO_KIOSK_PASSWORD });
  await Promise.all([client.refresh(), client.settings(), client.command("getUpdateStatus")]);
  assert.equal(client.connected, true);
  assert.equal(fixture.calls.filter(({ name }) => name === "login").length, 1);
  assert.equal(client.auth.token, DEMO_KIOSK_TOKEN);
  const snapshot = JSON.stringify(client.snapshot());
  for (const secret of [DEMO_KIOSK_PASSWORD, DEMO_KIOSK_TOKEN]) assert.ok(!snapshot.includes(secret));
});
