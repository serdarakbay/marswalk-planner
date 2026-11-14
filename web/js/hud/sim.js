// Simulation clock for the HUD: play / pause, speed, scrub.
// Pure timekeeping; it never touches the DOM. onTick(date) is called whenever
// the simulated time changes (while playing: every animation frame).

export const SPEEDS = [1, 60, 300, 1200]; // simulated seconds per real second

export function createClock({ start, end, initial, speed = 60, onTick }) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  let now = Math.min(endMs, Math.max(startMs, (initial ?? start).getTime()));
  let rate = speed;
  let playing = false;
  let raf = 0;
  let last = 0;

  const emit = () => onTick?.(new Date(now));

  function frame(ts) {
    if (!playing) return;
    if (last) now += (ts - last) * rate;
    last = ts;
    if (now >= endMs) {
      now = endMs;
      playing = false;
      emit();
      return;
    }
    emit();
    raf = requestAnimationFrame(frame);
  }

  return {
    get time() { return new Date(now); },
    get playing() { return playing; },
    get speed() { return rate; },
    get start() { return new Date(startMs); },
    get end() { return new Date(endMs); },
    play() {
      if (playing) return;
      if (now >= endMs) now = startMs; // replay from the start
      playing = true;
      last = 0;
      raf = requestAnimationFrame(frame);
      emit();
    },
    pause() {
      playing = false;
      cancelAnimationFrame(raf);
      emit();
    },
    setSpeed(s) {
      if (Number.isFinite(s) && s > 0) rate = s;
    },
    seek(t) {
      const ms = t instanceof Date ? t.getTime() : Number(t);
      if (!Number.isFinite(ms)) return;
      now = Math.min(endMs, Math.max(startMs, ms));
      last = 0;
      emit();
    },
  };
}
