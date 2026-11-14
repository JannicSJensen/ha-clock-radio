/** Per-device preferences (e.g. the speaker chosen on the radio page). Never throws. */
const PREFIX = "clock-radio.";

export function getPref(key, fallback = null) {
  try {
    return localStorage.getItem(PREFIX + key) ?? fallback;
  } catch (error) {
    console.warn(`Device preferences are unavailable: ${error.message}`);
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch (error) {
    console.warn(`Could not save device preference: ${error.message}`);
  }
}
