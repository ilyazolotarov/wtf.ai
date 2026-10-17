import { parseSpeedProfile, speedAt } from "../driving-emulator";

describe("speed profile", () => {
  it("reads seconds:km/h points in time order", () => {
    expect(parseSpeedProfile("0:0,10:0,22:50")).toEqual([
      [0, 0],
      [10, 0],
      [22, 50],
    ]);
    expect(parseSpeedProfile("0:0,10:20.5")).toEqual([
      [0, 0],
      [10, 20.5],
    ]);
  });

  it("refuses what isn't one", () => {
    for (const spec of [undefined, "", "0:0", "0:0,10", "0:0,x:5", "0:0,10:-1", "0:0,10:5,10:6", "5:0,2:5"]) {
      expect(parseSpeedProfile(spec)).toBeNull();
    }
  });

  it("goes straight between the points and holds the last", () => {
    const p = parseSpeedProfile("0:0,10:0,20:50,30:20")!;
    expect(speedAt(p, -1)).toBe(0);
    expect(speedAt(p, 5)).toBe(0);
    expect(speedAt(p, 15)).toBe(25);
    expect(speedAt(p, 25)).toBe(35);
    expect(speedAt(p, 99)).toBe(20);
  });
});
