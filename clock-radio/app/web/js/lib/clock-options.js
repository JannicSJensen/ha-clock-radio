export const CLOCK_CHOICES = {
  layout: ["widget", "full"],
  face: ["analog", "analog-round", "digital"],
  full_face: ["analog", "digital"],
  widget: ["calendar", "weather", "date", "date-calendar", "none"],
  second_hand: ["60", "30", "tick"],
  time_format: ["automatic", "24-hour", "12-hour"],
  week_start: ["automatic", "monday", "sunday", "saturday"],
  night_mode: ["off", "always", "schedule", "sun", "entity", "illuminance"],
};
export const CLOCK_DEFAULTS = {
  layout: "widget", face: "analog", full_face: "analog", widget: "calendar",
  seconds: true, second_hand: "30", time_format: "24-hour", language: "",
  week_start: "automatic", primary: "#ffffff", accent: "#ff3b30",
  seconds_color: "#ff9f0a", background: "#000000", weather_entity: "",
  weather_name: "", next_alarm_entity: "", night_mode: "off", night_start: 22,
  night_end: 7, night_entity: "", night_threshold: 5, night_color: "#ff2a1f",
  night_brightness: 70,
};

export function parseClockOptions(raw = {}, defaults = CLOCK_DEFAULTS) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("clock must be a mapping.");
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CLOCK_DEFAULTS, key)) throw new Error(`Unknown clock setting: ${key}.`);
  }
  const result = { ...defaults, ...raw };
  for (const [key, choices] of Object.entries(CLOCK_CHOICES)) {
    if (!choices.includes(result[key])) throw new Error(`clock.${key}: choose ${choices.join(", ")}.`);
  }
  if (typeof result.seconds !== "boolean") throw new Error("clock.seconds must be a boolean.");
  for (const key of ["primary", "accent", "seconds_color", "background", "night_color"]) {
    if (typeof result[key] !== "string" || !/^#[a-f0-9]{6}$/i.test(result[key])) throw new Error(`clock.${key} must be a six-digit hex color.`);
  }
  for (const key of ["language", "weather_entity", "weather_name", "night_entity", "next_alarm_entity"]) {
    if (typeof result[key] !== "string" || result[key].length > 256) throw new Error(`clock.${key} must be a string of at most 256 characters.`);
  }
  if (result.language) new Intl.DateTimeFormat(result.language);
  for (const key of ["night_start", "night_end"]) {
    if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > 23) throw new Error(`clock.${key} must be an hour from 0 to 23.`);
  }
  if (!Number.isFinite(result.night_threshold) || result.night_threshold < 0 || result.night_threshold > 10000) throw new Error("clock.night_threshold must be between 0 and 10000.");
  if (!Number.isInteger(result.night_brightness) || result.night_brightness < 20 || result.night_brightness > 100) throw new Error("clock.night_brightness must be between 20 and 100.");
  for (const key of ["weather_entity", "night_entity", "next_alarm_entity"]) {
    if (result[key] && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(result[key])) throw new Error(`clock.${key} must be an entity ID.`);
  }
  if (result.weather_entity && !result.weather_entity.startsWith("weather.")) throw new Error("clock.weather_entity must be a weather entity.");
  if (result.night_mode === "illuminance" && result.night_entity && !result.night_entity.startsWith("sensor.")) throw new Error("Room-light mode needs an HA sensor entity.");
  return result;
}
