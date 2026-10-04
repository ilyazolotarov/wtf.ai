import { syntheticCompassCalibration } from "@/nav/__fixtures__/synthetic-drive";
import { Compass, rotateCalibration } from "@/nav/compass/compass";
import type { Vec3 } from "@/nav/types";

const DEG = Math.PI / 180;
const OFFSET: Vec3 = [45, 135, 60];
const angleDeg = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) / DEG;

/** Drive straight at heading `psi` for 1.2 s (flat phone, x forward), optionally tilted, then return the time. */
function hold(compass: Compass, tUs: number, psi: number, up: Vec3 = [0, 0, 1]): number {
  for (let k = 0; k < 120; k++, tUs += 10_000) {
    compass.onImu(tUs, up, 0, true);
    if (k % 5 === 0) compass.onMag(tUs, [OFFSET[0] + 19 * Math.cos(psi), OFFSET[1] + 19 * Math.sin(psi), OFFSET[2] - 46]);
  }
  return tUs;
}

describe("Compass", () => {
  test("learned from known headings, it gives the heading despite a field offset 7× Earth's", () => {
    const compass = new Compass();
    compass.setCalibration(syntheticCompassCalibration());
    for (const deg of [0, 37, 123, 250, 359]) {
      hold(compass, deg * 1e7, deg * DEG);
      expect(angleDeg(compass.heading()!.psi, deg * DEG)).toBeLessThan(1);
    }
  });

  test("nothing until a calibration covers enough headings", () => {
    const compass = new Compass();
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t = hold(compass, t, 30 * DEG);
      compass.observe(30 * DEG);
    }
    // 100 samples, all one heading: the offset can't be told from Earth's field.
    expect(compass.heading()).toBeNull();
    expect(compass.trust).toBe("none");
  });

  test("a calibration turned 90° is rejected by the known heading; the drive then learns its own", () => {
    const compass = new Compass();
    compass.setCalibration(rotateCalibration(syntheticCompassCalibration(), 90 * DEG));
    let t = hold(compass, 0, 10 * DEG);
    expect(compass.trust).toBe("unverified");
    expect(angleDeg(compass.heading()!.psi, 10 * DEG)).toBeGreaterThan(80);
    for (let i = 0; i < 10; i++) {
      t = hold(compass, t, 10 * DEG);
      compass.observe(10 * DEG);
    }
    expect(compass.trust).toBe("rejected");
    expect(compass.heading()).toBeNull();
    for (let pass = 0; pass < 2; pass++) {
      for (let deg = 0; deg < 360; deg += 10) {
        t = hold(compass, t, deg * DEG);
        compass.observe(deg * DEG);
      }
    }
    expect(compass.trust).toBe("confirmed");
    hold(compass, t, 200 * DEG);
    expect(angleDeg(compass.heading()!.psi, 200 * DEG)).toBeLessThan(1);
  });

  test("a right calibration is confirmed", () => {
    const compass = new Compass();
    compass.setCalibration(syntheticCompassCalibration());
    let t = 0;
    for (let i = 0; i < 10; i++) {
      t = hold(compass, t, 300 * DEG);
      compass.observe(300 * DEG);
    }
    expect(compass.trust).toBe("confirmed");
  });

  test("no heading while the phone is tilted away from its mounting, or handled", () => {
    const compass = new Compass();
    compass.setCalibration(syntheticCompassCalibration());
    const tilted: Vec3 = [0, Math.sin(20 * DEG), Math.cos(20 * DEG)];
    let t = hold(compass, 0, 0, tilted);
    expect(compass.heading()).toBeNull();
    t = hold(compass, t, 0);
    expect(compass.heading()).not.toBeNull();
    compass.onImu(t, [0, 0, 1], 0, false);
    expect(compass.heading()).toBeNull();
  });
});
