import { dropPlace } from "../use-stop-drag";

// Three stops' rows, 58 pt each with a 1 pt line between them (the route page's trip).
const rows = [0, 59, 118].map((top) => ({ top, height: 58 }));

describe("dropPlace (STOPS-SPEC §7.1)", () => {
  test("stays until its middle passes the next row's middle", () => {
    expect(dropPlace(rows, 3, 0, 0)).toBe(0);
    expect(dropPlace(rows, 3, 0, 58)).toBe(0);
    expect(dropPlace(rows, 3, 0, 60)).toBe(1);
  });

  test("down past several, up past several, never beyond the ends", () => {
    expect(dropPlace(rows, 3, 0, 125)).toBe(2);
    expect(dropPlace(rows, 3, 0, 900)).toBe(2);
    expect(dropPlace(rows, 3, 2, -60)).toBe(1);
    expect(dropPlace(rows, 3, 2, -125)).toBe(0);
    expect(dropPlace(rows, 3, 1, -900)).toBe(0);
  });

  test("a row not laid out yet stays where it is", () => {
    expect(dropPlace([], 3, 1, 100)).toBe(1);
  });
});
