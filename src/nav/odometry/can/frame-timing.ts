// CAN frames at the time the bus carried them, not when the link delivered them (NAVIGATOR-SPEC §5.4). A car sends
// each id at a fixed rate; the adapter's link delivers them in bursts: over the OBDLink MX+'s MFi link half the
// frames came within 1 ms of the one before and a 0.1 s slot held 0–23 of 0x215's 10 (2026-10-13). Timed by arrival,
// a turn's yaw was squeezed into the bursts and the wheels' heading over a 5 s stretch came out 10–20 % off the gyro.
// So each id's frames are laid on its own period: one period after the last, but never after the frame arrived nor
// longer than `MAX_LATENCY_US` before it. A break in listening (the monitor stopped for a poll, a stall) starts each
// id again at its next frame's arrival: the frames in it went unheard, and laid one period after the last before it,
// every frame after a poll's ~0.16 s break came that much early (the wheels' turning up to 0.1 s ahead of the gyro,
// 2026-10-12).

/** A frame isn't delivered later than this after the bus carried it (bursts up to ~0.16 s seen). */
const MAX_LATENCY_US = 300_000;
/** Each id's period from the arrivals of its last this many frames (2 s of a 100 Hz id), across breaks. */
const PERIOD_FRAMES = 200;
/** The period once this many of those frames are in. */
const PERIOD_MIN_FRAMES = 20;
/** Arrivals this far apart are a break in listening, not a burst (when no `break()` said so). */
const BREAK_US = 500_000;

interface IdClock {
  /** Bus time given to the last frame. */
  lastUs: number;
  /** Arrivals of the last `PERIOD_FRAMES` frames, oldest first, one list per stretch between breaks (the last is open). */
  runs: number[][];
  frames: number;
  periodUs: number | null;
}

export class FrameRetimer {
  private readonly ids = new Map<number, IdClock>();

  /** A break in listening (the monitor stopped and started again): each id's next frame is taken when it arrived. */
  break(): void {
    for (const c of this.ids.values()) if (c.runs[c.runs.length - 1].length) c.runs.push([]);
  }

  /** The bus time of a frame of `id` that arrived at `arrivalUs` (frames of an id in arrival order). */
  retime(id: number, arrivalUs: number): number {
    let c = this.ids.get(id);
    if (!c) {
      c = { lastUs: arrivalUs, runs: [[]], frames: 0, periodUs: null };
      this.ids.set(id, c);
    }
    let run = c.runs[c.runs.length - 1];
    if (run.length && arrivalUs - run[run.length - 1] > BREAK_US) c.runs.push((run = []));
    const first = run.length === 0;
    run.push(arrivalUs);
    if (++c.frames > PERIOD_FRAMES) {
      c.runs[0].shift();
      c.frames--;
      if (!c.runs[0].length) c.runs.shift();
    }
    if (first) {
      // The first frame, or the first after a break: when it arrived. The period stays from before.
      c.lastUs = arrivalUs;
      return arrivalUs;
    }
    c.periodUs = pooledSlope(c.runs) ?? c.periodUs;
    const next = c.periodUs === null ? arrivalUs : c.lastUs + c.periodUs;
    c.lastUs = Math.min(arrivalUs, Math.max(arrivalUs - MAX_LATENCY_US, next));
    return c.lastUs;
  }
}

/**
 * Least-squares slope of each run's arrivals against their index, the runs pooled (each its own intercept): bursts
 * scatter around the line evenly, so its slope is the id's period; the frames lost in a break don't count (the span's
 * ends alone fall in a burst or not, 8 ms for 10). Null with fewer than `PERIOD_MIN_FRAMES` frames.
 */
function pooledSlope(runs: number[][]): number | null {
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  for (const ys of runs) {
    const m = ys.length;
    if (m < 2) continue;
    n += m;
    const mx = (m - 1) / 2;
    let my = 0;
    for (const y of ys) my += y;
    my /= m;
    for (let i = 0; i < m; i++) {
      sxy += (i - mx) * (ys[i] - my);
      sxx += (i - mx) ** 2;
    }
  }
  return n >= PERIOD_MIN_FRAMES && sxx > 0 ? sxy / sxx : null;
}

/**
 * Frames (in arrival order) at their bus times. `windows`: the listening windows (a log's `canWindows`), a break
 * between each; a frame drained after its window ended is at the window's end (`busTimedFrames`), so still in it.
 */
export function retimeFrames<F extends { tUs: number; id: number }>(frames: F[], windows: { endUs: number }[] = []): F[] {
  const r = new FrameRetimer();
  let w = 0;
  return frames.map((f) => {
    let crossed = false;
    for (; w < windows.length && windows[w].endUs < f.tUs; w++) crossed = true;
    if (crossed) r.break();
    return { ...f, tUs: r.retime(f.id, f.tUs) };
  });
}
