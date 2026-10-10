import { turnFor, type MapTurn } from "@/components/map/map-turn";

jest.mock("@/services/runtime", () => ({}));

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
