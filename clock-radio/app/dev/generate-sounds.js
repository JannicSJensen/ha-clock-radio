import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALARM_SOUNDS, soundFile } from "../web/js/lib/alarm-sounds.js";

const RATE = 24000;
const DURATION = 8;
const patterns = {
  "morning-light": { notes: [60, 67, 64, 72], times: [0.2, 1.5, 3.2, 4.8], decay: 1.3, style: "bell" },
  "glass-drops": { notes: [84, 79, 86, 81, 88], times: [0.1, 0.55, 2.2, 2.65, 4.4], decay: 0.7, style: "glass" },
  "warm-keys": { notes: [53, 60, 57, 65], times: [0.15, 1.6, 3.05, 4.5], decay: 0.95, style: "keys" },
  "woodland-tap": { notes: [72, 67, 74, 69, 76, 72], times: [0.2, 0.7, 2, 2.5, 3.8, 4.3], decay: 0.2, style: "wood" },
  "orbit-pulse": { notes: [48, 55, 51, 58], times: [0.1, 1.6, 3.1, 4.6], decay: 1, style: "sweep" },
  "calm-steps": { notes: [57, 62, 66, 69], times: [0.3, 1.45, 2.95, 4.75], decay: 1.1, style: "keys" },
  "bright-start": { notes: [76, 83, 79, 86], times: [0.1, 0.65, 2.8, 3.35], decay: 0.85, style: "bell" },
  "round-bell": { notes: [48, 55, 48], times: [0.2, 2.2, 4.2], decay: 1.6, style: "bell" },
  "soft-signal": { notes: [69, 69, 74, 74], times: [0.2, 0.65, 2.7, 3.15], decay: 0.26, style: "beep" },
  "silver-beat": { notes: [81, 88, 83, 90, 85], times: [0.1, 0.45, 1.8, 2.15, 3.5], decay: 0.35, style: "glass" },
  "slow-sunrise": { notes: [45, 52, 57, 61], times: [0.15, 1.55, 3.05, 4.65], decay: 1.2, style: "sweep" },
  "daybreak-beep": { notes: [76, 76, 76, 76, 76, 76], times: [0.1, 0.55, 1, 2.8, 3.25, 3.7], decay: 0.18, style: "beep" },
};

export function renderSound(id) {
  const pattern = patterns[id];
  if (!Object.hasOwn(patterns, id)) throw new Error(`Unknown alarm sound: ${id}`);
  const samples = new Float64Array(RATE * DURATION);
  for (const [noteIndex, note] of pattern.notes.entries()) {
    const frequency = 440 * 2 ** ((note - 69) / 12);
    const start = Math.round(pattern.times[noteIndex] * RATE);
    const length = Math.min(samples.length - start, Math.round(pattern.decay * 6 * RATE));
    for (let index = 0; index < length; index++) {
      const time = index / RATE;
      const phase = 2 * Math.PI * frequency * time;
      const attack = 1 - Math.exp(-time / (pattern.style === "sweep" ? 0.12 : 0.008));
      const envelope = attack * Math.exp(-time / pattern.decay);
      let wave;
      switch (pattern.style) {
        case "bell": wave = Math.sin(phase) + 0.32 * Math.sin(phase * 2.76) + 0.12 * Math.sin(phase * 4.07); break;
        case "glass": wave = Math.sin(phase) + 0.35 * Math.sin(phase * 2.31) + 0.13 * Math.sin(phase * 5.12); break;
        case "keys": wave = Math.sin(phase) + 0.2 * Math.sin(phase * 2) + 0.08 * Math.sin(phase * 3); break;
        case "wood": wave = Math.sin(phase) + 0.5 * Math.sin(phase * 1.47) * Math.exp(-time * 14); break;
        case "sweep": wave = Math.sin(phase * 0.5 + 2 * Math.PI * 16 * time * time) * (0.8 + 0.2 * Math.sin(time * 5)); break;
        case "beep": wave = Math.sin(phase) + 0.12 * Math.sin(phase * 3); break;
        default: throw new Error(`Unknown synthesis style: ${pattern.style}`);
      }
      const fade = Math.min(1, (samples.length - 1 - start - index) / (RATE * 0.15));
      samples[start + index] += wave * envelope * fade;
    }
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (const [index, sample] of samples.entries()) wav.writeInt16LE(Math.round(sample / peak * 0.7 * 32767), 44 + index * 2);
  return wav;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  for (const { id } of ALARM_SOUNDS) {
    const file = path.join(web, soundFile(id));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderSound(id));
  }
  console.log(`Generated ${ALARM_SOUNDS.length} original alarm sounds.`);
}
