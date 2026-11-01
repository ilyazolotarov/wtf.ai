import { KeyIndex } from "../key-index";

describe("KeyIndex", () => {
  it("answers as a Map does, through growth, overwrites and keys past 2^32", () => {
    const index = new KeyIndex(4);
    const map = new Map<number, number>();
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let n = 0; n < 50_000; n++) {
      // Directed-edge keys: 2 × (tile × 65,536 + index) + direction, tiles up to 100,000.
      const key = 2 * (Math.floor(rand() * 100_000) * 65536 + Math.floor(rand() * 2000)) + (rand() < 0.5 ? 0 : 1);
      index.set(key, n);
      map.set(key, n);
    }
    expect(index.size).toBe(map.size);
    for (const [key, value] of map) expect(index.get(key)).toBe(value);
    expect(index.get(2 ** 40 + 1)).toBe(-1);
    expect(index.get(0)).toBe(map.get(0) ?? -1);
  });

  it("keeps keys that collide in their slot apart", () => {
    const index = new KeyIndex(1);
    // Keys 2^32 apart share their low half.
    for (let k = 0; k < 64; k++) index.set(5 + k * 2 ** 32, k);
    for (let k = 0; k < 64; k++) expect(index.get(5 + k * 2 ** 32)).toBe(k);
    expect(index.get(6)).toBe(-1);
  });
});
