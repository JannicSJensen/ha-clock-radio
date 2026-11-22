export function weatherHeading(now, locale, place) {
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(now);
  return place ? `${place} · ${date}` : date;
}

export function weatherTemperatureSize(clockSize, clockViewWidth) {
  return clockSize * 200 / clockViewWidth;
}
