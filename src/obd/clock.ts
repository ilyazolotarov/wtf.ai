/** Monotonic clock in µs plus a sleep, injectable so tests run in virtual time. */
export interface Clock {
  nowUs(): number;
  sleep(ms: number): Promise<void>;
}

/** Real clock over a monotonic `nowUs` source (native uptime on device). */
export function createClock(nowUs: () => number): Clock {
  return {
    nowUs,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  };
}

/** setImmediate where available (Node/Jest): no 1 ms timer floor. */
export function yieldMacrotask(fn: () => void): void {
  if (typeof setImmediate === "function") setImmediate(fn);
  else setTimeout(fn, 0);
}

/**
 * Virtual clock for tests: `sleep` advances time instantly but still yields a
 * macrotask, so concurrent loops interleave and tests can stop them.
 */
export class VirtualClock implements Clock {
  private t: number;

  constructor(startUs = 1_000_000) {
    this.t = startUs;
  }

  nowUs = (): number => this.t;

  sleep = (ms: number): Promise<void> => {
    this.t += Math.max(0, ms) * 1000;
    return new Promise((resolve) => yieldMacrotask(resolve));
  };

  advance(ms: number): void {
    this.t += ms * 1000;
  }
}
