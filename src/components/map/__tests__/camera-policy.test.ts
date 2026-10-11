import { cameraReducer, INITIAL_CAMERA, RETURN_AFTER_TOUCH_MS, type CameraEvent, type CameraState } from "@/components/map/camera-policy";

const run = (events: CameraEvent[], from: CameraState = INITIAL_CAMERA) => events.reduce(cameraReducer, from);
const drive = (nowMs: number): CameraEvent => ({ type: "driving", nowMs });

describe("map camera policy", () => {
  test("driving off: north-up follow becomes heading-up", () => {
    expect(run([drive(0)]).mode).toBe("follow-heading");
  });

  // 2026-10-11: a destination set while standing showed the alternatives; the map stayed on them for 28 s of driving.
  test("a route's overview (the app's free) ends as soon as the car drives", () => {
    const s = run([{ type: "set", mode: "free" }]);
    expect(s.mode).toBe("free");
    expect(run([drive(1_000)], s).mode).toBe("follow-heading");
  });

  test("a look around while driving returns 10 s after the last touch, not before", () => {
    const s = run([drive(0), { type: "gesture", nowMs: 1_000 }, { type: "gesture", nowMs: 4_000 }]);
    expect(run([drive(4_000 + RETURN_AFTER_TOUCH_MS - 1)], s).mode).toBe("free");
    expect(run([drive(4_000 + RETURN_AFTER_TOUCH_MS)], s).mode).toBe("follow-heading");
  });

  test("standing, a look around stays; once driving it returns when the map has been left alone", () => {
    const s = run([{ type: "gesture", nowMs: 0 }]);
    expect(s.mode).toBe("free");
    // Drives off 30 s after the last touch: back at once.
    expect(run([drive(30_000)], s).mode).toBe("follow-heading");
    // Drives off 3 s after it: 10 s after the touch.
    expect(run([drive(3_000)], s).mode).toBe("free");
    expect(run([drive(3_000), drive(10_000)], s).mode).toBe("follow-heading");
  });

  test("the button: from free heading-up, then north-up; on a trip that becomes the view it drives in", () => {
    let s = run([drive(0), { type: "gesture", nowMs: 0 }, { type: "button", onTrip: true }]);
    expect(s.mode).toBe("follow-heading");
    s = run([{ type: "button", onTrip: true }], s);
    expect(s.mode).toBe("follow");
    // North-up chosen: a look around comes back north-up, and driving keeps it.
    s = run([{ type: "gesture", nowMs: 100_000 }, drive(100_000 + RETURN_AFTER_TOUCH_MS)], s);
    expect(s.mode).toBe("follow");
    // Kept after the trip; the next trip drives heading-up again.
    s = run([{ type: "tripEnded" }], s);
    expect(s.mode).toBe("follow");
    expect(run([drive(0)], s).mode).toBe("follow-heading");
  });

  test("off a trip the button doesn't choose the view a trip drives in", () => {
    const s = run([{ type: "button", onTrip: false }, { type: "button", onTrip: false }]);
    expect(s.mode).toBe("follow");
    expect(run([drive(0)], s).mode).toBe("follow-heading");
  });

  test("placing the car (the screen's follow) doesn't switch heading-up off for the drive", () => {
    const s = run([{ type: "set", mode: "free" }, { type: "set", mode: "follow" }, drive(0)]);
    expect(s.mode).toBe("follow-heading");
  });

  test("the trip ends: heading-up the app chose goes back to north-up", () => {
    expect(run([drive(0), { type: "tripEnded" }]).mode).toBe("follow");
    // A free view is left alone.
    expect(run([drive(0), { type: "gesture", nowMs: 0 }, { type: "tripEnded" }]).mode).toBe("free");
  });
});
