import { type LongTaskEntry, LongTasks } from "../long-tasks";

/** A clock the test moves, and an observer the test feeds. */
function harness() {
  let now = 1000;
  let deliver: ((entries: readonly LongTaskEntry[]) => void) | null = null;
  const tasks = new LongTasks({
    nowMs: () => now,
    observe: (onEntries) => {
      deliver = onEntries;
      return () => {
        deliver = null;
      };
    },
  });
  return {
    tasks,
    advance: (ms: number) => (now += ms),
    report: (startTime: number, duration: number) => deliver?.([{ startTime, duration }]),
    now: () => now,
  };
}

describe("LongTasks", () => {
  it("attributes a long task to the label running then, and writes the drive's line", () => {
    const h = harness();
    h.tasks.start();
    // A filter update of 80 ms.
    const t0 = h.now();
    h.tasks.label("mm update", () => h.advance(80));
    h.report(t0, 80);
    // A routing slice of 60 ms, a little later.
    h.advance(500);
    const t1 = h.now();
    h.tasks.label("route slice", () => h.advance(60));
    h.report(t1, 60);
    // Something unlabelled.
    h.advance(500);
    h.report(h.now(), 55);
    h.advance(60_000 - 1_195);
    const line = h.tasks.endDrive();
    // The quantiles come from a 5 % histogram: p50 is 60 ms or a hair over.
    expect(line).toMatch(
      /^js long tasks: 3 \(3\.0\/min\), p50 6\d ms, p99 80 ms, max 80 ms, 0\.33 % of the time; mm update 1 \(max 80 ms\), route slice 1 \(max 60 ms\), other 1 \(max 55 ms\)$/,
    );
  });

  it("two labels under one task: the one overlapping it more", () => {
    const h = harness();
    h.tasks.start();
    const t0 = h.now();
    h.tasks.label("publish", () => h.advance(20));
    h.tasks.label("mm update", () => h.advance(70));
    h.report(t0, 90);
    expect(h.tasks.summary()?.byLabel).toEqual({ "mm update": { count: 1, totalMs: 90, maxMs: 90 } });
  });

  it("a task reported while its label is still running counts to that label", () => {
    const h = harness();
    h.tasks.start();
    const t0 = h.now();
    h.tasks.label("route slice", () => {
      h.advance(90);
      h.report(t0, 90);
    });
    expect(h.tasks.summary()?.byLabel).toEqual({ "route slice": { count: 1, totalMs: 90, maxMs: 90 } });
  });

  it("a quiet drive says so, and the next drive counts afresh", () => {
    const h = harness();
    h.tasks.start();
    h.advance(120_000);
    expect(h.tasks.endDrive()).toBe("js long tasks: none in 2.0 min");
    h.report(h.now(), 51);
    h.advance(30_000);
    expect(h.tasks.endDrive()).toMatch(/^js long tasks: 1 \(2\.0\/min\)/);
  });

  it("without the platform's observer there is no line", () => {
    const tasks = new LongTasks({ nowMs: () => 0, observe: () => null });
    tasks.start();
    tasks.label("mm update", () => undefined);
    expect(tasks.summary()).toBeNull();
    expect(tasks.endDrive()).toBeNull();
  });

  it("label returns the work's result and rethrows its error", () => {
    const h = harness();
    expect(h.tasks.label("x", () => 42)).toBe(42);
    expect(() =>
      h.tasks.label("x", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});
