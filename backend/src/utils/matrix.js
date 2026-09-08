/**
 * Minimal dense linear algebra for the Kalman filters.
 *
 * Matrices are plain arrays of row arrays (`number[][]`), vectors are
 * `number[]`. Everything is written for clarity over raw speed; the state
 * dimension here is 7, so the O(n^3) operations are negligible.
 */

/** @returns {number[][]} n x m matrix of zeros */
export function zeros(n, m = n) {
  return Array.from({ length: n }, () => new Array(m).fill(0));
}

/** @returns {number[][]} n x n identity matrix */
export function identity(n) {
  const out = zeros(n);
  for (let i = 0; i < n; i += 1) out[i][i] = 1;
  return out;
}

/** Deep copy of a matrix. */
export function clone(a) {
  return a.map((row) => row.slice());
}

/** Matrix product A (n x m) * B (m x p). */
export function matMul(a, b) {
  const n = a.length;
  const m = b.length;
  const p = b[0].length;
  const out = zeros(n, p);
  for (let i = 0; i < n; i += 1) {
    const ai = a[i];
    const oi = out[i];
    for (let k = 0; k < m; k += 1) {
      const aik = ai[k];
      if (aik === 0) continue;
      const bk = b[k];
      for (let j = 0; j < p; j += 1) oi[j] += aik * bk[j];
    }
  }
  return out;
}

/** Matrix * vector. */
export function matVec(a, v) {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * v[j], 0));
}

/** Transpose. */
export function transpose(a) {
  const n = a.length;
  const m = a[0].length;
  const out = zeros(m, n);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) out[j][i] = a[i][j];
  return out;
}

/** Element-wise A + B. */
export function matAdd(a, b) {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]));
}

/** Element-wise A - B. */
export function matSub(a, b) {
  return a.map((row, i) => row.map((value, j) => value - b[i][j]));
}

/** Scalar multiple. */
export function matScale(a, s) {
  return a.map((row) => row.map((value) => value * s));
}

export function vecAdd(a, b) {
  return a.map((value, i) => value + b[i]);
}

export function vecSub(a, b) {
  return a.map((value, i) => value - b[i]);
}

export function vecScale(a, s) {
  return a.map((value) => value * s);
}

export function dot(a, b) {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

/**
 * Gauss-Jordan inverse with partial pivoting.
 * Throws when the matrix is numerically singular, which the fusion engine
 * treats as "measurement cannot be applied" rather than silently continuing.
 */
export function inverse(a) {
  const n = a.length;
  const m = clone(a);
  const inv = identity(n);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-14) {
      throw new Error(`Matrix is singular at column ${col}`);
    }
    if (pivot !== col) {
      [m[pivot], m[col]] = [m[col], m[pivot]];
      [inv[pivot], inv[col]] = [inv[col], inv[pivot]];
    }
    const pv = m[col][col];
    for (let j = 0; j < n; j += 1) {
      m[col][j] /= pv;
      inv[col][j] /= pv;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      if (factor === 0) continue;
      for (let j = 0; j < n; j += 1) {
        m[row][j] -= factor * m[col][j];
        inv[row][j] -= factor * inv[col][j];
      }
    }
  }
  return inv;
}

/** Force a covariance matrix to stay symmetric (numerical hygiene). */
export function symmetrize(p) {
  const n = p.length;
  const out = zeros(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) out[i][j] = 0.5 * (p[i][j] + p[j][i]);
  }
  return out;
}

/**
 * Eigen decomposition of a symmetric 2x2 matrix.
 * Used for the horizontal confidence ellipse and protection level.
 * @returns {{ major: number, minor: number, orientationDeg: number }}
 *          semi-axis standard deviations (sqrt of eigenvalues) and the
 *          orientation of the major axis measured clockwise from North.
 */
export function eigen2x2(m) {
  const a = m[0][0];
  const b = m[0][1];
  const d = m[1][1];
  const trace = a + d;
  const det = a * d - b * b;
  const disc = Math.max(0, (trace * trace) / 4 - det);
  const root = Math.sqrt(disc);
  const l1 = trace / 2 + root;
  const l2 = Math.max(0, trace / 2 - root);
  // Eigenvector for l1 in the (east, north) plane.
  let angleRad;
  if (Math.abs(b) < 1e-15) {
    angleRad = a >= d ? 0 : Math.PI / 2;
  } else {
    angleRad = Math.atan2(l1 - a, b);
  }
  // Convert from "east-axis CCW" to "north-axis clockwise" (maritime bearing).
  const bearing = ((90 - (angleRad * 180) / Math.PI) % 360 + 360) % 360;
  return {
    major: Math.sqrt(Math.max(0, l1)),
    minor: Math.sqrt(Math.max(0, l2)),
    orientationDeg: bearing
  };
}

/** Cholesky decomposition (lower triangular). Returns null if not PD. */
export function cholesky(a) {
  const n = a.length;
  const l = zeros(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = a[i][j];
      for (let k = 0; k < j; k += 1) sum -= l[i][k] * l[j][k];
      if (i === j) {
        if (sum <= 0) return null;
        l[i][j] = Math.sqrt(sum);
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }
  return l;
}
