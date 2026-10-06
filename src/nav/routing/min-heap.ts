/**
 * Binary min-heap of (priority, value) pairs; duplicates allowed (the search skips stale entries). Typed arrays
 * that grow by doubling: a long search pushes millions of entries, and plain arrays cost an allocation each.
 */
export class MinHeap {
  private keys = new Float64Array(1024);
  private values = new Int32Array(1024);
  private n = 0;

  get size(): number {
    return this.n;
  }

  push(key: number, value: number): void {
    if (this.n === this.keys.length) this.grow();
    const keys = this.keys;
    const values = this.values;
    let i = this.n++;
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
    return this.n ? this.keys[0] : Infinity;
  }

  /** Removes the entry with the smallest key and returns its value (undefined when empty). */
  pop(): number | undefined {
    if (!this.n) return undefined;
    const keys = this.keys;
    const values = this.values;
    const top = values[0];
    const n = --this.n;
    if (n) {
      const lastKey = keys[n];
      const lastValue = values[n];
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

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    keys.set(this.keys);
    const values = new Int32Array(this.values.length * 2);
    values.set(this.values);
    this.keys = keys;
    this.values = values;
  }
}
