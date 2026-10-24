import { screenGravity, turnFor, type MapTurn } from "@/components/map/map-turn";

jest.mock("@/services/runtime", () => ({}));
jest.mock("../../../../modules/sensor-capture/src/SensorCaptureModule", () => ({}));

/** Gravity in the phone's frame (x to the screen's right, y to its top, z out of it) with the phone turned `deg` clockwise from upright, leaning back `leanDeg`. */
function gravity(deg: number, leanDeg = 20): [number, number, number] {
  const a = (deg * Math.PI) / 180;
  const lean = (leanDeg * Math.PI) / 180;
  const inPlane = Math.cos(lean);
  // Upright, gravity points to the screen's bottom (-y). Turning the phone clockwise turns it toward the screen's right.
  return [Math.sin(a) * inPlane, -Math.cos(a) * inPlane, -Math.sin(lean)];
}

describe("the map's turn for how the phone is held", () => {
  test.each<[string, number, MapTurn]>([
    ["upright", 0, 0],
    ["turned left (the screen's right side up)", -90, 90],
    ["turned right (the screen's left side up)", 90, -90],
    ["upside down", 180, 180],
  ])("%s", (_, deg, turn) => {
    expect(turnFor(gravity(deg), 0)).toBe(turn);
    expect(turnFor(gravity(deg), turn)).toBe(turn);
  });

  test("near the diagonal, the turn it has stays", () => {
    expect(turnFor(gravity(-50), 0)).toBe(0);
    expect(turnFor(gravity(-50), 90)).toBe(90);
    expect(turnFor(gravity(-40), 90)).toBe(90);
    // Well past it, it changes.
    expect(turnFor(gravity(-65), 0)).toBe(90);
    expect(turnFor(gravity(-25), 90)).toBe(0);
  });

  test("lying flat (gravity through the screen), the turn it has stays", () => {
    expect(turnFor(gravity(-90, 75), 0)).toBe(0);
    expect(turnFor(gravity(0, 75), 90)).toBe(90);
    expect(turnFor([0, 0, -9.81], -90)).toBe(-90);
  });

  test("units don't matter: m/s² as g", () => {
    const [x, y, z] = gravity(-90);
    expect(turnFor([x * 9.81, y * 9.81, z * 9.81], 0)).toBe(90);
  });
});

describe("a tablet that turns its window itself", () => {
  // Display.getRotation: the window turned counter-clockwise, as the device was (turned left = -90 clockwise here).
  test.each<[string, number, number]>([
    ["portrait, the device turned left", -90, 90],
    ["portrait, the device turned right", 90, 270],
    ["landscape the other way up", 180, 180],
  ])("%s: the map needs no turn of its own", (_, deg, rotation) => {
    expect(turnFor(screenGravity(gravity(deg), rotation), 0)).toBe(0);
  });

  test("with auto-rotate off (the window kept), the map still turns", () => {
    expect(turnFor(screenGravity(gravity(-90), 0), 0)).toBe(90);
    // Window at 90, the device turned back upright: the map turns the other way.
    expect(turnFor(screenGravity(gravity(0), 90), 0)).toBe(-90);
  });

  test("no rotation leaves gravity as it is", () => {
    const g = gravity(30);
    expect(screenGravity(g, 0)).toBe(g);
  });
});
