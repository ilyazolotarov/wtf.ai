import { launchedOnTheWay, OnTheWay, ON_THE_WAY_WITHIN_S, poseAfterWake, WAKE_FIX_BEFORE_LAUNCH_MS } from "@/services/on-the-way";

const launch = { wallMs: 0, uptimeUs: 1e9, inBackground: true, reasons: ["location"] };

test("on the way: launched in the background for location, a moment ago", () => {
  expect(launchedOnTheWay(launch, 1e9 + 5e6)).toBe(true);
  expect(launchedOnTheWay(launch, 1e9 + (ON_THE_WAY_WITHIN_S + 1) * 1e6)).toBe(false);
  expect(launchedOnTheWay({ ...launch, inBackground: false }, 1e9)).toBe(false);
  expect(launchedOnTheWay({ ...launch, reasons: ["bluetooth"] }, 1e9)).toBe(false);
});

test("the map's card: shown once the pose is behind and a trip records, cleared once found", () => {
  const s = new OnTheWay();
  const seen: boolean[] = [];
  s.subscribe(() => seen.push(s.get()));
  s.behind();
  expect(s.get()).toBe(false);
  s.setRecording(true);
  s.behind();
  s.clear();
  expect(seen).toEqual([true, false]);
});

test("no trip: the phone went off without the car, no card", () => {
  const s = new OnTheWay();
  s.behind();
  s.setRecording(false);
  expect(s.get()).toBe(false);
});

describe("the parked pose after a relaunch on the way", () => {
  const nowUs = 1e9 + 5e6;
  const pose = { lat: 50.45, lon: 30.52, savedAt: -3_600_000 };
  const fix = (northM: number, accuracyM: number, wallMs = 0) => ({ lat: 50.45 + northM / 111_195, lon: 30.52, accuracyM, wallMs });

  test("not relaunched on the way: as before", () => {
    expect(poseAfterWake({ ...launch, inBackground: false }, nowUs, fix(0, 20), pose)).toBe("not woken");
  });

  test("the relaunch's location far from it: the car drove off", () => {
    expect(poseAfterWake(launch, nowUs, fix(600, 65), pose)).toBe("behind");
  });

  test("near it, accuracy included: the car still stands there", () => {
    expect(poseAfterWake(launch, nowUs, fix(60, 65), pose)).toBe("standing");
  });

  test("near it, but too coarse to tell: behind, the safe side", () => {
    expect(poseAfterWake(launch, nowUs, fix(60, 500), pose)).toBe("behind");
  });

  test("no location, or one cached from before the drive: behind", () => {
    expect(poseAfterWake(launch, nowUs, null, pose)).toBe("behind");
    expect(poseAfterWake(launch, nowUs, fix(0, 20, -WAKE_FIX_BEFORE_LAUNCH_MS - 1), pose)).toBe("behind");
  });
});
