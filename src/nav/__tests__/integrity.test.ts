import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { insideUkraine } from "@/nav/integrity/border";
import { GnssIntegrity, type IntegrityContext } from "@/nav/integrity/integrity";
import { replayTrip } from "@/nav/replay/replay";
import type { GnssFix } from "@/nav/types";

const KYIV = { lat: 50.45, lon: 30.52 };

describe("Ukraine border", () => {
  test.each([
    ["Kyiv", 50.45, 30.52],
    ["Slavutych", 51.52, 30.76],
    ["Chernihiv", 51.49, 31.29],
    ["Uzhhorod", 48.62, 22.29],
    ["Kharkiv", 49.99, 36.23],
    ["Odesa", 46.48, 30.73],
    ["Sevastopol", 44.6, 33.52],
    ["Luhansk", 48.57, 39.31],
  ])("%s is inside", (_, lat, lon) => expect(insideUkraine({ lat, lon })).toBe(true));

  test.each([
    ["Minsk", 53.9, 27.56],
    ["Gomel", 52.44, 31.0],
    ["Moscow", 55.75, 37.62],
    ["Belgorod", 50.6, 36.59],
    ["Chisinau", 47.01, 28.86],
    ["Warsaw", 52.23, 21.01],
    ["Null Island", 0, 0],
  ])("%s is outside", (_, lat, lon) => expect(insideUkraine({ lat, lon })).toBe(false));
});

/** A fix `east` m east of Kyiv at `s` seconds; satellite (with a speed) unless `coarse`. */
function fix(s: number, east = 0, hAccM = 8): GnssFix {
  return { tUs: s * 1e6, lat: KYIV.lat, lon: KYIV.lon + east / (111_320 * Math.cos((KYIV.lat * Math.PI) / 180)), hAccM, speedMps: 0 };
}

/** Phone GNSS only: no OBD speed so far, no dead reckoning. */
const phoneOnly = (s: number): IntegrityContext => ({ distanceM: 0, unknownSpeedS: s, track: null, hypotheses: null });

describe("shown trust (jamming, NAVIGATOR-SPEC §8)", () => {
  /** Feed [accuracyM, seconds] fixes, ≥ 50 m as Wi-Fi/cell ones (as the navigator does); the trust after each. */
  function feed(t: GnssIntegrity, fixes: [number, number][]) {
    return fixes.map(([acc, s]) => {
      if (acc < 50) t.check(fix(s, 0, acc), phoneOnly(s));
      else t.onCoarse(fix(s, 0, acc));
      return t.state(s * 1e6);
    });
  }

  test("trusts the first good fix", () => {
    expect(feed(new GnssIntegrity(), [[8, 0]])).toEqual(["TRUSTED"]);
  });

  test("a single coarse fix in a 1 Hz stream keeps trust", () => {
    expect(feed(new GnssIntegrity(), [[8, 0], [8, 1], [120, 2], [8, 3]])).toEqual(Array(4).fill("TRUSTED"));
  });

  test("trust lapses once good fixes stop for 8 s, and the last trusted fix holds", () => {
    const t = new GnssIntegrity();
    feed(t, [[8, 0], [8, 1]]);
    expect(feed(t, [[200, 5]])).toEqual(["TRUSTED"]);
    expect(t.state(8_900_000)).toBe("TRUSTED");
    expect(t.state(9_100_000)).toBe("NO_FIX");
    expect(feed(t, [[200, 15]])).toEqual(["NO_FIX"]);
    expect(t.lastTrustedFixUs).toBe(1_000_000);
  });

  test("intermittent jamming: leaked GPS fixes between coarse ones don't regain trust", () => {
    const t = new GnssIntegrity();
    feed(t, [[8, 0]]);
    t.state(10_000_000);
    const states = feed(t, [[150, 11], [10, 12], [150, 13], [9, 14], [10, 15], [150, 16]]);
    expect(states.every((s) => s === "NO_FIX")).toBe(true);
  });

  test("regains trust after 5 s of steady good fixes", () => {
    const t = new GnssIntegrity();
    feed(t, [[8, 0]]);
    t.state(10_000_000);
    expect(feed(t, [[10, 20], [10, 21], [10, 22], [10, 23], [10, 24], [10, 25]])).toEqual(["NO_FIX", "NO_FIX", "NO_FIX", "NO_FIX", "NO_FIX", "TRUSTED"]);
  });

  test("Wi-Fi/cell fixes never count as GNSS, however accurate", () => {
    const t = new GnssIntegrity();
    for (const s of [0, 3, 6, 9, 12, 15]) t.onCoarse({ tUs: s * 1e6, ...KYIV, hAccM: 9 });
    expect(t.state(15_000_000)).toBe("NO_FIX");
    // Lock returns: the first satellite fix is trusted (nothing to distrust it against).
    expect(feed(t, [[5, 20], [5, 21]])).toEqual(["TRUSTED", "TRUSTED"]);
  });

  test("a 30–50 m fix keeps trust but does not count toward regaining it", () => {
    const t = new GnssIntegrity();
    feed(t, [[8, 0]]);
    expect(feed(t, [[45, 1], [45, 7]])).toEqual(["TRUSTED", "TRUSTED"]);
    t.state(20_000_000);
    expect(feed(t, [[10, 20], [45, 23], [10, 26]])).toEqual(["NO_FIX", "NO_FIX", "NO_FIX"]);
  });
});

describe("integrity checks (SPEC §3.3)", () => {
  test("a fix outside Ukraine is refused, and trust shows UNTRUSTED until the fixes come back", () => {
    const t = new GnssIntegrity();
    expect(t.check(fix(0), phoneOnly(0)).verdict).toBe("ok");
    expect(t.check({ ...fix(1), lat: 53.9, lon: 27.56 }, phoneOnly(1))).toEqual({ verdict: "outside", detail: "outside Ukraine" });
    expect(t.state(1_000_000)).toBe("UNTRUSTED");
    // Without OBD speed nothing but the reach can judge the fixes that come back: 5 in a row.
    const back = [2, 3, 4, 5, 6].map((s) => t.check(fix(s, 10), phoneOnly(s)).verdict);
    expect(back).toEqual(["reacquiring", "reacquiring", "reacquiring", "reacquiring", "ok"]);
    expect(t.state(6_000_000)).toBe("TRUSTED");
  });

  test("without OBD speed a jump faster than 200 km/h is refused", () => {
    const t = new GnssIntegrity();
    t.check(fix(0), phoneOnly(0));
    expect(t.check(fix(10, 400), phoneOnly(10)).verdict).toBe("ok");
    const r = t.check(fix(11, 5000), phoneOnly(11));
    expect(r.verdict).toBe("jump");
    expect(r.detail).toMatch(/^4\.6 km from the last trusted fix 1 s before, the car could reach \d+ m$/);
  });

  test("with OBD speed, a fix farther than the car drove is a jump", () => {
    const t = new GnssIntegrity();
    const ctx = (s: number, distanceM: number): IntegrityContext => ({ distanceM, unknownSpeedS: 0, track: null, hypotheses: [{ distanceM: 2, sigmaM: 3 }] });
    t.check(fix(0), ctx(0, 0));
    expect(t.check(fix(1, 15), ctx(1, 14)).verdict).toBe("ok");
    expect(t.check(fix(2, 300), ctx(2, 28)).verdict).toBe("jump");
  });
});

// ~2.4 km of town driving with clean GNSS (as navigator.test.ts).
const CITY: DriveSegment[] = [
  { durationS: 5, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 12, yawRateDegS: 0 },
  { durationS: 20, speedMps: 14, yawRateDegS: 0 },
  { durationS: 9, speedMps: 9, yawRateDegS: 10 },
  { durationS: 25, speedMps: 15, yawRateDegS: 0 },
  { durationS: 10, speedMps: 0, yawRateDegS: 0 },
  { durationS: 8, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 11, yawRateDegS: 0 },
  { durationS: 9, speedMps: 9, yawRateDegS: -10 },
  { durationS: 40, speedMps: 16, yawRateDegS: 0 },
  { durationS: 12, speedMps: 10, yawRateDegS: 7.5 },
  { durationS: 30, speedMps: 14, yawRateDegS: 0 },
];
const drive = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0.985, gyroBiasRadS: 0.0002, startHeadingRad: 1 });
const endS = (drive.trip.imu.at(-1)!.tUs - drive.trip.startUs) / 1e6;
const trustAt = (r: ReturnType<typeof replayTrip>, s: number) => r.track.find((p) => p.tS >= s)!.trust;

describe("the navigator under spoofing (synthetic drive)", () => {
  test("clean GNSS: no fix refused, trusted throughout", () => {
    const r = replayTrip(drive.trip);
    expect(r.summary.fixes.untrusted).toBe(0);
    expect(r.track.filter((p) => p.tS > 2).every((p) => p.trust === "TRUSTED")).toBe(true);
  });

  test.each([
    ["static 5 km away", { kind: "static" as const, distanceM: 5000 }, "jump"],
    ["static 300 m away", { kind: "static" as const, distanceM: 300 }, "jump"],
    ["abroad", { kind: "outside" as const }, "outside"],
    ["following the car 1 km off", { kind: "offset" as const, distanceM: 1000 }, "jump"],
  ])("spoofed %s: refused from the first fix, the dot dead-reckons, trust comes back after", (_, spoof, first) => {
    const r = replayTrip(drive.trip, { spoof: [{ ...spoof, fromS: 60, toS: 120 }] });
    const spoofed = r.fixes.filter((f) => f.spoofed);
    expect(spoofed.length).toBeGreaterThan(50);
    expect(spoofed[0].integrity).toBe(first);
    expect(r.summary.integrity.spoofedUsed).toBe(0);
    expect(r.summary.integrity.realRefused).toBe(0);
    expect(trustAt(r, 61)).toBe("UNTRUSTED");
    expect(trustAt(r, 130)).toBe("TRUSTED");
    // Dead reckoning through it: the dot stays with the car.
    const at = r.track.find((p) => p.tS >= 119)!;
    expect(haversineM(at, drive.truthAt(drive.trip.startUs + at.tS * 1e6))).toBeLessThan(25);
    const end = r.track.at(-1)!;
    expect(haversineM(end, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(8);
  });

  test("a spoof after jamming, within the car's reach: held as far, then refused by its shape", () => {
    const r = replayTrip(drive.trip, { jam: [{ fromS: 40, toS: 70 }], spoof: [{ kind: "static", distanceM: 300, fromS: 70, toS: 120 }] });
    const spoofed = r.fixes.filter((f) => f.spoofed);
    expect(spoofed[0].integrity).toBe("far");
    expect(spoofed.some((f) => f.integrity === "shape")).toBe(true);
    expect(r.summary.integrity.spoofedUsed).toBe(0);
    expect(trustAt(r, 130)).toBe("TRUSTED");
  });

  test("fixes that drift away from the dead reckoning without a jump are the car's: the EKF resets onto them", () => {
    // OBD reads 0 all along (the phone left the car with the driver, or a dead speed PID): the fixes move, the
    // dead reckoning doesn't. Without a jump, integrity passes them, and the EKF's own rule resets it.
    const still = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0, startHeadingRad: 1 });
    const r = replayTrip(still.trip);
    expect(r.summary.fixes.untrusted).toBe(0);
    expect(r.summary.fixes.rejected).toBeGreaterThan(0);
  });

  test("without OBD speed, a spoof abroad and a jump are still refused", () => {
    const r = replayTrip({ ...drive.trip, obdSpeed: [] }, { spoof: [{ kind: "outside", fromS: 60, toS: 80 }, { kind: "static", distanceM: 50_000, fromS: 100, toS: 120 }] });
    const spoofed = r.fixes.filter((f) => f.spoofed);
    expect(spoofed.filter((f) => f.tS < 80).every((f) => f.integrity === "outside")).toBe(true);
    expect(spoofed.find((f) => f.tS >= 100)!.integrity).toBe("jump");
    expect(r.summary.integrity.spoofedUsed).toBe(0);
    expect(endS).toBeGreaterThan(120);
  });
});
