// Tiny dense matrix helpers for the EKF (n ≤ 8). Row-major number[][].

export type Mat = number[][];

export function zeros(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): Mat {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function mul(a: Mat, b: Mat): Mat {
  const out = zeros(a.length, b[0].length);
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < b.length; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < b[0].length; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

export function transpose(a: Mat): Mat {
  return a[0].map((_, j) => a.map((row) => row[j]));
}

/** Inverse of a small symmetric positive-definite matrix (Gauss-Jordan). */
export function inverse(a: Mat): Mat {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...identity(n)[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const pivot = m[c][c];
    if (pivot === 0) throw new Error("singular matrix");
    for (let j = 0; j < 2 * n; j++) m[c][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}

export function symmetrize(p: Mat): void {
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const v = (p[i][j] + p[j][i]) / 2;
      p[i][j] = p[j][i] = v;
    }
  }
}

/** Largest eigenvalue of a symmetric 2×2 matrix. */
export function maxEigen2(a: number, b: number, d: number): number {
  const tr = a + d;
  const det = a * d - b * b;
  return tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
}
