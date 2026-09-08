/**
 * Sensor-fusion engine (Section 11).
 *
 * Wraps the EKF with the parts that are about *navigation* rather than about
 * linear algebra:
 *
 *   - asynchronous, out-of-order-tolerant measurement application
 *   - per-sensor measurement covariance, including runtime de-weighting
 *   - measurement gating and innovation reporting
 *   - source attribution: exactly which sensors moved this solution
 *   - solution confidence
 *
 * The engine never decides *whether* a sensor should be trusted - that is the
 * job of the GNSS trust engine and the fault detector. It is told, and it
 * records what it was told, so the audit trail can answer "why was this
 * measurement used?" for every epoch.
 */

import { ExtendedKalmanFilter } from './ekf.js';
import { getConfig, getSensorDefinition } from '../../config/index.js';
import { SensorType, SensorDecision } from '../../models/enums.js';
import { neToCourseSpeed } from '../../utils/geo.js';

/** Measurement kinds recorded against a sensor. */
export const MeasurementKind = Object.freeze({
  POSITION: 'POSITION',
  VELOCITY: 'VELOCITY',
  HEADING: 'HEADING',
  DEPTH: 'DEPTH'
});

export class FusionEngine {
  constructor({ environment }) {
    this.env = environment;
    const cfg = getConfig().fusion;
    this.filter = new ExtendedKalmanFilter({
      processNoise: cfg.process_noise,
      initialUncertainty: cfg.initial_uncertainty
    });
    this.reset();
  }

  reset() {
    const cfg = getConfig().fusion;
    this.filter = new ExtendedKalmanFilter({
      processNoise: cfg.process_noise,
      initialUncertainty: cfg.initial_uncertainty
    });
    this.time = 0;
    this.lastPredictTime = null;
    /** Sensors that contributed an accepted update this epoch. */
    this.epochContributors = new Map();
    /** Sensors offered but rejected this epoch, with the reason. */
    this.epochRejections = new Map();
    this.updateCount = 0;
    this.lastAbsoluteUpdate = null;
    this.velocityNoiseScale = 1;
    this.residualLog = [];
    /** Consecutive position-gate failures per sensor, for divergence recovery. */
    this.positionGateFailures = new Map();
    /** Filter resets performed, published so a reset is never silent. */
    this.resets = [];
  }

  get initialized() {
    return this.filter.initialized;
  }

  /** Seed the filter from the first usable absolute fix. */
  initialize({ east, north, headingDeg = 0, velocityNorth = 0, velocityEast = 0, time }) {
    this.filter.initialize({
      east,
      north,
      velocityEast,
      velocityNorth,
      headingRad: (headingDeg * Math.PI) / 180,
      time
    });
    this.time = time;
    this.lastPredictTime = time;
  }

  /**
   * Begin a new fusion epoch.
   * @param {number} time
   * @param {object} [options]
   * @param {number|null} [options.headingRateDps] latest measured rate of turn
   */
  beginEpoch(time, { headingRateDps = null, headingRateSigmaDps = 0.5 } = {}) {
    this.epochContributors = new Map();
    this.epochRejections = new Map();
    this.residualLog = [];
    this.predictTo(time, { headingRateDps, headingRateSigmaDps });
  }

  /** Propagate the filter forward to `time`. */
  predictTo(time, { headingRateDps = null, headingRateSigmaDps = 0.5 } = {}) {
    if (!this.filter.initialized) {
      this.time = time;
      return;
    }
    const dt = time - (this.lastPredictTime ?? time);
    if (dt > 0) {
      // Very long gaps are stepped in bounded increments so the linearisation
      // stays valid and the covariance growth is not underestimated.
      let remaining = dt;
      while (remaining > 0) {
        const step = Math.min(0.5, remaining);
        this.filter.predict(step, {
          velocityNoiseScale: this.velocityNoiseScale,
          headingRateDps,
          headingRateSigmaDps
        });
        remaining -= step;
      }
    }
    this.lastPredictTime = time;
    this.time = time;
  }

  /** Predicted pose used to seed the map-matching engines. */
  priorPose() {
    if (!this.filter.initialized) return null;
    const ellipse = this.filter.positionEllipse();
    return {
      east: this.filter.east,
      north: this.filter.north,
      headingRad: this.filter.x[4],
      sigmaM: ellipse.major
    };
  }

  /**
   * Measurement covariance for a sensor, combining:
   *   - the sensor's own reported covariance where available
   *   - the configured floor for that sensor type
   *   - a runtime de-weighting factor (GNSS trust, low match confidence)
   */
  positionCovarianceFor(sensorId, sensorType, reported, deweight = 1) {
    const cfg = getConfig().fusion.measurement_noise[sensorType] || {};
    const def = getSensorDefinition(sensorId);
    const floorSigma = def?.fusion?.position_sigma_m ?? cfg.position_sigma_m ?? 3.0;
    const floorVar = floorSigma * floorSigma;
    const scale = Math.max(1, deweight) ** 2;
    if (Array.isArray(reported) && reported.length === 2 && Array.isArray(reported[0])) {
      return [
        [Math.max(floorVar, reported[0][0]) * scale, reported[0][1] * scale],
        [reported[1][0] * scale, Math.max(floorVar, reported[1][1]) * scale]
      ];
    }
    return [
      [floorVar * scale, 0],
      [0, floorVar * scale]
    ];
  }

  /**
   * Apply an absolute position measurement.
   *
   * @returns {object} diagnostics including gate decision and decision reason
   */
  applyPosition({ sensorId, sensorType, east, north, covariance, deweight = 1, absolute = true, label = null }) {
    const cfg = getConfig().fusion;
    if (!this.filter.initialized) {
      this.initialize({ east, north, time: this.time });
      this.recordContribution(sensorId, sensorType, MeasurementKind.POSITION, {
        applied: true,
        reason: 'FILTER_INITIALIZED',
        gatePassed: true,
        innovationNorm: 0,
        normalizedInnovation: 0
      });
      if (absolute) this.lastAbsoluteUpdate = { sensorId, sensorType, time: this.time };
      return { applied: true, reason: 'FILTER_INITIALIZED', gatePassed: true };
    }

    const R = this.positionCovarianceFor(sensorId, sensorType, covariance, deweight);
    let diagnostics = this.filter.updatePosition(east, north, R, cfg.gating.position_alpha, true);

    // --- Divergence recovery -------------------------------------------------
    // A filter whose state has run away rejects every honest measurement,
    // because they all look like outliers from where it thinks it is. Left
    // alone it never recovers. When a *trusted absolute* source is gated out
    // repeatedly, the filter is reset onto that measurement. The reset is
    // recorded and published - it is never silent, because a reset means the
    // preceding solution was wrong.
    if (!diagnostics.applied && diagnostics.gatePassed === false && absolute) {
      const key = sensorId;
      const failures = (this.positionGateFailures.get(key) ?? 0) + 1;
      this.positionGateFailures.set(key, failures);
      if (failures >= (cfg.divergence_reset_gate_failures ?? 6)) {
        const reset = {
          time_s: this.time,
          sensor_id: sensorId,
          sensor_type: sensorType,
          previous_east_m: Number(this.filter.east.toFixed(2)),
          previous_north_m: Number(this.filter.north.toFixed(2)),
          new_east_m: Number(east.toFixed(2)),
          new_north_m: Number(north.toFixed(2)),
          displacement_m: Number(Math.hypot(east - this.filter.east, north - this.filter.north).toFixed(2)),
          reason: `Filter position was gated out by ${sensorId} for ${failures} consecutive updates; the solution was reset onto that source.`
        };
        this.filter.initialize({
          east,
          north,
          velocityEast: this.filter.velocityEast,
          velocityNorth: this.filter.velocityNorth,
          headingRad: this.filter.x[4],
          time: this.time
        });
        this.resets.push(reset);
        this.positionGateFailures.set(key, 0);
        diagnostics = this.filter.updatePosition(east, north, R, cfg.gating.position_alpha, true);
        diagnostics.filter_reset = reset;
      }
    } else if (diagnostics.applied) {
      this.positionGateFailures.set(sensorId, 0);
    }

    diagnostics.sensor_id = sensorId;
    diagnostics.sensor_type = sensorType;
    diagnostics.kind = MeasurementKind.POSITION;
    diagnostics.deweight = deweight;
    diagnostics.label = label;
    diagnostics.measurement_sigma_m = Math.sqrt(Math.max(R[0][0], R[1][1]));

    this.recordContribution(sensorId, sensorType, MeasurementKind.POSITION, diagnostics);
    if (diagnostics.applied) {
      this.updateCount += 1;
      if (absolute) this.lastAbsoluteUpdate = { sensorId, sensorType, time: this.time };
    }
    return diagnostics;
  }

  /** Drain filter-reset records for publication. */
  drainResets() {
    const out = this.resets;
    this.resets = [];
    return out;
  }

  /**
   * Combine a sensor's self-reported uncertainty with the configured floor.
   *
   * A sensor's reported sigma is almost always its *precision* - short-term
   * white noise - and says nothing about slowly wandering bias, mounting
   * misalignment or unmodelled dynamics. Taking it at face value makes the
   * filter over-confident, and the residual monitor then rejects the very
   * sensor that was telling the truth. The configured value is the floor.
   */
  static effectiveSigma(reported, floor, fallback) {
    const base = Number.isFinite(floor) ? floor : fallback;
    if (!Number.isFinite(reported)) return base;
    return Math.max(base, reported);
  }

  /** Apply a body-frame velocity measurement (DVL or speed log). */
  applyBodyVelocity({ sensorId, sensorType, forwardMps, starboardMps = 0, sigmaMps = null, deweight = 1 }) {
    if (!this.filter.initialized) return { applied: false, reason: 'FILTER_NOT_INITIALIZED' };
    const cfg = getConfig().fusion;
    const def = getSensorDefinition(sensorId);
    const sigma =
      FusionEngine.effectiveSigma(
        sigmaMps,
        def?.fusion?.velocity_sigma_mps ?? cfg.measurement_noise[sensorType]?.velocity_sigma_mps,
        0.1
      ) * Math.max(1, deweight);
    const R = [
      [sigma * sigma, 0],
      [0, sigma * sigma * 4]
    ]; // athwartships velocity is inherently noisier
    const diagnostics = this.filter.updateBodyVelocity(
      forwardMps,
      starboardMps,
      R,
      cfg.gating.velocity_alpha,
      true
    );
    diagnostics.sensor_id = sensorId;
    diagnostics.sensor_type = sensorType;
    diagnostics.kind = MeasurementKind.VELOCITY;
    diagnostics.measurement_sigma_m = sigma;
    this.recordContribution(sensorId, sensorType, MeasurementKind.VELOCITY, diagnostics);
    if (diagnostics.applied) this.updateCount += 1;
    return diagnostics;
  }

  /** Apply a north/east velocity measurement (INS or GNSS Doppler). */
  applyVelocityNE({ sensorId, sensorType, velocityNorth, velocityEast, sigmaMps = null, deweight = 1 }) {
    if (!this.filter.initialized) return { applied: false, reason: 'FILTER_NOT_INITIALIZED' };
    const cfg = getConfig().fusion;
    const def = getSensorDefinition(sensorId);
    const sigma =
      FusionEngine.effectiveSigma(
        sigmaMps,
        def?.fusion?.velocity_sigma_mps ?? cfg.measurement_noise[sensorType]?.velocity_sigma_mps,
        0.2
      ) * Math.max(1, deweight);
    const R = [
      [sigma * sigma, 0],
      [0, sigma * sigma]
    ];
    const diagnostics = this.filter.updateVelocityNE(
      velocityNorth,
      velocityEast,
      R,
      cfg.gating.velocity_alpha,
      true
    );
    diagnostics.sensor_id = sensorId;
    diagnostics.sensor_type = sensorType;
    diagnostics.kind = MeasurementKind.VELOCITY;
    diagnostics.measurement_sigma_m = sigma;
    this.recordContribution(sensorId, sensorType, MeasurementKind.VELOCITY, diagnostics);
    if (diagnostics.applied) this.updateCount += 1;
    return diagnostics;
  }

  /**
   * Apply a heading measurement.
   *
   * @param {boolean} [monitorOnly] evaluate the innovation and record it for
   *        the residual monitor, but do not correct the filter. Used for
   *        secondary heading sources: a vessel has one heading reference, and
   *        letting three sources each claim to be the unbiased truth makes them
   *        fight, drives the residuals up, and gets healthy sensors excluded.
   */
  applyHeading({ sensorId, sensorType, headingDeg, sigmaDeg = null, withBias = true, deweight = 1, monitorOnly = false }) {
    if (!this.filter.initialized) return { applied: false, reason: 'FILTER_NOT_INITIALIZED' };
    const cfg = getConfig().fusion;
    const def = getSensorDefinition(sensorId);
    const sigma =
      FusionEngine.effectiveSigma(
        sigmaDeg,
        def?.fusion?.heading_sigma_deg ?? cfg.measurement_noise[sensorType]?.heading_sigma_deg,
        1.0
      ) * Math.max(1, deweight);
    const varianceRad2 = ((sigma * Math.PI) / 180) ** 2;
    const diagnostics = this.filter.updateHeading(
      (headingDeg * Math.PI) / 180,
      varianceRad2,
      cfg.gating.heading_alpha,
      withBias,
      !monitorOnly
    );
    diagnostics.monitor_only = monitorOnly;
    diagnostics.sensor_id = sensorId;
    diagnostics.sensor_type = sensorType;
    diagnostics.kind = MeasurementKind.HEADING;
    // Heading innovations are in radians; the declared sigma must match, or
    // the residual monitor compares degrees against radians.
    diagnostics.measurement_sigma_m = (sigma * Math.PI) / 180;
    diagnostics.measurement_sigma_deg = sigma;
    diagnostics.unit = 'rad';
    this.recordContribution(sensorId, sensorType, MeasurementKind.HEADING, diagnostics);
    if (diagnostics.applied) this.updateCount += 1;
    return diagnostics;
  }

  /** Record the outcome of an offered measurement for attribution and audit. */
  recordContribution(sensorId, sensorType, kind, diagnostics) {
    const entry = {
      sensor_id: sensorId,
      sensor_type: sensorType,
      kind,
      applied: Boolean(diagnostics.applied),
      gate_passed: diagnostics.gatePassed !== false,
      reason: diagnostics.reason ?? null,
      residual: Number.isFinite(diagnostics.innovationNorm) ? Number(diagnostics.innovationNorm.toFixed(5)) : null,
      normalized_residual: Number.isFinite(diagnostics.normalizedInnovation)
        ? Number(diagnostics.normalizedInnovation.toFixed(5))
        : null,
      nis: Number.isFinite(diagnostics.nis) ? Number(diagnostics.nis.toFixed(5)) : null,
      gate_threshold: diagnostics.gateThreshold ?? null,
      measurement_sigma: diagnostics.measurement_sigma_m ?? null,
      monitor_only: Boolean(diagnostics.monitor_only),
      decision: diagnostics.applied
        ? SensorDecision.ACCEPTED
        : diagnostics.monitor_only
          ? SensorDecision.ADVISORY_ONLY
          : diagnostics.gatePassed === false
            ? SensorDecision.REJECTED
            : SensorDecision.NOT_USED
    };
    this.residualLog.push(entry);
    // A monitored-only measurement is neither a contribution nor a rejection:
    // it was never offered to the filter as a correction.
    if (diagnostics.monitor_only) return;
    if (entry.applied) {
      this.epochContributors.set(`${sensorId}:${kind}`, entry);
    } else {
      this.epochRejections.set(`${sensorId}:${kind}`, entry);
    }
  }

  /** Inflate velocity process noise, e.g. after DVL bottom-lock loss. */
  setVelocityNoiseScale(scale) {
    this.velocityNoiseScale = Math.max(1, scale);
  }

  /** Distinct sensor ids that contributed an accepted update this epoch. */
  contributingSensors() {
    return [...new Set([...this.epochContributors.values()].map((e) => e.sensor_id))].sort();
  }

  /** Distinct sensor ids offered but not used this epoch. */
  rejectedSensors() {
    const accepted = new Set(this.contributingSensors());
    return [...new Set([...this.epochRejections.values()].map((e) => e.sensor_id))]
      .filter((id) => !accepted.has(id))
      .sort();
  }

  /**
   * Solution confidence: a 0..1 summary combining precision against the
   * requirement limit, the number of contributing measurement kinds, and how
   * recently an absolute update was applied. Explicitly NOT a probability.
   */
  solutionConfidence(absoluteFixAgeS) {
    if (!this.filter.initialized) return 0;
    const limit = getConfig().requirements.horizontal_error_limit_m;
    const ellipse = this.filter.positionEllipse();
    const precisionTerm = Math.max(0, Math.min(1, 1 - (2.448 * ellipse.major) / (limit * 2)));
    const kinds = new Set([...this.epochContributors.values()].map((e) => e.kind));
    const diversityTerm = Math.min(1, kinds.size / 3);
    const freshnessTerm =
      absoluteFixAgeS === null ? 0.2 : Math.max(0, Math.min(1, 1 - absoluteFixAgeS / 60));
    return Number((0.5 * precisionTerm + 0.2 * diversityTerm + 0.3 * freshnessTerm).toFixed(4));
  }

  /** Current fused solution in both local and geodetic frames. */
  solution() {
    if (!this.filter.initialized) {
      return { available: false, reason: 'FILTER_NOT_INITIALIZED' };
    }
    const geo = this.env.frame.toGeodetic(this.filter.east, this.filter.north);
    const ellipse = this.filter.positionEllipse();
    const { courseDeg, speedMps } = neToCourseSpeed(this.filter.velocityNorth, this.filter.velocityEast);
    return {
      available: true,
      time_s: this.time,
      east_m: this.filter.east,
      north_m: this.filter.north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      velocity_north_mps: this.filter.velocityNorth,
      velocity_east_mps: this.filter.velocityEast,
      speed_mps: speedMps,
      course_deg: courseDeg,
      heading_deg: this.filter.headingDeg,
      gyro_bias_deg: this.filter.gyroBiasDeg,
      speed_scale_factor: this.filter.speedScale,
      position_covariance: this.filter.positionCovariance(),
      ellipse,
      update_count: this.updateCount,
      last_absolute_update: this.lastAbsoluteUpdate
    };
  }

  /** Full filter dump for the engineering panel. */
  debug() {
    return {
      ...this.filter.debugState(),
      velocity_noise_scale: this.velocityNoiseScale,
      contributors: [...this.epochContributors.values()],
      rejections: [...this.epochRejections.values()]
    };
  }
}

export default FusionEngine;
