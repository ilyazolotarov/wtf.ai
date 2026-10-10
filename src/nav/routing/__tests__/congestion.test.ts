import { congestion, congestionAt } from "@/nav/routing/congestion";

describe("congestion", () => {
  test("weekday peaks, the evening one bigger; free otherwise and at weekends", () => {
    expect(congestion(1, 3)).toBe(1);
    expect(congestion(1, 8.5)).toBeGreaterThan(congestion(1, 12));
    expect(congestion(1, 18)).toBeGreaterThan(congestion(1, 8.5));
    expect(congestion(4, 23)).toBe(1);
    expect(congestion(6, 9)).toBe(1);
    expect(congestion(1, 14)).toBe(1);
    expect(congestion(5, 18)).toBe(1);
  });

  test("a moment in the phone's time zone: Monday is day 0", () => {
    const monday18 = new Date(2026, 9, 12, 18, 0); // Monday 12 October 2026, 18:00 local
    expect(congestionAt(monday18)).toBe(congestion(0, 18));
    const sunday18 = new Date(2026, 9, 11, 18, 0);
    expect(congestionAt(sunday18)).toBe(congestion(6, 18));
  });
});
