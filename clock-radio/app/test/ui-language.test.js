import assert from "node:assert/strict";
import test from "node:test";
import { CLOCK_DEFAULTS, clockRendererOptions, parseClockOptions } from "../web/js/lib/clock-options.js";
import { setUiLanguage, ui, uiFormat } from "../web/js/lib/ui-language.js";
import { alarmLabel, alarmSettings, repeatLabel } from "../web/js/pages/alarms.js";

test("app language validates and overrides the clock locale only when explicitly selected", () => {
  const legacy = parseClockOptions({ language: "fr" });
  assert.equal(legacy.app_language, "");
  assert.equal(clockRendererOptions(legacy, "").locale, "fr");
  for (const language of ["en", "da"]) {
    const options = parseClockOptions({ language: "fr", app_language: language });
    assert.equal(clockRendererOptions(options, "").locale, language);
  }
  for (const invalid of ["fr", "da-DK", null, 123]) {
    assert.throws(() => parseClockOptions({ app_language: invalid }), /clock\.app_language/);
  }
  assert.equal(CLOCK_DEFAULTS.app_language, "");
});

test("Danish alarm presentation does not alter backend values or interpolated names", () => {
  const days = { monday: true, tuesday: false, wednesday: true, thursday: false, friday: false, saturday: false, sunday: false };
  const alarm = { id: 1, enabled: true, type: "Music", hour: 7, minute: 5, volume: 50, duration: 10, days };
  try {
    setUiLanguage("da-DK");
    assert.equal(ui("Save changes"), "Gem ændringer");
    assert.equal(repeatLabel(days), "Man, Ons");
    assert.equal(alarmLabel(alarm, false), "07:05 · Musik · Man, Ons");
    assert.equal(alarmSettings(alarm).type, "Music");
    assert.equal(uiFormat("Selected: {name}", { name: "Music" }), "Valgt: Music");
    setUiLanguage("en");
    assert.equal(alarmLabel(alarm, false), "07:05 · Music · Mon, Wed");
  } finally {
    setUiLanguage("en");
  }
});
