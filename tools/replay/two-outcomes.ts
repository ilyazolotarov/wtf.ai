// Drives whose seeds land on one of two outcomes far apart, judged by how many seeds went bad (regress.ts).

/**
 * A drive whose seeds land on one of two outcomes far apart (fwx8ms: ~40 s or ~200 s off the drawn road): the bad one
 * at least twice the good one plus twice the floor, at least two seeds on each side of both runs together, and both
 * already in the run before. Its median flips with one seed; it is judged by how many seeds went bad instead. A bad
 * outcome new in this run is no coin flip: the usual rule judges it. Returns the line between the two, else null.
 */
export function twoOutcomes(before: number[], now: number[], floor: number): number | null {
  const v = [...before, ...now].sort((a, b) => a - b);
  let gap = -1;
  let at = -1;
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > gap) {
      gap = v[i] - v[i - 1];
      at = i;
    }
  }
  if (at < 2 || v.length - at < 2 || v[at] < 2 * v[at - 1] + 2 * floor) return null;
  const line = (v[at - 1] + v[at]) / 2;
  return before.some((x) => x > line) && before.some((x) => x <= line) ? line : null;
}

const choose = (n: number, k: number) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * One-sided Fisher exact test: the chance that `badNow` or more of `nNow` seeds go bad when the change did nothing
 * (the bad seeds of both runs dealt out at random between them).
 */
export function moreBadByChance(badBefore: number, nBefore: number, badNow: number, nNow: number): number {
  const bad = badBefore + badNow;
  let p = 0;
  for (let k = badNow; k <= Math.min(bad, nNow); k++) p += (choose(nNow, k) * choose(nBefore, bad - k)) / choose(nBefore + nNow, bad);
  return p;
}
