// Particle indices by weight, for the filter's clustering (§7.6), which runs after every odometry chunk.

let keys = new Float64Array(0);
let seen = new Int32Array(0);

/**
 * Indices 0…size−1, heaviest log-weight first, equal weights in index order: what the stable
 * `.sort((a, b) => logw[b] - logw[a])` gives, without calling a comparator N·log N times. The weights are sorted
 * natively and each index goes to its weight's rank (the next free place among equal ones). A NaN weight has no
 * rank: then the comparator sort, as before.
 */
export function heaviestFirst(logw: ArrayLike<number>, size: number): number[] {
  if (keys.length < size) {
    keys = new Float64Array(size);
    seen = new Int32Array(size);
  }
  const sorted = keys.subarray(0, size);
  for (let i = 0; i < size; i++) {
    const k = -logw[i];
    if (k !== k) return Array.from({ length: size }, (_, j) => j).sort((a, b) => logw[b] - logw[a]);
    sorted[i] = k;
  }
  sorted.sort();
  seen.fill(0, 0, size);
  const order = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    // The first place of this weight (−0 and +0 compare equal here, as in the comparator).
    const k = -logw[i];
    let lo = 0;
    let hi = size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < k) lo = mid + 1;
      else hi = mid;
    }
    order[lo + seen[lo]++] = i;
  }
  return order;
}
