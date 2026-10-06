import { heaviestFirst } from "@/nav/mapmatch/weight-order";

const comparatorOrder = (logw: Float64Array) => Array.from({ length: logw.length }, (_, i) => i).sort((a, b) => logw[b] - logw[a]);

describe("heaviestFirst", () => {
  test("the order of the comparator sort, ties included", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const size of [0, 1, 2, 5, 500, 4000]) {
      const logw = new Float64Array(size);
      // Few distinct values (many ties), and the edge values of a filter's weights.
      const values = [-0, 0, -Infinity, Infinity, -1e-300, -745.2, -3.5, -1];
      for (let i = 0; i < size; i++) logw[i] = rand() < 0.5 ? values[Math.floor(rand() * values.length)] : -50 * rand();
      expect(heaviestFirst(logw, size)).toEqual(comparatorOrder(logw));
    }
  });

  test("a NaN weight falls back to the comparator sort", () => {
    const logw = new Float64Array([-1, NaN, -2, -1]);
    expect(heaviestFirst(logw, 4)).toEqual(comparatorOrder(logw));
  });
});
