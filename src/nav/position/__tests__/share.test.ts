// What Waze and Google Maps get while wtf.ai shares the car's position (ANDROID-SPEC §8).

import {
  GpsTakeoverPolicy,
  SHARE_HOLD_ACCURACY_M,
  SHARE_RESUME_ACCURACY_M,
  shareDecision,
  TAKEOVER_NO_FIX_AFTER_START_MS,
  TAKEOVER_PROBE_EVERY_MAX_MS,
  TAKEOVER_PROBE_EVERY_MS,
  TAKEOVER_PROBE_FAR_M,
  TAKEOVER_PROBE_MAX_MS,
  TAKEOVER_PROBE_MS,
  type ProbeFix,
} from "../share";
import type { PositionEstimate } from "../types";

const dot = (patch: Partial<PositionEstimate> = {}): PositionEstimate => ({
  lat: 50.45,
  lon: 30.52,
  headingRad: Math.PI / 2,
  headingSigmaRad: 0.05,
  speedMps: 12,
  accuracyM: 18,
  source: "dr",
  trust: "UNTRUSTED",
  timestamp: 1_791_000_000_000,
  ...patch,
});

describe("shareDecision", () => {
  test("the map's dot: its place, radius, the car's speed and heading with its doubt", () => {
    expect(shareDecision(dot(), null)).toEqual({
      fix: { lat: 50.45, lon: 30.52, accuracyM: 18, speedMps: 12, courseRad: Math.PI / 2, courseAccRad: 0.05 },
    });
  });

  test("in reverse the car travels the way its tail points, at an unsigned speed", () => {
    const { fix } = shareDecision(dot({ speedMps: -1.5, headingRad: Math.PI / 2 }), null);
    expect(fix?.speedMps).toBe(1.5);
    expect(fix?.courseRad).toBeCloseTo((3 * Math.PI) / 2);
  });

  test("the course is wrapped to one turn", () => {
    expect(shareDecision(dot({ headingRad: -Math.PI / 2 }), null).fix?.courseRad).toBeCloseTo((3 * Math.PI) / 2);
    expect(shareDecision(dot({ headingRad: 2 * Math.PI + 0.1 }), null).fix?.courseRad).toBeCloseTo(0.1);
  });

  test("what is unknown is left out: a GPS course has no doubt of the navigator's, a standing start no heading", () => {
    expect(shareDecision(dot({ source: "gnss", headingSigmaRad: undefined }), null).fix).not.toHaveProperty("courseAccRad");
    const fix = shareDecision(dot({ headingRad: undefined, speedMps: undefined }), null).fix;
    expect(fix).toEqual({ lat: 50.45, lon: 30.52, accuracyM: 18 });
  });

  test("nothing without a position", () => {
    expect(shareDecision(null, null)).toEqual({ hold: "none" });
    expect(shareDecision(dot({ lat: NaN }), null)).toEqual({ hold: "none" });
  });

  test("never the driver's held placing nor phone-only mode: the car isn't followed by them", () => {
    expect(shareDecision(dot({ source: "manual" }), null)).toEqual({ hold: "manual" });
    expect(shareDecision(dot({ phoneOnly: true }), null)).toEqual({ hold: "phone-only" });
  });

  test("over the limit the other apps get nothing, and get the dot again only well under it", () => {
    expect(shareDecision(dot({ accuracyM: SHARE_HOLD_ACCURACY_M }), null).fix).toBeDefined();
    expect(shareDecision(dot({ accuracyM: SHARE_HOLD_ACCURACY_M + 1 }), null)).toEqual({ hold: "uncertain" });
    // Held: a radius between the two limits stays held, so the dot doesn't flicker on and off.
    expect(shareDecision(dot({ accuracyM: SHARE_RESUME_ACCURACY_M + 10 }), "uncertain")).toEqual({ hold: "uncertain" });
    expect(shareDecision(dot({ accuracyM: SHARE_RESUME_ACCURACY_M }), "uncertain").fix).toBeDefined();
    // Another hold before doesn't make the limit stricter.
    expect(shareDecision(dot({ accuracyM: SHARE_RESUME_ACCURACY_M + 10 }), "manual").fix).toBeDefined();
  });

  test("a radius that isn't a number is uncertain", () => {
    expect(shareDecision(dot({ accuracyM: NaN }), null)).toEqual({ hold: "uncertain" });
    expect(shareDecision(dot({ accuracyM: 0 }), null)).toEqual({ hold: "uncertain" });
  });
});

describe("GpsTakeoverPolicy", () => {
  test("trusted GPS stays the phone's; spoofing takes it at once", () => {
    const p = new GpsTakeoverPolicy();
    expect(p.update(0, "TRUSTED", true)).toBe(false);
    expect(p.update(1_000, "UNTRUSTED", true)).toBe(true);
    expect(p.state).toBe("taken");
  });

  test("never taken while nothing is shared: Waze would get no fix either way", () => {
    const p = new GpsTakeoverPolicy();
    expect(p.update(0, "UNTRUSTED", false)).toBe(false);
  });

  test("no fix at the start is a cold GPS until a minute; after trusted GPS it is jamming at once", () => {
    const cold = new GpsTakeoverPolicy();
    expect(cold.update(0, "NO_FIX", true)).toBe(false);
    expect(cold.update(TAKEOVER_NO_FIX_AFTER_START_MS - 1, "NO_FIX", true)).toBe(false);
    expect(cold.update(TAKEOVER_NO_FIX_AFTER_START_MS, "NO_FIX", true)).toBe(true);
    const jammed = new GpsTakeoverPolicy();
    jammed.update(0, "TRUSTED", true);
    expect(jammed.update(5_000, "NO_FIX", true)).toBe(true);
  });

  test("taken, it lets go every two minutes to look, and takes it again when GPS is still bad", () => {
    const p = new GpsTakeoverPolicy();
    p.update(0, "UNTRUSTED", true);
    expect(p.update(TAKEOVER_PROBE_EVERY_MS - 1, "NO_FIX", true)).toBe(true);
    expect(p.update(TAKEOVER_PROBE_EVERY_MS, "NO_FIX", true)).toBe(false);
    expect(p.state).toBe("probing");
    const probe = TAKEOVER_PROBE_EVERY_MS;
    expect(p.update(probe + TAKEOVER_PROBE_MS - 1, "UNTRUSTED", true)).toBe(false);
    expect(p.update(probe + TAKEOVER_PROBE_MS, "UNTRUSTED", true)).toBe(true);
  });

  test("a probe waits for integrity's check of returning fixes, up to its limit", () => {
    const p = new GpsTakeoverPolicy();
    p.update(0, "UNTRUSTED", true);
    const probe = TAKEOVER_PROBE_EVERY_MS;
    p.update(probe, "NO_FIX", true);
    expect(p.update(probe + TAKEOVER_PROBE_MS, "REACQUIRING", true)).toBe(false);
    expect(p.update(probe + TAKEOVER_PROBE_MAX_MS, "REACQUIRING", true)).toBe(true);
  });

  /** Taken at 0 with the satellite fix `at` 1 seen last, then let go for a probe at `probeAt`. */
  const probing = (probeAt = TAKEOVER_PROBE_EVERY_MS) => {
    const p = new GpsTakeoverPolicy();
    const old: ProbeFix = { at: 1, offM: 0, radiusM: 20 };
    p.update(0, "UNTRUSTED", true, old);
    expect(p.update(probeAt, "UNTRUSTED", true, old)).toBe(false);
    return p;
  };
  const spoofed = (at: number): ProbeFix => ({ at, offM: 520_000, radiusM: 20 });

  test("the first spoofed fix of a probe takes the gps provider again at once: Waze saw one fix, not ten seconds", () => {
    const p = probing();
    const probe = TAKEOVER_PROBE_EVERY_MS;
    expect(p.update(probe + 1_500, "UNTRUSTED", true, spoofed(2))).toBe(true);
    expect(p.state).toBe("taken");
    expect(p.spoofedOffM).toBe(520_000);
  });

  test("a probe isn't ended by the fix from before it, a fix near the dot, or one integrity is checking", () => {
    const probe = TAKEOVER_PROBE_EVERY_MS;
    // The last fix before the takeover is still the last one: nothing new came.
    expect(probing().update(probe + 1_000, "UNTRUSTED", true, { at: 1, offM: 520_000, radiusM: 20 })).toBe(false);
    // Near the dot: Waze is barely misled, and integrity may yet trust GPS.
    expect(probing().update(probe + 1_000, "UNTRUSTED", true, { at: 2, offM: TAKEOVER_PROBE_FAR_M, radiusM: 20 })).toBe(false);
    // Far, but within three radii of a wide dot.
    expect(probing().update(probe + 1_000, "UNTRUSTED", true, { at: 2, offM: 550, radiusM: 190 })).toBe(false);
    // Integrity sees GPS coming back.
    expect(probing().update(probe + 1_000, "REACQUIRING", true, spoofed(2))).toBe(false);
  });

  test("each probe a spoofed fix ended doubles the wait for the next, up to its limit", () => {
    const p = probing();
    let t = TAKEOVER_PROBE_EVERY_MS;
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      p.update(t + 1_000, "UNTRUSTED", true, spoofed(10 + i));
      t += 1_000;
      waits.push(p.probeEveryMs);
      expect(p.update(t + p.probeEveryMs - 1, "UNTRUSTED", true, spoofed(10 + i))).toBe(true);
      t += p.probeEveryMs;
      expect(p.update(t, "UNTRUSTED", true, spoofed(10 + i))).toBe(false);
    }
    expect(waits).toEqual([240_000, 480_000, TAKEOVER_PROBE_EVERY_MAX_MS, TAKEOVER_PROBE_EVERY_MAX_MS, TAKEOVER_PROBE_EVERY_MAX_MS]);
  });

  test("a probe without a spoofed fix (jamming: Waze saw nothing) starts the waits over", () => {
    const p = probing();
    const probe = TAKEOVER_PROBE_EVERY_MS;
    p.update(probe + 1_000, "UNTRUSTED", true, spoofed(2));
    expect(p.probeEveryMs).toBe(240_000);
    const next = probe + 1_000 + 240_000;
    p.update(next, "NO_FIX", true, spoofed(2));
    expect(p.update(next + TAKEOVER_PROBE_MS, "NO_FIX", true, spoofed(2))).toBe(true);
    expect(p.probeEveryMs).toBe(TAKEOVER_PROBE_EVERY_MS);
    expect(p.spoofedOffM).toBeNull();
  });

  test("GPS trusted again during a probe gives it back for good", () => {
    const p = new GpsTakeoverPolicy();
    p.update(0, "UNTRUSTED", true);
    p.update(TAKEOVER_PROBE_EVERY_MS, "NO_FIX", true);
    expect(p.update(TAKEOVER_PROBE_EVERY_MS + 6_000, "TRUSTED", true)).toBe(false);
    expect(p.state).toBe("real");
    expect(p.update(TAKEOVER_PROBE_EVERY_MS + 30_000, "TRUSTED", true)).toBe(false);
  });
});
