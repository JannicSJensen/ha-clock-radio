import assert from "node:assert/strict";
import test from "node:test";
import { getJson, postJson } from "../web/js/core/api.js";

function requests(t, { bodyStalls = false } = {}) {
  const timers = [];
  const calls = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => { timer.cleared = true; });
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls.push({ url, options });
    const stalled = () => new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    return bodyStalls ? Promise.resolve({ ok: true, json: stalled }) : stalled();
  });
  return { timers, calls };
}

test("state requests have an exact 8-second deadline, include body reading and do not retry", async (t) => {
  const { calls, timers } = requests(t, { bodyStalls: true });
  const result = getJson("api/state", { timeout: 8000 });
  await Promise.resolve();
  assert.equal(timers[0].delay, 8000);
  assert.equal(calls[0].options.signal.aborted, false);
  timers[0].callback();
  await assert.rejects(result, /timed out after 8 seconds/);
  assert.equal(timers[0].cleared, true);
  assert.equal(calls.length, 1);
});

test("write deadlines are bounded, allow long provisioning/deletion, and report uncertain outcomes without retries", async (t) => {
  const { calls, timers } = requests(t);
  for (const [url, delay] of [["api/alarm", 30_000], ["api/alarm/create", 120_000], ["api/alarm/delete", 120_000]]) {
    const result = postJson(url, { id: 1 });
    const timer = timers.at(-1);
    assert.equal(timer.delay, delay);
    timer.callback();
    await assert.rejects(result, /The change may still complete. Check saved values before retrying/);
    assert.equal(timer.cleared, true);
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body, '{"id":1}');
});

test("caller cancellation is preserved and does not become a timeout", async (t) => {
  const { timers, calls } = requests(t);
  const caller = new AbortController();
  const remove = t.mock.method(caller.signal, "removeEventListener");
  const result = getJson("api/music/search", { signal: caller.signal });
  caller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(timers[0].cleared, true);
  assert.equal(remove.mock.callCount(), 1);
  await assert.rejects(getJson("api/state", { signal: caller.signal }), { name: "AbortError" });
  assert.equal(timers[1].cleared, true);
});

test("success and HTTP failure both clean up timers/listeners and preserve request options", async (t) => {
  const { timers, calls } = requests(t);
  const caller = new AbortController();
  const remove = t.mock.method(caller.signal, "removeEventListener");
  let ok = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return { ok, status: 503, json: async () => ok ? { connected: true } : { error: "HA unavailable" } };
  });
  assert.deepEqual(await getJson("api/state", { signal: caller.signal, headers: { Accept: "application/json" } }), { connected: true });
  assert.equal(calls[0].url, "./api/state");
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.equal(caller.signal.aborted, false);
  ok = false;
  await assert.rejects(getJson("api/state", { signal: caller.signal }), /HA unavailable/);
  assert.equal(remove.mock.callCount(), 2);
  assert.ok(timers.every((timer) => timer.cleared));
  await assert.rejects(getJson("api/state", { timeout: 0 }), /positive number/);
});
