import { GnssTrustTracker } from "@/services/position/gnss-trust";

/** Feed fixes as [accuracyM, atSeconds]; returns the trust after each. */
function feed(tracker: GnssTrustTracker, fixes: [number, number][]) {
  return fixes.map(([acc, s]) => tracker.onFix(acc, s * 1000));
}

describe("GNSS trust", () => {
  test("trusts the first good fix", () => {
    expect(feed(new GnssTrustTracker(), [[8, 0]])).toEqual(["TRUSTED"]);
  });

  test("a single coarse fix in a 1 Hz stream keeps trust", () => {
    const t = new GnssTrustTracker();
    expect(feed(t, [[8, 0], [8, 1], [120, 2], [8, 3]])).toEqual(
      Array(4).fill("TRUSTED"),
    );
  });

  test("trust lapses once good fixes stop for 8 s, and lastTrustedFixAt holds", () => {
    const t = new GnssTrustTracker();
    feed(t, [[8, 0], [8, 1]]);
    expect(feed(t, [[200, 5]])).toEqual(["TRUSTED"]);
    expect(t.check(8_900)).toBe("TRUSTED");
    expect(t.check(9_100)).toBe("NO_FIX");
    expect(feed(t, [[200, 15]])).toEqual(["NO_FIX"]);
    expect(t.lastTrustedFixAt).toBe(1000);
  });

  test("intermittent jamming: leaked GPS fixes between coarse ones don't regain trust", () => {
    const t = new GnssTrustTracker();
    feed(t, [[8, 0]]);
    t.check(10_000);
    // Wi-Fi fix, a leaked GPS fix, Wi-Fi again, ... — must not flicker.
    const states = feed(t, [[150, 11], [10, 12], [150, 13], [9, 14], [10, 15], [150, 16]]);
    expect(states.every((s) => s === "NO_FIX")).toBe(true);
  });

  test("regains trust after 5 s of steady good fixes", () => {
    const t = new GnssTrustTracker();
    feed(t, [[8, 0]]);
    t.check(10_000);
    const states = feed(t, [[10, 20], [10, 21], [10, 22], [10, 23], [10, 24], [10, 25]]);
    expect(states).toEqual(["NO_FIX", "NO_FIX", "NO_FIX", "NO_FIX", "NO_FIX", "TRUSTED"]);
  });

  test("Wi-Fi/cell fixes (no speed) never count as GNSS, however accurate", () => {
    const t = new GnssTrustTracker();
    // Jammed from the start: a ±9 m Wi-Fi fix every few seconds (seen in a real drive).
    const states = [0, 3, 6, 9, 12, 15].map((s) => t.onFix(9, s * 1000, false));
    expect(states.every((s) => s === "NO_FIX")).toBe(true);
    // Lock returns: 1 Hz satellite fixes regain trust after 5 s.
    const back = [20, 21, 22, 23, 24, 25].map((s) => t.onFix(5, s * 1000, true));
    expect(back).toEqual(["TRUSTED", "TRUSTED", "TRUSTED", "TRUSTED", "TRUSTED", "TRUSTED"]);
  });

  test("while trusted, Wi-Fi fixes don't keep trust alive", () => {
    const t = new GnssTrustTracker();
    t.onFix(5, 0, true);
    [2, 4, 6, 8].forEach((s) => t.onFix(9, s * 1000, false));
    expect(t.check(8_500)).toBe("NO_FIX");
  });

  test("a 30–50 m fix keeps trust but does not count toward regaining it", () => {
    const t = new GnssTrustTracker();
    feed(t, [[8, 0]]);
    expect(feed(t, [[45, 1], [45, 7]])).toEqual(["TRUSTED", "TRUSTED"]);
    t.check(20_000);
    expect(feed(t, [[10, 20], [45, 23], [10, 26]])).toEqual(["NO_FIX", "NO_FIX", "NO_FIX"]);
  });
});
