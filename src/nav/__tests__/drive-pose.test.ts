import { carryDrivePose, DRIVE_POSE_MAX_AGE_S } from "@/nav/drive-pose";
import { haversineM } from "@/nav/geo";

const POSE = { lat: 51.47, lon: 31.18, headingRad: Math.PI / 2, posSigmaM: 30, headingSigmaRad: 0.05, speedMps: 28 };

test("carried on east along its heading at its speed, the circle and heading widened for the time off", () => {
  const c = carryDrivePose(POSE, 30)!;
  expect(c.carriedM).toBeCloseTo(840);
  expect(haversineM(POSE, c)).toBeCloseTo(840, 0);
  expect(c.lat).toBeCloseTo(POSE.lat, 4);
  expect(c.lon).toBeGreaterThan(POSE.lon);
  expect(c.posSigmaM).toBeCloseTo(Math.hypot(30, 0.3 * 840));
  expect(c.headingRad).toBe(POSE.headingRad);
  expect(c.headingSigmaRad).toBeCloseTo(Math.hypot(0.05, (30 * Math.PI) / 180));
});

test("the heading's σ stops at 45°; too old or from the future, not used", () => {
  expect(carryDrivePose(POSE, DRIVE_POSE_MAX_AGE_S)!.headingSigmaRad).toBeCloseTo(Math.PI / 4);
  expect(carryDrivePose(POSE, DRIVE_POSE_MAX_AGE_S + 1)).toBeNull();
  expect(carryDrivePose(POSE, -5)).toBeNull();
  expect(carryDrivePose(POSE, NaN)).toBeNull();
});
