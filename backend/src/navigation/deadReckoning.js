/**
 * Dead-reckoning engine (Section 10.4).
 *
 * Runs *independently* of the fusion filter so that the platform always has an
 * answer to "where would we be if we trusted nothing but the last good fix,
 * the gyro and the log?". That independent answer is one of the cross-checks
 * the GNSS trust engine uses, so it must not be contaminated by GNSS.
 *
 * The uncertainty model is deliberately explicit rather than emergent:
 *
 *   sigma(t) = sqrt( (sigma_0)^2 + (q_v * sqrt(t))^2 + (bias_terms * t)^2 )
 *
 * where the sqrt(t) term comes from white velocity noise and the linear term
 * from residual heading bias and log scale error. The linear term dominates
 * after a couple of minutes, which is exactly why unbounded dead reckoning can
 * never satisfy a 2 m requirement for long.
 */

import { getConfig } from '../config/index.js';
import { normalizeHeading } from '../utils/geo.js';

export class DeadReckoningEngine {
  constructor({ environment }) {
    this.env = environment;
    this.reset();
  }

  reset() {
    this.east = null;
    this.north = null;
    this.headingDeg = null;
    this.speedMps = 0;
    this.lastUpdateTime = null;
    this.anchorTime = null;
    this.anchorSigma = 0;
    this.sigmaM = 0;
    this.bottomLock = true;
    this.velocitySource = null;
    this.durationS = 0;
    this.history = [];
  }

  /** True once an anchor fix has been supplied. */
  get initialized() {
    return this.east !== null;
  }

  /**
   * Anchor the dead-reckoning solution on a trusted absolute fix.
   * @param {number} east local metres
   * @param {number} north local metres
   * @param {number} sigmaM 1-sigma horizontal uncertainty of the anchor
   * @param {number} time simulation time
   */
  anchor(east, north, sigmaM, time, headingDeg = null) {
    this.east = east;
    this.north = north;
    this.anchorSigma = sigmaM;
    this.sigmaM = sigmaM;
    this.anchorTime = time;
    this.lastUpdateTime = time;
    this.durationS = 0;
    if (headingDeg !== null) this.headingDeg = headingDeg;
  }

  /**
   * Propagate to `time` using the latest heading and velocity observations.
   *
   * @param {object} inputs
   * @param {number} inputs.time simulation time
   * @param {number|null} inputs.headingDeg gyro heading (bias corrected if available)
   * @param {number|null} inputs.forwardMps body-frame forward speed
   * @param {number|null} inputs.starboardMps body-frame starboard speed
   * @param {boolean} inputs.bottomLock DVL bottom-lock status
   * @param {string} inputs.velocitySource which sensor supplied the velocity
   */
  propagate({ time, headingDeg, forwardMps, starboardMps = 0, bottomLock = true, velocitySource = null }) {
    if (!this.initialized) return null;
    const cfg = getConfig().dead_reckoning;
    const dt = Math.max(0, time - this.lastUpdateTime);
    if (dt === 0) return this.state();

    if (headingDeg !== null && headingDeg !== undefined) this.headingDeg = normalizeHeading(headingDeg);
    if (forwardMps !== null && forwardMps !== undefined) this.speedMps = forwardMps;
    this.bottomLock = bottomLock;
    this.velocitySource = velocitySource;

    if (this.headingDeg !== null) {
      const hr = (this.headingDeg * Math.PI) / 180;
      const vNorth = this.speedMps * Math.cos(hr) - starboardMps * Math.sin(hr);
      const vEast = this.speedMps * Math.sin(hr) + starboardMps * Math.cos(hr);
      this.east += vEast * dt;
      this.north += vNorth * dt;
    }

    this.lastUpdateTime = time;
    this.durationS = time - this.anchorTime;

    // Uncertainty growth. Without bottom lock the velocity noise term is
    // replaced by the much larger speed-log figure.
    const t = Math.max(0, this.durationS);
    const qv = bottomLock
      ? cfg.velocity_noise_mps_per_sqrt_s
      : Math.max(cfg.velocity_noise_mps_per_sqrt_s, cfg.bottom_lock_loss_velocity_sigma_mps);
    const randomWalk = qv * Math.sqrt(t);
    const headingTerm = ((cfg.heading_bias_deg * Math.PI) / 180) * Math.abs(this.speedMps) * t;
    const scaleTerm = cfg.speed_scale_error * Math.abs(this.speedMps) * t;
    const systematic = Math.hypot(headingTerm, scaleTerm);
    this.sigmaM = Math.sqrt(this.anchorSigma ** 2 + randomWalk ** 2 + systematic ** 2);

    return this.state();
  }

  /** Current dead-reckoned state, or null before the first anchor. */
  state() {
    if (!this.initialized) return null;
    const geo = this.env.frame.toGeodetic(this.east, this.north);
    return {
      east_m: this.east,
      north_m: this.north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      heading_deg: this.headingDeg,
      speed_mps: this.speedMps,
      sigma_m: this.sigmaM,
      duration_s: this.durationS,
      anchor_time_s: this.anchorTime,
      bottom_lock: this.bottomLock,
      velocity_source: this.velocitySource,
      // Explicit statement of what limits the accuracy right now.
      dominant_error_source: this.dominantErrorSource()
    };
  }

  /** Which term dominates the current uncertainty - shown in the UI. */
  dominantErrorSource() {
    const cfg = getConfig().dead_reckoning;
    const t = Math.max(0, this.durationS);
    const qv = this.bottomLock ? cfg.velocity_noise_mps_per_sqrt_s : cfg.bottom_lock_loss_velocity_sigma_mps;
    const randomWalk = qv * Math.sqrt(t);
    const headingTerm = ((cfg.heading_bias_deg * Math.PI) / 180) * Math.abs(this.speedMps) * t;
    const scaleTerm = cfg.speed_scale_error * Math.abs(this.speedMps) * t;
    const terms = [
      { source: 'ANCHOR_UNCERTAINTY', value: this.anchorSigma },
      { source: 'VELOCITY_RANDOM_WALK', value: randomWalk },
      { source: 'HEADING_BIAS', value: headingTerm },
      { source: 'SPEED_SCALE_ERROR', value: scaleTerm }
    ];
    terms.sort((a, b) => b.value - a.value);
    return terms[0].source;
  }

  /** Seconds remaining before the configured unassisted limit is reached. */
  remainingUnassistedS() {
    const cfg = getConfig().dead_reckoning;
    return Math.max(0, cfg.maximum_unassisted_duration_s - this.durationS);
  }
}

export default DeadReckoningEngine;
