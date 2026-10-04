/** Binary min-heap of (priority, value) pairs; duplicates allowed (the search skips stale entries). */
export class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    const keys = this.keys;
    const values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** The smallest key now (Infinity when empty). */
  peekKey(): number {
    return this.keys.length ? this.keys[0] : Infinity;
  }

  /** Removes the entry with the smallest key and returns its value (undefined when empty). */
  pop(): number | undefined {
    const keys = this.keys;
    const values = this.values;
    if (!keys.length) return undefined;
    const top = values[0];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c];
        values[i] = values[c];
        i = c;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}
