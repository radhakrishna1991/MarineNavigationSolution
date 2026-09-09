/**
 * Time integrity.
 *
 * Position is not the only thing GNSS provides, and not the only thing an
 * attacker can falsify. Satellite navigation solves for time and position
 * together, so a receiver being spoofed is very often reporting a false clock
 * as well - and on a vessel that clock timestamps the survey data, the voyage
 * data recorder and every log line written afterwards.
 *
 * The platform already detects a false or stale GNSS clock. What this adds is
 * the honest consequence: once GNSS is no longer trusted, UTC is in *holdover*,
 * running on the local oscillator, and the error grows with time. The display
 * says so rather than continuing to present a timestamp as though it were
 * disciplined.
 *
 * This is deliberately not a claim to hold time to any particular accuracy. It
 * states the source, whether that source is trusted, how long it has been since
 * a trusted reference, and the resulting bound.
 */

import { getConfig } from '../config/index.js';

/** Where the published UTC timestamp is coming from. */
export const TimeSource = Object.freeze({
  GNSS: 'GNSS',
  HOLDOVER: 'HOLDOVER',
  UNKNOWN: 'UNKNOWN'
});

export class TimeIntegrityMonitor {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastTrustedTime = null;
    this.lastOffsetS = null;
    this.holdoverStartedAt = null;
  }

  /**
   * @param {object} params
   * @param {number} params.time                Simulation time, seconds.
   * @param {object|null} params.gnssResult     The GNSS trust assessment.
   * @param {boolean} params.gnssUsed           Is GNSS contributing to the solution?
   */
  evaluate({ time, gnssResult, gnssUsed }) {
    const cfg = getConfig().time_integrity ?? {};
    const holdoverDriftSPerS = cfg.holdover_drift_s_per_s ?? 1e-7; // ~0.1 ppm oscillator
    const limitS = cfg.required_utc_accuracy_s ?? 1;

    const conditions = gnssResult?.detected_conditions ?? [];
    const clockSuspect =
      conditions.includes('GNSS_TIME_JUMP') || conditions.includes('STALE_GNSS_TIMESTAMP');

    // Trusted time needs a GNSS fix that is *being used* and whose clock is not
    // itself under suspicion. A receiver excluded for position spoofing cannot
    // be trusted for time either: the same transmitter controls both.
    const trustedNow = Boolean(gnssUsed) && !clockSuspect;

    if (trustedNow) {
      this.lastTrustedTime = time;
      this.lastOffsetS = gnssResult?.diagnostics?.time_offset_s ?? null;
      this.holdoverStartedAt = null;
    } else if (this.holdoverStartedAt === null) {
      this.holdoverStartedAt = time;
    }

    const holdoverS =
      this.holdoverStartedAt === null ? 0 : Math.max(0, time - this.holdoverStartedAt);

    let source;
    if (trustedNow) source = TimeSource.GNSS;
    else if (this.lastTrustedTime !== null) source = TimeSource.HOLDOVER;
    else source = TimeSource.UNKNOWN;

    // Bound on the UTC error. In holdover it grows with the oscillator's drift
    // rate; before any trusted reference has been seen it is unknown, which is
    // not the same as zero.
    let boundS = null;
    if (source === TimeSource.GNSS) {
      boundS = Math.abs(this.lastOffsetS ?? 0) + (cfg.gnss_utc_bound_s ?? 0.001);
    } else if (source === TimeSource.HOLDOVER) {
      boundS = Math.abs(this.lastOffsetS ?? 0) + holdoverS * holdoverDriftSPerS + (cfg.gnss_utc_bound_s ?? 0.001);
    }

    const reasons = [];
    if (clockSuspect) reasons.push('The GNSS clock is under suspicion.');
    else if (!gnssUsed) reasons.push('GNSS is not contributing, so UTC is running on the local oscillator.');
    if (source === TimeSource.UNKNOWN) reasons.push('No trusted time reference has been seen yet.');

    return {
      utc_source: source,
      // "Trusted" means the bound is known *and* inside the required accuracy.
      // A bound that cannot be computed is not a small bound.
      utc_trusted: source !== TimeSource.UNKNOWN && boundS !== null && boundS <= limitS,
      utc_error_bound_s: boundS === null ? null : Number(boundS.toFixed(6)),
      required_accuracy_s: limitS,
      holdover_duration_s: Number(holdoverS.toFixed(1)),
      last_trusted_reference_age_s:
        this.lastTrustedTime === null ? null : Number((time - this.lastTrustedTime).toFixed(1)),
      measured_gnss_offset_s: this.lastOffsetS,
      reasons
    };
  }
}

export default TimeIntegrityMonitor;
