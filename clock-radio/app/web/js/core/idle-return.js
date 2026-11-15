export class IdleReturn {
  constructor() {
    this.lastActivity = Date.now();
    this.paused = true;
    this.minutes = null;
  }

  reset(now = Date.now()) {
    this.lastActivity = now;
  }

  expired({ minutes = 2, paused = false }, now = Date.now()) {
    const suspended = paused || minutes === 0;
    if (suspended || this.paused || minutes !== this.minutes) this.reset(now);
    this.paused = suspended;
    this.minutes = minutes;
    return !suspended && now - this.lastActivity >= minutes * 60_000;
  }
}
