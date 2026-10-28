import { SpeedWarning } from "@/nav/speed/speed-warning";

describe("SpeedWarning", () => {
  test("red only past limit + margin, after holding there; one chime", () => {
    const w = new SpeedWarning();
    expect(w.update(62, 50, 15, 0)).toEqual({ over: false, chime: false }); // within the margin: fine
    expect(w.update(65, 50, 15, 1000)).toEqual({ over: false, chime: false }); // at the line
    expect(w.update(67, 50, 15, 2000)).toEqual({ over: false, chime: false }); // over, not yet for long
    expect(w.update(68, 50, 15, 3500)).toEqual({ over: true, chime: true });
    expect(w.update(70, 50, 15, 4500)).toEqual({ over: true, chime: false });
  });

  test("hovering at the line keeps it on; back under ends it, and the next time chimes again", () => {
    const w = new SpeedWarning();
    w.update(70, 50, 15, 0);
    expect(w.update(70, 50, 15, 2000).chime).toBe(true);
    expect(w.update(63, 50, 15, 3000)).toEqual({ over: true, chime: false });
    expect(w.update(62, 50, 15, 4000)).toEqual({ over: false, chime: false });
    w.update(70, 50, 15, 5000);
    expect(w.update(70, 50, 15, 7000).chime).toBe(true);
  });

  test("a moment over (overtaking, a speed spike) does nothing", () => {
    const w = new SpeedWarning();
    w.update(70, 50, 15, 0);
    expect(w.update(60, 50, 15, 1000).over).toBe(false);
    expect(w.update(70, 50, 15, 2000).over).toBe(false);
  });

  test("no limit, or no speed: not red, and never a warning started", () => {
    const w = new SpeedWarning();
    w.update(90, 50, 15, 0);
    expect(w.update(90, 50, 15, 2000).over).toBe(true);
    expect(w.update(90, undefined, 15, 2500).over).toBe(false);
    expect(w.update(undefined, 50, 15, 3000).over).toBe(false);
    const fresh = new SpeedWarning();
    expect(fresh.update(90, undefined, 15, 0)).toEqual({ over: false, chime: false });
    expect(fresh.update(90, undefined, 15, 5000)).toEqual({ over: false, chime: false });
  });

  test("the sign gone a while and back, still too fast: red again without a second chime", () => {
    const w = new SpeedWarning();
    w.update(80, 50, 15, 0);
    expect(w.update(80, 50, 15, 2000).chime).toBe(true);
    expect(w.update(80, undefined, 15, 4000)).toEqual({ over: false, chime: false });
    expect(w.update(80, undefined, 15, 9000)).toEqual({ over: false, chime: false });
    expect(w.update(80, 50, 15, 10_000)).toEqual({ over: true, chime: false });
  });

  test("a long gap ends the warning: the next stretch chimes", () => {
    const w = new SpeedWarning();
    w.update(80, 50, 15, 0);
    w.update(80, 50, 15, 2000);
    w.update(80, undefined, 15, 3000);
    expect(w.update(80, undefined, 15, 33_000).over).toBe(false);
    w.update(80, 50, 15, 34_000);
    expect(w.update(80, 50, 15, 36_000).chime).toBe(true);
  });
});
