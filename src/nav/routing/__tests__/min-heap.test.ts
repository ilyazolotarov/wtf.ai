import { MinHeap } from "../min-heap";

describe("MinHeap", () => {
  test("pops in key order across growth, duplicates included", () => {
    const heap = new MinHeap();
    let seed = 7;
    const keys: number[] = [];
    for (let i = 0; i < 5000; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const key = seed % 1000;
      keys.push(key);
      heap.push(key, i);
    }
    expect(heap.size).toBe(5000);
    const popped: number[] = [];
    while (heap.size) {
      popped.push(heap.peekKey());
      heap.pop();
    }
    expect(popped).toEqual([...keys].sort((a, b) => a - b));
    expect(heap.pop()).toBeUndefined();
    expect(heap.peekKey()).toBe(Infinity);
  });
});
