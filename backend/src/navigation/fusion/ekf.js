/**
 * Extended Kalman Filter for the trusted navigation solution (Section 11).
 *
 * State vector (local East-North-Up frame anchored at the harbour origin):
 *
 *   0  east            m          local X
 *   1  north           m          local Y
 *   2  velocity east   m/s
 *   3  velocity north  m/s
 *   4  heading         rad        true heading of the vessel
 *   5  gyro bias       rad        additive gyrocompass error
 *   6  speed scale     -          multiplicative log/DVL scale error, ~1
 *
 * The filter is deliberately transparent: every update returns its innovation,
 * innovation covariance, normalized innovation squared and gating decision so
 * the fault detector, the integrity engine and the UI can all see exactly why a
 * measurement was used or rejected. Nothing is hidden inside the filter.
 */

import {
  identity,
  zeros,
  clone,
  matMul,
  matVec,
  transpose,
  matAdd,
  matSub,
  inverse,
  symmetrize,
  eigen2x2
} from '../../utils/matrix.js';
import { chi2Critical } from '../../utils/stats.js';

export const STATE_DIM = 7;
export const S_EAST = 0;
export const S_NORTH = 1;
export const S_VEAST = 2;
export const S_VNORTH = 3;
export const S_HEADING = 4;
export const S_GYRO_BIAS = 5;
export const S_SPEED_SCALE = 6;

export const STATE_LABELS = [
  'east_m',
  'north_m',
  'velocity_east_mps',
  'velocity_north_mps',
  'heading_rad',
  'gyro_bias_rad',
  'speed_scale'
];

/** Wrap an angle to (-pi, pi]. */
function wrapPi(a) {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

export class ExtendedKalmanFilter {
  /**
   * @param {object} options
   * @param {object} options.processNoise PSDs from configuration
   * @param {object} options.initialUncertainty
   */
  constructor({ processNoise, initialUncertainty }) {
    this.processNoise = processNoise;
    this.initialUncertainty = initialUncertainty;
    this.initialized = false;
    this.x = new Array(STATE_DIM).fill(0);
    this.P = identity(STATE_DIM);
    this.lastTime = null;
  }

  /**
   * Seed the filter from a first absolute fix.
   */
  initialize({ east, north, velocityEast = 0, velocityNorth = 0, headingRad = 0, time }) {
    const u = this.initialUncertainty;
    this.x = [east, north, velocityEast, velocityNorth, wrapPi(headingRad), 0, 1];
    this.P = zeros(STATE_DIM);
    this.P[S_EAST][S_EAST] = u.position_m ** 2;
    this.P[S_NORTH][S_NORTH] = u.position_m ** 2;
    this.P[S_VEAST][S_VEAST] = u.velocity_mps ** 2;
    this.P[S_VNORTH][S_VNORTH] = u.velocity_mps ** 2;
    this.P[S_HEADING][S_HEADING] = ((u.heading_deg * Math.PI) / 180) ** 2;
    this.P[S_GYRO_BIAS][S_GYRO_BIAS] = ((u.gyro_bias_deg * Math.PI) / 180) ** 2;
    this.P[S_SPEED_SCALE][S_SPEED_SCALE] = u.speed_scale ** 2;
    this.lastTime = time;
    this.initialized = true;
  }

  /** Deep snapshot for replay/rollback. */
  snapshot() {
    return { x: this.x.slice(), P: clone(this.P), lastTime: this.lastTime, initialized: this.initialized };
  }

  restore(snap) {
    this.x = snap.x.slice();
    this.P = clone(snap.P);
    this.lastTime = snap.lastTime;
    this.initialized = snap.initialized;
  }

  /**
   * Time update. A nearly-constant-velocity model: position integrates
   * velocity, everything else is a random walk whose growth is set by the
   * configured power spectral densities.
   *
   * @param {number} dt seconds
   * @param {object} [options]
   * @param {number} [options.velocityNoiseScale] inflate velocity process noise,
   *        used when the DVL has lost bottom lock and only the log remains.
   * @param {number|null} [options.headingRateDps] measured rate of turn. The
   *        gyrocompass is a rate sensor as well as a heading sensor, and using
   *        its rate to propagate heading is what lets the filter follow a real
   *        manoeuvre. Without it, heading is a slow random walk, an 8 deg/s
   *        turn produces enormous innovations, the gyro is gated out as an
   *        outlier, and the solution collapses at the first alteration of
   *        course - which is exactly what a bridge system must not do.
   * @param {number} [options.headingRateSigmaDps] uncertainty of that rate.
   */
  predict(dt, { velocityNoiseScale = 1, headingRateDps = null, headingRateSigmaDps = 0.5 } = {}) {
    if (!this.initialized || dt <= 0) return;
    const F = identity(STATE_DIM);
    F[S_EAST][S_VEAST] = dt;
    F[S_NORTH][S_VNORTH] = dt;

    this.x[S_EAST] += this.x[S_VEAST] * dt;
    this.x[S_NORTH] += this.x[S_VNORTH] * dt;
    if (Number.isFinite(headingRateDps)) {
      this.x[S_HEADING] += (headingRateDps * Math.PI * dt) / 180;
    }
    this.x[S_HEADING] = wrapPi(this.x[S_HEADING]);

    const q = this.processNoise;
    const Q = zeros(STATE_DIM);
    const qv = q.velocity_m2_per_s3 * velocityNoiseScale;
    // Standard continuous white-noise-acceleration discretisation.
    Q[S_EAST][S_EAST] = q.position_m2_per_s * dt + (qv * dt ** 3) / 3;
    Q[S_NORTH][S_NORTH] = Q[S_EAST][S_EAST];
    Q[S_VEAST][S_VEAST] = qv * dt;
    Q[S_VNORTH][S_VNORTH] = qv * dt;
    Q[S_EAST][S_VEAST] = (qv * dt ** 2) / 2;
    Q[S_VEAST][S_EAST] = Q[S_EAST][S_VEAST];
    Q[S_NORTH][S_VNORTH] = Q[S_EAST][S_VEAST];
    Q[S_VNORTH][S_NORTH] = Q[S_EAST][S_VEAST];
    // Heading process noise: the random-walk term, plus the integrated
    // uncertainty of the rate used to propagate it.
    const headingPsd = ((q.heading_deg2_per_s * Math.PI ** 2) / 180 ** 2) * dt;
    const rateTerm = Number.isFinite(headingRateDps)
      ? (((headingRateSigmaDps * Math.PI) / 180) * dt) ** 2
      : 0;
    Q[S_HEADING][S_HEADING] = headingPsd + rateTerm;
    Q[S_GYRO_BIAS][S_GYRO_BIAS] = ((q.gyro_bias_deg2_per_s3 * Math.PI ** 2) / 180 ** 2) * dt;
    Q[S_SPEED_SCALE][S_SPEED_SCALE] = q.speed_scale_per_s * dt;

    this.P = symmetrize(matAdd(matMul(matMul(F, this.P), transpose(F)), Q));
  }

  /**
   * Generic measurement update.
   *
   * @param {object} spec
   * @param {number[]} spec.z            measurement vector
   * @param {number[]} spec.h            predicted measurement h(x)
   * @param {number[][]} spec.H          Jacobian dh/dx, (m x STATE_DIM)
   * @param {number[][]} spec.R          measurement covariance (m x m)
   * @param {number} [spec.gateAlpha]    chi-square significance for gating
   * @param {boolean} [spec.apply=true]  set false to evaluate without updating
   * @param {number[]} [spec.angularIndices] indices of z that are angles and
   *                                     need wrapped innovations
   * @returns {object} diagnostics including innovation and gate decision
   */
  update({ z, h, H, R, gateAlpha = 0.001, apply = true, angularIndices = [] }) {
    if (!this.initialized) {
      return { applied: false, reason: 'FILTER_NOT_INITIALIZED', gatePassed: false };
    }
    const m = z.length;
    const innovation = z.map((zi, i) => {
      const raw = zi - h[i];
      return angularIndices.includes(i) ? wrapPi(raw) : raw;
    });

    const Ht = transpose(H);
    const PHt = matMul(this.P, Ht);
    const S = matAdd(matMul(H, PHt), R);

    let Sinv;
    try {
      Sinv = inverse(S);
    } catch {
      return { applied: false, reason: 'SINGULAR_INNOVATION_COVARIANCE', gatePassed: false, innovation };
    }

    // Normalized innovation squared - the standard consistency statistic.
    const nis = innovation.reduce(
      (acc, vi, i) => acc + vi * innovation.reduce((a2, vj, j) => a2 + Sinv[i][j] * vj, 0),
      0
    );
    const threshold = chi2Critical(m, gateAlpha);
    const gatePassed = nis <= threshold;

    const diagnostics = {
      innovation,
      innovationNorm: Math.hypot(...innovation),
      innovationCovariance: S,
      innovationSigma: Math.sqrt(Math.max(1e-12, S[0][0])),
      normalizedInnovation: Math.sqrt(Math.max(0, nis)),
      nis,
      gateThreshold: threshold,
      gatePassed,
      applied: false,
      reason: gatePassed ? 'OK' : 'GATE_REJECTED'
    };

    if (!apply || !gatePassed) return diagnostics;

    const K = matMul(PHt, Sinv);
    const correction = matVec(K, innovation);
    this.x = this.x.map((xi, i) => xi + correction[i]);
    this.x[S_HEADING] = wrapPi(this.x[S_HEADING]);
    // Keep the scale factor physically sensible.
    this.x[S_SPEED_SCALE] = Math.min(2.0, Math.max(0.4, this.x[S_SPEED_SCALE]));

    // Joseph form: numerically stable and stays positive semi-definite even
    // with an imperfect gain, which matters when a covariance is inflated.
    const I = identity(STATE_DIM);
    const IKH = matSub(I, matMul(K, H));
    const term1 = matMul(matMul(IKH, this.P), transpose(IKH));
    const term2 = matMul(matMul(K, R), transpose(K));
    this.P = symmetrize(matAdd(term1, term2));

    diagnostics.applied = true;
    diagnostics.correction = correction;
    return diagnostics;
  }

  /** Position measurement update, z = [east, north]. */
  updatePosition(east, north, covariance, gateAlpha, apply = true) {
    const H = zeros(2, STATE_DIM);
    H[0][S_EAST] = 1;
    H[1][S_NORTH] = 1;
    return this.update({
      z: [east, north],
      h: [this.x[S_EAST], this.x[S_NORTH]],
      H,
      R: covariance,
      gateAlpha,
      apply
    });
  }

  /**
   * Body-frame velocity update (DVL or speed log), z = [forward, starboard].
   * The measurement is scaled by the estimated speed-scale factor, so a log
   * calibration error is observable and absorbed rather than corrupting speed.
   */
  updateBodyVelocity(forward, starboard, covariance, gateAlpha, apply = true) {
    const hdg = this.x[S_HEADING];
    const s = this.x[S_SPEED_SCALE];
    const c = Math.cos(hdg);
    const sn = Math.sin(hdg);
    const vE = this.x[S_VEAST];
    const vN = this.x[S_VNORTH];
    const fwd = vN * c + vE * sn;
    const stb = vE * c - vN * sn;

    const H = zeros(2, STATE_DIM);
    H[0][S_VEAST] = s * sn;
    H[0][S_VNORTH] = s * c;
    H[0][S_HEADING] = s * stb;
    H[0][S_SPEED_SCALE] = fwd;
    H[1][S_VEAST] = s * c;
    H[1][S_VNORTH] = -s * sn;
    H[1][S_HEADING] = -s * fwd;
    H[1][S_SPEED_SCALE] = stb;

    return this.update({
      z: [forward, starboard],
      h: [s * fwd, s * stb],
      H,
      R: covariance,
      gateAlpha,
      apply
    });
  }

  /** North/east velocity update (INS or GNSS Doppler). */
  updateVelocityNE(velocityNorth, velocityEast, covariance, gateAlpha, apply = true) {
    const H = zeros(2, STATE_DIM);
    H[0][S_VNORTH] = 1;
    H[1][S_VEAST] = 1;
    return this.update({
      z: [velocityNorth, velocityEast],
      h: [this.x[S_VNORTH], this.x[S_VEAST]],
      H,
      R: covariance,
      gateAlpha,
      apply
    });
  }

  /**
   * Heading update.
   * @param {boolean} withBias true for a gyrocompass (its bias is estimated),
   *        false for an absolute heading such as a radar match.
   */
  updateHeading(headingRad, varianceRad2, gateAlpha, withBias = true, apply = true) {
    const H = zeros(1, STATE_DIM);
    H[0][S_HEADING] = 1;
    if (withBias) H[0][S_GYRO_BIAS] = 1;
    const predicted = this.x[S_HEADING] + (withBias ? this.x[S_GYRO_BIAS] : 0);
    return this.update({
      z: [wrapPi(headingRad)],
      h: [wrapPi(predicted)],
      H,
      R: [[varianceRad2]],
      gateAlpha,
      apply,
      angularIndices: [0]
    });
  }

  // --- Accessors ------------------------------------------------------------

  get east() {
    return this.x[S_EAST];
  }

  get north() {
    return this.x[S_NORTH];
  }

  get velocityEast() {
    return this.x[S_VEAST];
  }

  get velocityNorth() {
    return this.x[S_VNORTH];
  }

  get headingDeg() {
    return ((this.x[S_HEADING] * 180) / Math.PI + 360) % 360;
  }

  get gyroBiasDeg() {
    return (this.x[S_GYRO_BIAS] * 180) / Math.PI;
  }

  get speedScale() {
    return this.x[S_SPEED_SCALE];
  }

  get speed() {
    return Math.hypot(this.x[S_VEAST], this.x[S_VNORTH]);
  }

  /** 2x2 horizontal position covariance in the ENU frame. */
  positionCovariance() {
    return [
      [this.P[S_EAST][S_EAST], this.P[S_EAST][S_NORTH]],
      [this.P[S_NORTH][S_EAST], this.P[S_NORTH][S_NORTH]]
    ];
  }

  /** Confidence ellipse semi-axes (1-sigma) and orientation. */
  positionEllipse() {
    return eigen2x2(this.positionCovariance());
  }

  /** Full diagnostic dump for the engineering panel. */
  debugState() {
    return {
      state: STATE_LABELS.reduce((acc, label, i) => ({ ...acc, [label]: this.x[i] }), {}),
      variances: STATE_LABELS.reduce((acc, label, i) => ({ ...acc, [label]: this.P[i][i] }), {}),
      covariance: clone(this.P)
    };
  }
}

export default ExtendedKalmanFilter;
