import fs from "node:fs";
import path from "node:path";
import { ALARM_SOUNDS, soundFile } from "../web/js/lib/alarm-sounds.js";

export function publishAlarmSounds(webRoot, haConfigDir) {
  for (const file of [...ALARM_SOUNDS.map(({ id }) => soundFile(id)), "sounds/LICENSE"]) {
    const source = path.join(webRoot, file);
    const destination = path.join(haConfigDir, "www/clock-radio", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.readFileSync(source).equals(fs.readFileSync(destination))) {
        throw new Error(`Alarm sound differs from the bundled original: ${destination}. Move the conflicting file before restarting Clock Radio.`);
      }
    }
  }
}
