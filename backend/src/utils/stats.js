/**
 * Statistical helpers used by the integrity engine and performance analytics.
 *
 * Terminology note (Section 13): these functions produce *accuracy* statistics
 * from samples. They must never be relabelled as integrity or protection level.
 */

/** Arithmetic mean, NaN-safe. */
export function mean(values) {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Sample standard deviation. */
export function stdDev(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((acc, x) => acc + (x - m) ** 2, 0) / (v.length - 1));
}

/** Root mean square. */
export function rms(values) {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return null;
  return Math.sqrt(v.reduce((acc, x) => acc + x * x, 0) / v.length);
}

/** Median. */
export function median(values) {
  return percentile(values, 50);
}

/**
 * Linear-interpolated percentile.
 * @param {number[]} values
 * @param {number} p 0..100
 */
export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return v[lo];
  return v[lo] + (rank - lo) * (v[hi] - v[lo]);
}

/** Maximum, NaN-safe. */
export function max(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? Math.max(...v) : null;
}

/** Minimum, NaN-safe. */
export function min(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? Math.min(...v) : null;
}

/**
 * Chi-square upper-tail critical values, precomputed for the degrees of
 * freedom the fault detector actually uses. Avoids pulling in a stats library
 * for six numbers, and keeps the thresholds explicit and auditable.
 * Keys: `${dof}:${alpha}`.
 */
const CHI2_TABLE = {
  '1:0.05': 3.841,
  '1:0.01': 6.635,
  '1:0.001': 10.828,
  '2:0.05': 5.991,
  '2:0.01': 9.21,
  '2:0.001': 13.816,
  '3:0.05': 7.815,
  '3:0.01': 11.345,
  '3:0.001': 16.266,
  '4:0.05': 9.488,
  '4:0.01': 13.277,
  '4:0.001': 18.467
};

/**
 * Chi-square critical value for a given degrees of freedom and significance.
 * Falls back to the Wilson-Hilferty approximation outside the table.
 */
export function chi2Critical(dof, alpha = 0.01) {
  const key = `${dof}:${alpha}`;
  if (CHI2_TABLE[key]) return CHI2_TABLE[key];
  const z = normalQuantile(1 - alpha);
  const t = 1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof));
  return dof * t * t * t;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Accurate to about 1.15e-9 which is far beyond what the thresholds need.
 */
export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.696830286653757, 220.94609842452050, -275.92851044696869, 138.35775186726900, -30.664798066147160, 2.5066282774592392];
  const b = [-54.476098798224058, 161.58583685804089, -155.69897985988661, 66.801311887719720, -13.280681552885721];
  const c = [-0.0077848940024302926, -0.32239645804113648, -2.4007582771618381, -2.5497325393437338, 4.3746641414649678, 2.9381639826987831];
  const d = [0.0077846957090414622, 0.32246712907003983, 2.4451341117583475, 3.7544086619074162];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  let r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Scale factor k such that a circle of radius k*sigma contains `confidence`
 * of a 2-D circular normal distribution (Rayleigh quantile).
 *   0.95 -> 2.4477   0.99 -> 3.0349
 */
export function rayleighK(confidence) {
  return Math.sqrt(-2 * Math.log(1 - confidence));
}

/** Rolling window that keeps the last N samples and exposes summary stats. */
export class RollingWindow {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }

  push(value) {
    this.items.push(value);
    if (this.items.length > this.capacity) this.items.shift();
    return value;
  }

  get length() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }

  values() {
    return this.items.slice();
  }

  mean() {
    return mean(this.items);
  }

  stdDev() {
    return stdDev(this.items);
  }

  rms() {
    return rms(this.items);
  }

  last() {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  /** Least-squares slope per unit index; used for "uncertainty is growing". */
  slope() {
    const n = this.items.length;
    if (n < 3) return 0;
    const xm = (n - 1) / 2;
    const ym = mean(this.items);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (i - xm) * (this.items[i] - ym);
      den += (i - xm) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }
}

/** Clamp helper. */
export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Round to n decimals, returning null for non-finite input. */
export function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
