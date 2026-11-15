export const ALARM_SOUNDS = [
  { id: "morning-light", name: "Morning Light", description: "Soft, spacious bell notes" },
  { id: "glass-drops", name: "Glass Drops", description: "Bright droplets with a gentle echo" },
  { id: "warm-keys", name: "Warm Keys", description: "Mellow, rounded keyboard tones" },
  { id: "woodland-tap", name: "Woodland Tap", description: "Light, woody percussion" },
  { id: "orbit-pulse", name: "Orbit Pulse", description: "Slow, sweeping electronic pulses" },
  { id: "calm-steps", name: "Calm Steps", description: "A relaxed ascending sequence" },
  { id: "bright-start", name: "Bright Start", description: "Clear, cheerful bell pairs" },
  { id: "round-bell", name: "Round Bell", description: "A deep, resonant bell" },
  { id: "soft-signal", name: "Soft Signal", description: "Gentle paired electronic beeps" },
  { id: "silver-beat", name: "Silver Beat", description: "Crisp, rhythmic metallic taps" },
  { id: "slow-sunrise", name: "Slow Sunrise", description: "Gradually rising, warm tones" },
  { id: "daybreak-beep", name: "Daybreak Beep", description: "A straightforward repeating buzzer" },
];

export const SOUND_DIRECTORY = "sounds/v1";
export const soundFile = (id) => `${SOUND_DIRECTORY}/${id}.wav`;
export const soundMediaPath = (id) => `/local/clock-radio/${soundFile(id)}`;

export function alarmSoundId(source) {
  if (!source || !URL.canParse(source)) return null;
  const pathname = new URL(source).pathname;
  return ALARM_SOUNDS.find(({ id }) => pathname.endsWith(soundMediaPath(id)))?.id ?? null;
}
