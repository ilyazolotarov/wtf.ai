import { readFileSync } from "node:fs";
import path from "node:path";

import { DrEkf } from "@/nav/ekf/dr-ekf";
import { alignHeading, type AlignPoint } from "@/nav/ekf/heading-align";
import { LocalFrame } from "@/nav/geo/local-frame";
import { ImuProcessor } from "@/nav/odometry/imu/imu-processor";
import type { ImuSample } from "@/nav/types";
import { readTripLog } from "@/triplog/trip-log-reader";

const G = 9.80665;

describe("LocalFrame", () => {
  test("round-trips and measures metres", () => {
    const f = new LocalFrame({ lat: 51.52, lon: 30.76 });
    const [e, n] = f.toEnu({ lat: 51.53, lon: 30.78 });
    expect(n).toBeCloseTo(1112, 0);
    expect(e).toBeCloseTo(1384, -1);
    const c = f.toCoordinate(e, n);
    expect(c.lat).toBeCloseTo(51.53, 9);
    expect(c.lon).toBeCloseTo(30.78, 9);
  });
});

describe("DrEkf", () => {
  const init = { east: 0, north: 0, psi: 0, speed: 10, posSigma: 5, psiSigma: 0.05, speedSigma: 0.5 };

  test("drives north, then a left turn of 90° turns the heading to west", () => {
    const ekf = new DrEkf(init);
    for (let i = 0; i < 100; i++) ekf.predict(0.01, 0);
    expect(ekf.north).toBeCloseTo(10, 6);
    expect(ekf.east).toBeCloseTo(0, 6);
    // Counter-clockwise π/2 rad over 10 s → heading −90° (west), clockwise convention.
    for (let i = 0; i < 1000; i++) ekf.predict(0.01, Math.PI / 20);
    expect(ekf.psi).toBeCloseTo(-Math.PI / 2, 6);
    expect(ekf.east).toBeLessThan(-50);
  });

  test("position uncertainty grows without updates and shrinks with a fix", () => {
    const ekf = new DrEkf(init);
    for (let i = 0; i < 6000; i++) ekf.predict(0.01, 0);
    const grown = ekf.positionSigma;
    expect(grown).toBeGreaterThan(20);
    const r = ekf.updatePosition(3, -2, 3, 16);
    expect(r.accepted).toBe(true);
    expect(ekf.positionSigma).toBeLessThan(4);
  });

  test("a position far outside the predicted uncertainty is gated", () => {
    const ekf = new DrEkf(init);
    const r = ekf.updatePosition(500, 0, 3, 16);
    expect(r.accepted).toBe(false);
    expect(r.nis).toBeGreaterThan(16);
    expect(ekf.east).toBe(0);
  });

  test("OBD speed vs GNSS speed estimates the speed scale", () => {
    const ekf = new DrEkf({ ...init, speed: 0 });
    for (let i = 0; i < 300; i++) {
      ekf.predict(0.1, 0);
      ekf.updateObdSpeed(14, 0.3); // OBD 14 m/s
      if (i % 10 === 0) ekf.updateSpeed(14.28 - ekf.speed, 0.2, Infinity); // GNSS 2 % faster
    }
    expect(ekf.params().ks).toBeCloseTo(1.02, 2);
  });

  test("standstill yaw measures the bias", () => {
    const ekf = new DrEkf({ ...init, speed: 0 });
    // The prior is tight (CoreMotion is bias-corrected), so it takes a couple of minutes of stops.
    for (let i = 0; i < 120; i++) ekf.updateGyroBias(0.001, 0.002);
    expect(ekf.params().bw).toBeCloseTo(0.001, 3);
  });
});

describe("alignHeading", () => {
  const track = (theta: number, noise: (i: number) => [number, number], sigma = 40): AlignPoint[] =>
    Array.from({ length: 12 }, (_, i) => {
      // L-shaped relative track: 600 m east, then 400 m north.
      const relE = i < 7 ? i * 100 : 600;
      const relN = i < 7 ? 0 : (i - 6) * 80;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const [ne, nn] = noise(i);
      return { relE, relN, worldE: c * relE - s * relN + 1000 + ne, worldN: s * relE + c * relN - 500 + nn, sigma };
    });
  const noise = (i: number): [number, number] => [((i * 37) % 11) * 6 - 30, ((i * 53) % 13) * 5 - 30];

  test("recovers the rotation and translation from noisy fixes", () => {
    const a = alignHeading(track(0.7, noise))!;
    expect(a).not.toBeNull();
    expect(Math.abs(a.theta - 0.7)).toBeLessThan(0.05);
    expect(a.thetaSigma).toBeLessThan(0.1);
    expect(a.tE).toBeCloseTo(1000, -2);
  });

  test("drops an outlier", () => {
    const pts = track(-1.2, noise);
    pts[4] = { ...pts[4], worldE: pts[4].worldE + 600 };
    const a = alignHeading(pts)!;
    expect(a.used).toBe(11);
    expect(Math.abs(a.theta + 1.2)).toBeLessThan(2 * a.thetaSigma);
  });

  test("refuses when the fixes don't spread out enough", () => {
    const pts = track(0.3, noise).map((p) => ({ ...p, relE: p.relE / 20, relN: p.relN / 20 }));
    expect(alignHeading(pts)).toBeNull();
  });
});

describe("ImuProcessor", () => {
  const sample = (tUs: number, gyro: [number, number, number], tilt = 0): ImuSample => ({
    tUs,
    gyro,
    gravity: [0, G * Math.sin(tilt), -G * Math.cos(tilt)],
    userAccel: [0, 0, 0],
  });

  test("yaw rate about the vertical, counter-clockwise positive, independent of mount tilt", () => {
    const p = new ImuProcessor();
    expect(p.process(sample(0, [0, 0, 0.2])).yawRate).toBeCloseTo(0.2, 6);
    // Phone pitched 60°: the car's yaw shows up split across device y and z.
    const tilt = Math.PI / 3;
    const q = new ImuProcessor();
    const out = q.process(sample(0, [0, -0.2 * Math.sin(tilt), 0.2 * Math.cos(tilt)], tilt));
    expect(out.yawRate).toBeCloseTo(0.2, 6);
  });

  test("handling: the phone tilted slowly (the gyro turning it off the vertical) invalidates the gyro; a spike doesn't", () => {
    const p = new ImuProcessor();
    let t = 0;
    for (let i = 0; i < 300; i++) expect(p.process(sample((t += 10_000), [0, 0, 0])).valid).toBe(true);
    expect(p.process(sample((t += 10_000), [1.9, 0, 0])).valid).toBe(true);
    // 0.4 rad/s about x for 1 s: under the rate test, 23° of tilt. (A vertical seen from the phone turns by −ω × it.)
    let invalid = false;
    let tilt = 0;
    for (let i = 0; i < 100; i++) invalid ||= !p.process(sample((t += 10_000), [-0.4, 0, 0], (tilt += 0.004))).valid;
    expect(invalid).toBe(true);
  });

  // 2026-10-14: Android's gravity estimate leans with the car's sideways acceleration, 16° in a turn at 25 km/h;
  // read as handling, it dropped 12–48 % of a drive's turning.
  test("a turn leaning the gravity estimate without turning the phone off the vertical is no handling", () => {
    const p = new ImuProcessor();
    let t = 0;
    for (let i = 0; i < 300; i++) p.process(sample((t += 10_000), [0, 0, 0]));
    const lean = (16 * Math.PI) / 180;
    for (let i = 0; i < 500; i++) {
      const tilt = lean * Math.sin((Math.PI * i) / 500);
      expect(p.process(sample((t += 10_000), [0, 0, 0.4], tilt)).valid).toBe(true);
    }
  });

  /** Off-vertical rotation about x swinging at `hz` with peak `amp` rad/s, and a yaw rate about the vertical. */
  const wobble = (tUs: number, amp: number, hz: number, yaw = 0): ImuSample => sample(tUs, [amp * Math.sin((2 * Math.PI * hz * tUs) / 1e6), 0, yaw]);

  // u37h65 (2026-10-21): held in a hand for 4 min before driving off, the gyro read valid in the hand's still moments
  // and the navigator took 60° of its turning for a manoeuvre.
  test("standing: a hand's still moments don't bring the gyro back; 3 s as still as a mount do", () => {
    const p = new ImuProcessor();
    let t = 0;
    for (let i = 0; i < 300; i++) p.process(sample((t += 10_000), [0, 0, 0]), 0);
    // Fidgeting in a hand: under the old tilt and rate triggers, but never as still as a mount (seen within its 1 s RMS).
    let valid = 0;
    for (let i = 0; i < 1000; i++) if (p.process(wobble((t += 10_000), 0.35, 1, 0.05), 0).valid && i >= 100) valid++;
    expect(valid).toBe(0);
    // Held still for 2 s between moves (a hand rests): still in the hand.
    for (let i = 0; i < 200; i++) expect(p.process(sample((t += 10_000), [0, 0, 0.02]), 0).valid).toBe(false);
    for (let i = 0; i < 100; i++) p.process(wobble((t += 10_000), 0.35, 1, -0.05), 0);
    // Into the mount: valid again once still for 3 s.
    let back = -1;
    for (let i = 0; i < 600 && back < 0; i++) if (p.process(sample((t += 10_000), [0, 0, 0]), 0).valid) back = i;
    expect(back).toBeGreaterThan(300);
    expect(back).toBeLessThan(450);
  });

  test("the same fidgeting without the car's speed, or driving, is left to the old triggers", () => {
    for (const speed of [undefined, null, 15]) {
      const p = new ImuProcessor();
      let t = 0;
      for (let i = 0; i < 300; i++) p.process(sample((t += 10_000), [0, 0, 0]), speed);
      let invalid = 0;
      for (let i = 0; i < 1000; i++) if (!p.process(wobble((t += 10_000), 0.35, 1), speed).valid) invalid++;
      expect(invalid).toBe(0);
    }
  });

  // qkxjpt (2026-10-05): back in the mount, reversing out of the parking space (OBD 0 in reverse) shook it to an RMS
  // of 0.18 rad/s; read as a hand, the 51° turn out of the space was lost and the drive set off 63° wrong.
  test("standing, a mounted phone shaken by a manoeuvre keeps its turning", () => {
    const p = new ImuProcessor();
    let t = 0;
    for (let i = 0; i < 300; i++) p.process(sample((t += 10_000), [0, 0, 0]), 0);
    let turned = 0;
    for (let i = 0; i < 500; i++) {
      const out = p.process(wobble((t += 10_000), 0.22, 4, 0.18), 0);
      expect(out.valid).toBe(true);
      turned += out.yawRate * 0.01;
    }
    expect(turned).toBeCloseTo(0.9, 1);
  });

  test("moving: a turn without the car's sideways push is the phone's; a car's turn has it", () => {
    const yaw = 0.15;
    const speed = 15;
    // The phone turned in a hand: no push across the vertical.
    const p = new ImuProcessor();
    let t = 0;
    for (let i = 0; i < 300; i++) p.process(sample((t += 10_000), [0, 0, 0]), speed);
    let invalid = 0;
    for (let i = 0; i < 200; i++) if (!p.process(sample((t += 10_000), [0, 0, yaw]), speed).valid) invalid++;
    expect(invalid).toBeGreaterThan(100);
    // The car turned: v·ω of push sideways.
    const q = new ImuProcessor();
    t = 0;
    for (let i = 0; i < 300; i++) q.process(sample((t += 10_000), [0, 0, 0]), speed);
    for (let i = 0; i < 200; i++) {
      const s = { ...sample((t += 10_000), [0, 0, yaw]), userAccel: [speed * yaw, 0, 0] as [number, number, number] };
      expect(q.process(s, speed).valid).toBe(true);
    }
  });

  test("quiet after a still second; a slow turn isn't quiet", () => {
    const p = new ImuProcessor();
    let out = p.process(sample(0, [0, 0, 0.001]));
    for (let i = 1; i <= 120; i++) out = p.process(sample(i * 10_000, [0, 0, 0.001]));
    expect(out.quiet).toBe(true);
    expect(out.windowMeanYaw).toBeCloseTo(0.001, 6);
    const q = new ImuProcessor();
    for (let i = 0; i <= 120; i++) out = q.process(sample(i * 10_000, [0, 0, 0.05]));
    expect(out.quiet).toBe(false);
  });
});

describe("readTripLog", () => {
  test("decodes the shared fixture into sensor streams", () => {
    const bytes = new Uint8Array(readFileSync(path.join(__dirname, "../../../tools/triplog/tests/data/fixture.ulg")));
    const trip = readTripLog(bytes);
    expect(trip.imu).toHaveLength(100);
    expect(trip.imu[0].gravity[2]).toBeCloseTo(-G, 4);
    // 10 polls, one without data; sample time = rx − latency / 2.
    expect(trip.obdSpeed).toHaveLength(9);
    expect(trip.obdSpeed[1]).toMatchObject({ tUs: 10_000_000 + 100_000 - 20_000, rawKph: 10 });
    expect(trip.gnss).toHaveLength(3);
    expect(trip.gnss[2]).toMatchObject({ hAccM: 4.5, speedMps: 12 });
    expect(trip.gnss[2].courseRad).toBeCloseTo(0.25, 6);
    expect(trip.info.vehicle_vin).toBe("JM3KFBDM1J0123456");
  });
});
