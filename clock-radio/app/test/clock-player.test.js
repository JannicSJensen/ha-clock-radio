import assert from "node:assert/strict";
import test from "node:test";
import { clockPlayerId } from "../web/js/components/player.js";

const speaker = "media_player.bedroom";
const other = "media_player.kitchen";
const state = (value = "playing") => ({
  connected: true,
  alarms: { active: null, snoozed: null },
  music: { default_player: speaker },
  players: [{ entity_id: other, state: "playing" }, { entity_id: speaker, state: value }],
});

test("Clock mini-player follows active playback on the configured Music speaker only", () => {
  assert.equal(clockPlayerId(state()), speaker);
  for (const value of ["paused", "idle", "off", "unavailable"]) {
    assert.equal(clockPlayerId(state(value)), null);
  }
  assert.equal(clockPlayerId({ ...state(), music: { default_player: "" } }), null);
  assert.equal(clockPlayerId({ ...state(), connected: false }), null);
});

test("ringing and snoozed alarms take priority over the Clock mini-player", () => {
  for (const key of ["active", "snoozed"]) {
    const model = state();
    model.alarms[key] = { type: "Music" };
    assert.equal(clockPlayerId(model), null);
  }
  assert.equal(clockPlayerId({ ...state(), read_only: true }), speaker);
});
