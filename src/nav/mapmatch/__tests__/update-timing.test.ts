import { UpdateTiming } from "@/nav/mapmatch/update-timing";

describe("UpdateTiming", () => {
  test("quantiles within 5 % of the exact ones; count, total, max and over-budget exact", () => {
    const t = new UpdateTiming(5);
    // 0.1 ms … 1 ms evenly, plus two slow updates.
    const times = Array.from({ length: 1000 }, (_, i) => 0.1 + (0.9 * i) / 999);
    times.push(6, 12);
    times.forEach((ms) => t.add(ms));
    const s = t.summary()!;
    const sorted = [...times].sort((a, b) => a - b);
    const exact = (q: number) => sorted[Math.ceil(q * sorted.length) - 1];
    expect(s.p50Ms).toBeGreaterThanOrEqual(exact(0.5));
    expect(s.p50Ms).toBeLessThanOrEqual(exact(0.5) * 1.05);
    expect(s.p99Ms).toBeGreaterThanOrEqual(exact(0.99));
    expect(s.p99Ms).toBeLessThanOrEqual(exact(0.99) * 1.05);
    expect(s).toMatchObject({ count: 1002, maxMs: 12, overBudget: 2 });
    expect(s.totalMs).toBeCloseTo(times.reduce((a, b) => a + b, 0), 9);
  });

  test("never above the max, and empty gives null", () => {
    const t = new UpdateTiming();
    expect(t.summary()).toBeNull();
    t.add(0.3);
    expect(t.quantile(0.99)).toBe(0.3);
  });
});
