/**
 * GNSS trust and anomaly-detection engine (Sections 9, 4.2, 4.3, 4.8).
 *
 * The governing principle of the whole platform: GNSS is one potentially
 * untrusted sensor. This engine never asks "is the GNSS fix accurate?" - it
 * cannot know that. It asks "is this GNSS fix *consistent* with everything else
 * I can observe, and does it behave the way a genuine GNSS fix behaves?".
 *
 * Detection is rule based and explicitly enumerated so that every rejection can
 * be explained to an operator in one sentence. Each rule contributes a named
 * condition; conditions carry configurable penalties which are combined into a
 * 0-100 trust score. Rules that are physically impossible to explain away
 * (position on land, a 50 m jump, frozen coordinates) force rejection outright
 * rather than being averaged into a score.
 *
 * Debouncing: transient single-epoch outliers must not reject a healthy
 * receiver (Section 24 "healthy GNSS not falsely rejected"), so each condition
 * must persist for a configurable number of epochs before it is confirmed.
 */

import {
  GnssCondition,
  GnssTrustStatus,
  GnssAction,
  trustScoreToStatus
} from '../models/enums.js';
import { getConfig } from '../config/index.js';
import { headingDifference, normalizeHeading, neToCourseSpeed } from '../utils/geo.js';
import { isOnLand, isInOperatingArea } from '../geospatial/environment.js';
import { RollingWindow, clamp } from '../utils/stats.js';

/**
 * Conditions that indicate a deliberate deception rather than degradation.
 *
 * Note what is deliberately NOT here: disagreement with dead reckoning or with
 * the DVL velocity. Those are *symmetric* - a gyro bias, a frozen DVL or a log
 * scale error produces exactly the same disagreement as a spoofed GNSS, and
 * the platform has no basis for blaming GNSS specifically. Calling that
 * "spoofing" would mean a broken speed log gets reported to the operator as an
 * attack. Only disagreement with an *independent absolute position* source, or
 * a signature GNSS cannot physically produce, justifies that conclusion.
 */
const SPOOFING_CONDITIONS = new Set([
  GnssCondition.EXCESSIVE_POSITION_JUMP,
  GnssCondition.GRADUAL_POSITION_DRAG,
  GnssCondition.FROZEN_COORDINATES,
  GnssCondition.POSITION_CROSSING_LAND,
  GnssCondition.RADAR_POSITION_DISAGREEMENT,
  GnssCondition.LIDAR_POSITION_DISAGREEMENT,
  GnssCondition.BATHYMETRIC_POSITION_DISAGREEMENT,
  GnssCondition.GNSS_TIME_JUMP,
  GnssCondition.IMPOSSIBLE_VESSEL_SPEED,
  GnssCondition.IMPROBABLE_ACCELERATION,
  GnssCondition.OUTSIDE_ALLOWED_WATER_POLYGON
]);

/**
 * Conditions that are real inconsistencies but do not identify which sensor is
 * at fault. They reduce GNSS trust but never, on their own, declare an attack.
 */
const AMBIGUOUS_CONDITIONS = new Set([
  GnssCondition.DEAD_RECKONING_DISAGREEMENT,
  GnssCondition.VELOCITY_DISAGREEMENT,
  GnssCondition.HEADING_DISAGREEMENT
]);

/** Conditions that indicate interference rather than deception. */
const JAMMING_CONDITIONS = new Set([
  GnssCondition.SUDDEN_MULTI_SATELLITE_SNR_DROP,
  GnssCondition.DEGRADED_SIGNAL_METRICS,
  GnssCondition.LOW_SATELLITE_COUNT,
  GnssCondition.HIGH_DILUTION_OF_PRECISION,
  GnssCondition.NO_FIX,
  GnssCondition.SIGNAL_LOST
]);

export class GnssIntegrityEngine {
  constructor({ environment }) {
    this.env = environment;
    this.reset();
  }

  reset() {
    this.lastMessageTime = null;
    this.lastPosition = null; // { east, north, t }
    this.lastVelocity = null;
    this.lastHeading = null;
    this.lastGnssClockTime = null;
    this.offsetWindow = []; // { t, de, dn } GNSS minus independent-reference offsets
    this.dragReferenceSource = null;
    this.cn0Window = new RollingWindow(60);
    this.satWindow = new RollingWindow(60);
    this.frozenWindow = [];
    this.conditionStreaks = new Map();
    this.confirmedConditions = new Set();
    this.recovery = null;
    this.lastResult = null;
    this.lastRejectionReason = null;
    this.rejectedSince = null;
    this.signalDegraded = false;
    /**
     * Recovery validation only applies to GNSS that was *lost or rejected*
     * after having been usable. Before the first valid fix there is nothing to
     * recover from, and treating start-up as a recovery would hold GNSS out
     * for 30 s of every run for no reason.
     */
    this.hasHadValidFix = false;
  }

  /**
   * Evaluate one epoch.
   *
   * @param {object} input
   * @param {object|null} input.message normalized GNSS message (null when absent)
   * @param {number} input.time simulation time
   * @param {object|null} input.fused predicted fused position { east, north, sigmaM }
   * @param {object|null} input.deadReckoning DR state
   * @param {object|null} input.radar radar localization result
   * @param {object|null} input.lidar LiDAR localization result
   * @param {object|null} input.bathymetric bathymetric match result
   * @param {number|null} input.gyroHeadingDeg
   * @param {number|null} input.dvlSpeedMps
   * @param {boolean} input.gnssCurrentlyExcluded
   * @returns {object} trust assessment
   */
  evaluate(input) {
    const cfg = getConfig().gnss_integrity;
    const {
      message,
      time,
      fused = null,
      deadReckoning = null,
      radar = null,
      lidar = null,
      bathymetric = null,
      gyroHeadingDeg = null,
      dvlSpeedMps = null,
      gnssCurrentlyExcluded = false
    } = input;

    /** @type {Set<string>} */
    const raw = new Set();
    const diagnostics = {
      diff_from_fused_m: null,
      diff_from_radar_m: null,
      diff_from_lidar_m: null,
      diff_from_bathy_m: null,
      diff_from_dr_m: null,
      time_offset_s: null,
      drag_rate_m_per_s: null,
      drag_r2: null,
      position_jump_m: null,
      acceleration_mps2: null,
      turn_rate_dps: null,
      speed_mps: null,
      cn0_drop_db: null,
      heading_difference_deg: null,
      velocity_difference_mps: null
    };

    // --- Absence of GNSS ---------------------------------------------------
    if (!message) {
      const ageS = this.lastMessageTime === null ? null : time - this.lastMessageTime;
      if (ageS === null || ageS > cfg.max_message_age_s) {
        raw.add(GnssCondition.SIGNAL_LOST);
      } else {
        raw.add(GnssCondition.STALE_GNSS_TIMESTAMP);
      }
      return this.finalize({ raw, diagnostics, time, message: null, cfg, gnssCurrentlyExcluded, quality: {} });
    }

    const q = message.quality || {};
    this.lastMessageTime = time;

    // --- Message-level validity -------------------------------------------
    if (message.valid === false || q.fix_type === 'NO_FIX' || !message.position) {
      raw.add(GnssCondition.NO_FIX);
      return this.finalize({ raw, diagnostics, time, message, cfg, gnssCurrentlyExcluded, quality: q });
    }

    const local = this.env.frame.toLocal(message.position.latitude, message.position.longitude);

    // --- Timestamp integrity ------------------------------------------------
    const clockTimeMs = new Date(message.timestamp_utc).getTime();
    if (Number.isFinite(clockTimeMs)) {
      if (this.epochMs !== undefined) {
        const expectedMs = this.epochMs + time * 1000;
        const offsetS = (clockTimeMs - expectedMs) / 1000;
        diagnostics.time_offset_s = Number(offsetS.toFixed(4));
        if (Math.abs(offsetS) > cfg.max_time_offset_s) raw.add(GnssCondition.GNSS_TIME_JUMP);
      }
      if (this.lastGnssClockTime !== null) {
        const step = (clockTimeMs - this.lastGnssClockTime) / 1000;
        if (step < -cfg.max_time_jump_s || step > cfg.max_time_jump_s + 1 / 5) {
          // A backwards or oversized clock step is not a normal receiver behaviour.
          if (Math.abs(step) > cfg.max_time_jump_s * 3) raw.add(GnssCondition.GNSS_TIME_JUMP);
        }
      }
      this.lastGnssClockTime = clockTimeMs;
    }

    // --- Signal quality metrics --------------------------------------------
    if (Number.isFinite(q.satellites)) {
      this.satWindow.push(q.satellites);
      if (q.satellites < cfg.min_satellites) raw.add(GnssCondition.LOW_SATELLITE_COUNT);
    }
    if (Number.isFinite(q.cn0_mean_dbhz)) {
      const previousMax = this.cn0Window.length ? Math.max(...this.cn0Window.values()) : null;
      this.cn0Window.push(q.cn0_mean_dbhz);
      if (q.cn0_mean_dbhz < cfg.min_cn0_dbhz) raw.add(GnssCondition.DEGRADED_SIGNAL_METRICS);
      if (previousMax !== null) {
        const drop = previousMax - q.cn0_mean_dbhz;
        diagnostics.cn0_drop_db = Number(drop.toFixed(2));
        if (drop >= cfg.cn0_drop_alarm_db) raw.add(GnssCondition.SUDDEN_MULTI_SATELLITE_SNR_DROP);
      }
    }
    // Warn-level degradation. Not a fault on its own, but it is the evidence
    // that distinguishes interference from deception when the two would
    // otherwise look identical.
    this.signalDegraded =
      (Number.isFinite(q.cn0_mean_dbhz) && q.cn0_mean_dbhz < cfg.warn_cn0_dbhz) ||
      (Number.isFinite(q.hdop) && q.hdop > cfg.warn_hdop) ||
      (Number.isFinite(q.satellites) && q.satellites < cfg.warn_satellites);
    diagnostics.signal_degraded = this.signalDegraded;

    if (Number.isFinite(q.hdop) && q.hdop > cfg.max_hdop) raw.add(GnssCondition.HIGH_DILUTION_OF_PRECISION);
    if (Number.isFinite(q.pdop) && q.pdop > cfg.max_pdop) raw.add(GnssCondition.HIGH_DILUTION_OF_PRECISION);
    if (Number.isFinite(q.clock_bias_ns) && Math.abs(q.clock_bias_ns) > 5e8) {
      raw.add(GnssCondition.CLOCK_BIAS_ANOMALY);
    }
    // A receiver claiming better accuracy than its own DOP supports is a
    // classic spoofer signature.
    if (Number.isFinite(q.reported_accuracy_m) && Number.isFinite(q.hdop)) {
      if (q.reported_accuracy_m < 0.05 * q.hdop) raw.add(GnssCondition.REPORTED_ACCURACY_IMPLAUSIBLE);
    }

    // --- Kinematic plausibility --------------------------------------------
    // Evaluated over a minimum baseline. Over a 0.2 s epoch, GNSS measurement
    // noise alone implies speeds of many metres per second, so a short-baseline
    // test would report an "impossible speed" on a perfectly healthy receiver
    // several times an hour. A one-second baseline reduces the noise-implied
    // speed to well under the vessel's own speed while still detecting a jump
    // inside the two-second alarm budget.
    const reportedSigma = Number.isFinite(q.reported_accuracy_m) ? q.reported_accuracy_m : 1.0;
    if (this.lastPosition && time - this.lastPosition.t >= cfg.kinematic_min_dt_s) {
      const dt = time - this.lastPosition.t;
      if (dt > 0) {
        const jump = Math.hypot(local.east - this.lastPosition.east, local.north - this.lastPosition.north);
        const impliedSpeed = jump / dt;
        // Allowance for the noise in the two positions being differenced.
        const noiseAllowance = cfg.kinematic_noise_sigma * Math.SQRT2 * reportedSigma;
        diagnostics.position_jump_m = Number(jump.toFixed(3));
        diagnostics.speed_mps = Number(impliedSpeed.toFixed(3));
        diagnostics.kinematic_noise_allowance_m = Number(noiseAllowance.toFixed(3));
        if (jump > cfg.max_position_jump_m + noiseAllowance && dt < 3.0) {
          raw.add(GnssCondition.EXCESSIVE_POSITION_JUMP);
        }
        if (impliedSpeed > cfg.max_speed_mps + noiseAllowance / dt) {
          raw.add(GnssCondition.IMPOSSIBLE_VESSEL_SPEED);
        }
        if (this.lastVelocity && message.velocity) {
          const dv = Math.hypot(
            message.velocity.north_mps - this.lastVelocity.north_mps,
            message.velocity.east_mps - this.lastVelocity.east_mps
          );
          const accel = dv / dt;
          diagnostics.acceleration_mps2 = Number(accel.toFixed(3));
          // Doppler velocity noise is far smaller than position noise but is
          // still allowed for rather than assumed away.
          const velNoise = (cfg.kinematic_noise_sigma * Math.SQRT2 * 0.1) / dt;
          if (accel > cfg.max_acceleration_mps2 + velNoise) raw.add(GnssCondition.IMPROBABLE_ACCELERATION);
        }
        if (this.lastHeading !== null && message.velocity) {
          const { courseDeg, speedMps } = neToCourseSpeed(message.velocity.north_mps, message.velocity.east_mps);
          if (speedMps > 0.5) {
            const turn = Math.abs(headingDifference(courseDeg, this.lastHeading)) / dt;
            diagnostics.turn_rate_dps = Number(turn.toFixed(3));
            if (turn > cfg.max_turn_rate_dps) raw.add(GnssCondition.IMPOSSIBLE_TURN_RATE);
          }
        }
      }
      this.lastPosition = { east: local.east, north: local.north, t: time };
    } else if (!this.lastPosition) {
      this.lastPosition = { east: local.east, north: local.north, t: time };
    }

    // --- Frozen coordinates -------------------------------------------------
    this.frozenWindow.push({ t: time, east: local.east, north: local.north });
    while (this.frozenWindow.length && time - this.frozenWindow[0].t > cfg.frozen_window_s) {
      this.frozenWindow.shift();
    }
    // A frozen receiver only matters if the vessel is actually moving; the
    // independent speed reference is the DVL, never GNSS itself.
    const independentSpeed = dvlSpeedMps ?? (deadReckoning ? Math.abs(deadReckoning.speed_mps) : null);
    if (
      this.frozenWindow.length > 4 &&
      time - this.frozenWindow[0].t >= cfg.frozen_window_s * 0.8 &&
      independentSpeed !== null &&
      independentSpeed > cfg.frozen_min_vessel_speed_mps
    ) {
      const spread = Math.max(
        ...this.frozenWindow.map((p) =>
          Math.hypot(p.east - this.frozenWindow[0].east, p.north - this.frozenWindow[0].north)
        )
      );
      if (spread < cfg.frozen_position_epsilon_m) raw.add(GnssCondition.FROZEN_COORDINATES);
    }

    // --- Geographic plausibility -------------------------------------------
    if (cfg.land_violation_enabled && isOnLand(this.env, local.east, local.north)) {
      raw.add(GnssCondition.POSITION_CROSSING_LAND);
    }
    if (cfg.operating_area_violation_enabled && !isInOperatingArea(this.env, local.east, local.north)) {
      raw.add(GnssCondition.OUTSIDE_ALLOWED_WATER_POLYGON);
    }

    // --- Cross-checks against independent sources ---------------------------
    // The threshold adapts to how precise the independent source claims to be.
    // A radar fix good to 1 m and one good to 8 m warrant different levels of
    // suspicion for the same disagreement. Detecting the disagreement here,
    // early, is what stops the residual monitor from excluding the *honest*
    // sensor because it disagrees with a solution GNSS has already dragged.
    const compare = (source, conditionCode, limit, key) => {
      if (!source || !source.valid || !Number.isFinite(source.east_m)) return;
      const d = Math.hypot(local.east - source.east_m, local.north - source.north_m);
      diagnostics[key] = Number(d.toFixed(3));
      const adaptive = Math.max(limit, cfg.cross_check_sigma_multiple * (source.sigma_m ?? 1));
      if (d > adaptive) raw.add(conditionCode);
    };
    compare(radar, GnssCondition.RADAR_POSITION_DISAGREEMENT, cfg.radar_disagreement_m, 'diff_from_radar_m');
    compare(lidar, GnssCondition.LIDAR_POSITION_DISAGREEMENT, cfg.lidar_disagreement_m, 'diff_from_lidar_m');
    compare(
      bathymetric,
      GnssCondition.BATHYMETRIC_POSITION_DISAGREEMENT,
      cfg.bathymetric_disagreement_m,
      'diff_from_bathy_m'
    );

    if (deadReckoning && Number.isFinite(deadReckoning.east_m)) {
      const d = Math.hypot(local.east - deadReckoning.east_m, local.north - deadReckoning.north_m);
      diagnostics.diff_from_dr_m = Number(d.toFixed(3));
      // The DR uncertainty must be allowed for; comparing against a fixed
      // threshold would raise false alarms after a long unaided period.
      const allowance = Math.max(cfg.dead_reckoning_disagreement_m, 3 * (deadReckoning.sigma_m ?? 0));
      if (d > allowance) raw.add(GnssCondition.DEAD_RECKONING_DISAGREEMENT);
    }

    if (fused && Number.isFinite(fused.east)) {
      const de = local.east - fused.east;
      const dn = local.north - fused.north;
      const d = Math.hypot(de, dn);
      diagnostics.diff_from_fused_m = Number(d.toFixed(3));
      // Innovation gate against the filter's own uncertainty.
      const innovationLimit = Math.max(cfg.max_position_innovation_m, 4 * (fused.sigmaM ?? 1));
      if (d > innovationLimit && !gnssCurrentlyExcluded) {
        raw.add(GnssCondition.EXCESSIVE_POSITION_JUMP);
      }
    }

    // --- Drag reference -----------------------------------------------------
    // The drag detector must watch GNSS against something GNSS does not
    // influence. Measured against the fused solution it would be watching
    // itself: while GNSS is still in the filter it drags the fused position
    // with it, the apparent offset stays small, and a slow spoof hides inside
    // its own effect. An independent absolute fix is used whenever one exists.
    const dragReference =
      radar?.valid && Number.isFinite(radar.east_m)
        ? { east: radar.east_m, north: radar.north_m, source: 'RADAR' }
        : lidar?.valid && Number.isFinite(lidar.east_m)
          ? { east: lidar.east_m, north: lidar.north_m, source: 'LIDAR' }
          : bathymetric?.valid && Number.isFinite(bathymetric.east_m)
            ? { east: bathymetric.east_m, north: bathymetric.north_m, source: 'BATHYMETRIC' }
            : deadReckoning && Number.isFinite(deadReckoning.east_m) && deadReckoning.bottom_lock !== false
              ? { east: deadReckoning.east_m, north: deadReckoning.north_m, source: 'DEAD_RECKONING' }
              : fused && Number.isFinite(fused.east)
                ? { east: fused.east, north: fused.north, source: 'FUSED' }
                : null;

    if (dragReference) {
      // Switching reference shifts the offset by the difference between the two
      // sources, which would look exactly like a drag. Start again instead.
      if (this.dragReferenceSource && this.dragReferenceSource !== dragReference.source) {
        this.offsetWindow = [];
      }
      this.dragReferenceSource = dragReference.source;
      const de = local.east - dragReference.east;
      const dn = local.north - dragReference.north;
      this.offsetWindow.push({ t: time, de, dn, d: Math.hypot(de, dn), source: dragReference.source });
      while (this.offsetWindow.length && time - this.offsetWindow[0].t > cfg.drag_window_s) {
        this.offsetWindow.shift();
      }
      diagnostics.drag_reference = dragReference.source;
    }

    // --- Gradual drag detection ---------------------------------------------
    // The hardest spoofing case: each epoch is plausible, but the *offset*
    // between GNSS and the independent solution walks steadily in one
    // direction. A least-squares fit of offset magnitude against time exposes
    // it long before any single-epoch threshold does.
    if (this.offsetWindow.length >= 8) {
      const drag = this.fitDrag();
      diagnostics.drag_rate_m_per_s = Number(drag.rate.toFixed(5));
      diagnostics.drag_r2 = Number(drag.r2.toFixed(4));
      diagnostics.drag_offset_m = Number(drag.currentOffset.toFixed(3));
      diagnostics.drag_direction_deg = Number(drag.direction_deg.toFixed(1));
      // Three conditions must hold together: the offset is growing steadily
      // (rate), the growth is systematic rather than noise (R^2), and the
      // accumulated offset is already operationally significant. Requiring all
      // three is what keeps a healthy receiver from being called a spoofer.
      if (
        drag.rate >= cfg.drag_rate_alarm_m_per_s &&
        drag.r2 >= cfg.drag_min_r2 &&
        drag.currentOffset >= cfg.drag_min_offset_m
      ) {
        raw.add(GnssCondition.GRADUAL_POSITION_DRAG);
      }
    }

    // --- Velocity and heading cross-checks ----------------------------------
    if (message.velocity) {
      const { courseDeg, speedMps } = neToCourseSpeed(message.velocity.north_mps, message.velocity.east_mps);
      this.lastHeading = courseDeg;
      if (Number.isFinite(dvlSpeedMps)) {
        const dv = Math.abs(speedMps - dvlSpeedMps);
        diagnostics.velocity_difference_mps = Number(dv.toFixed(3));
        if (dv > cfg.max_velocity_innovation_mps) raw.add(GnssCondition.VELOCITY_DISAGREEMENT);
      }
      if (Number.isFinite(gyroHeadingDeg) && speedMps > 1.0) {
        const dh = Math.abs(headingDifference(courseDeg, gyroHeadingDeg));
        diagnostics.heading_difference_deg = Number(dh.toFixed(2));
        if (dh > cfg.max_heading_disagreement_deg) raw.add(GnssCondition.HEADING_DISAGREEMENT);
      }
      this.lastVelocity = message.velocity;
    }

    return this.finalize({
      raw,
      diagnostics,
      time,
      message,
      cfg,
      gnssCurrentlyExcluded,
      quality: q,
      localPosition: local
    });
  }

  /**
   * Least-squares fit of the GNSS-minus-fused offset against time.
   * Returns the drift rate along the dominant direction and its R^2.
   */
  fitDrag() {
    const w = this.offsetWindow;
    const n = w.length;
    const t0 = w[0].t;
    // Project each offset onto the mean offset direction so that a genuine drag
    // shows as a monotone increase while random noise does not.
    const meanDe = w.reduce((a, p) => a + p.de, 0) / n;
    const meanDn = w.reduce((a, p) => a + p.dn, 0) / n;
    const norm = Math.hypot(meanDe, meanDn);
    const ux = norm > 1e-6 ? meanDe / norm : 1;
    const uy = norm > 1e-6 ? meanDn / norm : 0;
    const xs = w.map((p) => p.t - t0);
    const ys = w.map((p) => p.de * ux + p.dn * uy);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    const currentOffset = w[n - 1].d;
    return {
      rate: Math.abs(slope),
      r2,
      currentOffset,
      direction_deg: normalizeHeading((Math.atan2(ux, uy) * 180) / Math.PI)
    };
  }

  /**
   * Apply debouncing, compute the score, decide the action and manage the
   * recovery-validation state machine.
   */
  finalize({ raw, diagnostics, time, message, cfg, gnssCurrentlyExcluded, quality, localPosition = null }) {
    // --- Debounce -----------------------------------------------------------
    const confirmed = new Set();
    const allCodes = new Set([...raw, ...this.conditionStreaks.keys()]);
    for (const code of allCodes) {
      const required = cfg.confirm_epochs?.[code] ?? cfg.confirm_epochs?.default ?? 1;
      const streak = raw.has(code) ? (this.conditionStreaks.get(code) ?? 0) + 1 : 0;
      if (streak === 0) this.conditionStreaks.delete(code);
      else this.conditionStreaks.set(code, streak);
      if (streak >= required) confirmed.add(code);
    }
    this.confirmedConditions = confirmed;

    // --- Score --------------------------------------------------------------
    let score = 100;
    for (const code of confirmed) {
      score -= cfg.penalties?.[code] ?? 15;
    }
    score = clamp(score, 0, 100);

    const critical = [...confirmed].filter((c) => (cfg.critical_conditions || []).includes(c));
    if (critical.length > 0) score = 0;

    let status = trustScoreToStatus(score);

    // --- Classification: interference or deception? --------------------------
    // The distinction matters operationally. Interference degrades the signal
    // and the operator's response is to watch and report. Deception means
    // someone is deliberately feeding false positions, and the response is to
    // distrust GNSS everywhere on the bridge. Calling one the other is a
    // serious error in both directions.
    //
    // A signature only a deceiver can produce - a jump, a steady drag, frozen
    // coordinates, a position on land, a time step - is deception regardless of
    // signal quality. Mere disagreement with an independent fix, while the
    // signal is measurably degraded, is what interference looks like: the
    // receiver is producing an honest but noisy answer.
    const DECEPTION_ONLY = [
      GnssCondition.EXCESSIVE_POSITION_JUMP,
      GnssCondition.GRADUAL_POSITION_DRAG,
      GnssCondition.FROZEN_COORDINATES,
      GnssCondition.POSITION_CROSSING_LAND,
      GnssCondition.GNSS_TIME_JUMP,
      GnssCondition.OUTSIDE_ALLOWED_WATER_POLYGON,
      GnssCondition.IMPOSSIBLE_VESSEL_SPEED,
      GnssCondition.IMPROBABLE_ACCELERATION,
      GnssCondition.IMPOSSIBLE_TURN_RATE
    ];
    const deceptionSignature = DECEPTION_ONLY.some((c) => confirmed.has(c));
    const jammingSignature = [...confirmed].some((c) => JAMMING_CONDITIONS.has(c));
    const positionDisagreement = [...confirmed].some((c) => SPOOFING_CONDITIONS.has(c));

    const spoofingSuspected =
      deceptionSignature || (positionDisagreement && !jammingSignature && !this.signalDegraded);
    const jammingSuspected = !spoofingSuspected && (jammingSignature || (positionDisagreement && this.signalDegraded));

    // --- Recovery validation state machine ---------------------------------
    // GNSS that returns after a rejection is never trusted immediately
    // (Section 4.8). It must agree with the trusted solution for the whole
    // validation window before it may contribute again.
    const clean = confirmed.size === 0 && Boolean(message);
    // Captured *before* this epoch updates it: a first-ever valid fix is not a
    // recovery from anything.
    const wasEverValid = this.hasHadValidFix;
    if (clean) this.hasHadValidFix = true;
    if (wasEverValid && (gnssCurrentlyExcluded || this.rejectedSince !== null)) {
      if (clean) {
        if (!this.recovery) {
          this.recovery = { startedAt: time, samples: 0, consistent: 0, maxDiff: 0 };
        }
        this.recovery.samples += 1;
        const diff = diagnostics.diff_from_fused_m;
        if (diff === null || diff <= cfg.recovery_max_position_difference_m) this.recovery.consistent += 1;
        if (diff !== null) this.recovery.maxDiff = Math.max(this.recovery.maxDiff, diff);
      } else if (this.recovery) {
        // Any anomaly restarts the validation window from zero.
        this.recovery = null;
      }
    }

    let recoveryActive = false;
    let recoveryProgress = 0;
    let recoveryComplete = false;
    if (this.recovery) {
      const elapsed = time - this.recovery.startedAt;
      recoveryProgress = clamp(elapsed / cfg.recovery_validation_s, 0, 1);
      const consistentFraction = this.recovery.samples ? this.recovery.consistent / this.recovery.samples : 0;
      recoveryComplete =
        elapsed >= cfg.recovery_validation_s && consistentFraction >= cfg.recovery_required_consistent_fraction;
      recoveryActive = !recoveryComplete;
    }

    // --- Recommended action -------------------------------------------------
    let action;
    // A message the receiver has itself marked invalid is never used, whatever
    // the arithmetic says. Debouncing exists to avoid over-reacting to noise,
    // not to override an explicit disclaimer from the sensor.
    if (
      !message ||
      raw.has(GnssCondition.NO_FIX) ||
      raw.has(GnssCondition.SIGNAL_LOST) ||
      confirmed.has(GnssCondition.NO_FIX) ||
      confirmed.has(GnssCondition.SIGNAL_LOST)
    ) {
      action = GnssAction.EXCLUDE_FROM_FUSION;
      status = GnssTrustStatus.REJECTED;
    } else if (recoveryActive) {
      action = GnssAction.HOLD_FOR_VALIDATION;
    } else if (score <= cfg.reject_score_below) {
      action = GnssAction.EXCLUDE_FROM_FUSION;
    } else if (score <= cfg.highly_suspect_score_below) {
      action = GnssAction.EXCLUDE_FROM_FUSION;
    } else if (score <= cfg.degraded_score_below) {
      action = GnssAction.DEWEIGHT_IN_FUSION;
    } else {
      action = GnssAction.USE_IN_FUSION;
    }

    if (action === GnssAction.EXCLUDE_FROM_FUSION) {
      // Only count this as a *rejection* - the thing recovery validation exists
      // to recover from - if the receiver had previously been usable. At
      // start-up there is simply no fix yet, and treating that as a rejection
      // would hold GNSS out for the full validation window on every run.
      if (this.rejectedSince === null && this.hasHadValidFix) this.rejectedSince = time;
      this.lastRejectionReason = this.explain(confirmed, diagnostics);
    } else if (action === GnssAction.USE_IN_FUSION && recoveryComplete) {
      this.rejectedSince = null;
      this.recovery = null;
    } else if (action === GnssAction.USE_IN_FUSION && !recoveryActive) {
      this.rejectedSince = null;
    }

    // The covariance inflation applied when GNSS is used but de-weighted.
    const deweightFactor = action === GnssAction.DEWEIGHT_IN_FUSION ? clamp(100 / Math.max(1, score), 1, 12) : 1;

    const result = {
      trust_score: Number(score.toFixed(1)),
      status,
      detected_conditions: [...confirmed].sort(),
      pending_conditions: [...raw].filter((c) => !confirmed.has(c)).sort(),
      recommended_action: action,
      spoofing_suspected: spoofingSuspected,
      jamming_suspected: jammingSuspected,
      critical_conditions: critical,
      deweight_factor: Number(deweightFactor.toFixed(3)),
      recovery: this.recovery
        ? {
            active: recoveryActive,
            complete: recoveryComplete,
            progress: Number(recoveryProgress.toFixed(3)),
            elapsed_s: Number((time - this.recovery.startedAt).toFixed(2)),
            required_s: cfg.recovery_validation_s,
            consistent_samples: this.recovery.consistent,
            total_samples: this.recovery.samples,
            max_difference_m: Number(this.recovery.maxDiff.toFixed(3))
          }
        : null,
      rejected_since_s: this.rejectedSince,
      explanation: this.explain(confirmed, diagnostics, !message),
      diagnostics,
      quality: {
        satellites: quality.satellites ?? null,
        hdop: quality.hdop ?? null,
        pdop: quality.pdop ?? null,
        cn0_mean_dbhz: quality.cn0_mean_dbhz ?? null,
        fix_type: quality.fix_type ?? null,
        reported_accuracy_m: quality.reported_accuracy_m ?? null
      },
      position: message?.position ?? null,
      local_position: localPosition,
      time_s: time
    };

    this.lastResult = result;
    return result;
  }

  /**
   * One-sentence, operator-readable explanation (Section 12).
   * Example: "GNSS excluded because the reported position differs from radar
   * localization by 38.4 m and is moving east while DVL and gyro indicate
   * north-east motion."
   */
  explain(conditions, d, noMessage = false) {
    if (conditions.size === 0) {
      return noMessage
        ? 'No GNSS message has been received; GNSS is contributing nothing to the solution.'
        : 'GNSS is consistent with all independent measurements.';
    }
    const parts = [];
    for (const c of conditions) {
      switch (c) {
        case GnssCondition.EXCESSIVE_POSITION_JUMP:
          parts.push(`the reported position jumped ${fmt(d.position_jump_m)} m in a single update`);
          break;
        case GnssCondition.GRADUAL_POSITION_DRAG:
          parts.push(
            `the offset from the independent solution is walking away at ${fmt(d.drag_rate_m_per_s, 3)} m/s (R² ${fmt(d.drag_r2, 2)})`
          );
          break;
        case GnssCondition.RADAR_POSITION_DISAGREEMENT:
          parts.push(`it differs from radar localization by ${fmt(d.diff_from_radar_m)} m`);
          break;
        case GnssCondition.LIDAR_POSITION_DISAGREEMENT:
          parts.push(`it differs from LiDAR localization by ${fmt(d.diff_from_lidar_m)} m`);
          break;
        case GnssCondition.BATHYMETRIC_POSITION_DISAGREEMENT:
          parts.push(`it differs from the bathymetric fix by ${fmt(d.diff_from_bathy_m)} m`);
          break;
        case GnssCondition.DEAD_RECKONING_DISAGREEMENT:
          parts.push(`it differs from the dead-reckoned position by ${fmt(d.diff_from_dr_m)} m`);
          break;
        case GnssCondition.FROZEN_COORDINATES:
          parts.push('the coordinates are frozen while the DVL shows the vessel is making way');
          break;
        case GnssCondition.POSITION_CROSSING_LAND:
          parts.push('the reported position is on land');
          break;
        case GnssCondition.OUTSIDE_ALLOWED_WATER_POLYGON:
          parts.push('the reported position is outside the approved operating area');
          break;
        case GnssCondition.IMPOSSIBLE_VESSEL_SPEED:
          parts.push(`the implied speed of ${fmt(d.speed_mps)} m/s exceeds the vessel's capability`);
          break;
        case GnssCondition.IMPROBABLE_ACCELERATION:
          parts.push(`the implied acceleration of ${fmt(d.acceleration_mps2)} m/s² is not physically possible`);
          break;
        case GnssCondition.IMPOSSIBLE_TURN_RATE:
          parts.push(`the implied turn rate of ${fmt(d.turn_rate_dps)} deg/s is not physically possible`);
          break;
        case GnssCondition.VELOCITY_DISAGREEMENT:
          parts.push(`its velocity differs from the DVL by ${fmt(d.velocity_difference_mps)} m/s`);
          break;
        case GnssCondition.HEADING_DISAGREEMENT:
          parts.push(`its course differs from the gyrocompass heading by ${fmt(d.heading_difference_deg, 1)} deg`);
          break;
        case GnssCondition.GNSS_TIME_JUMP:
          parts.push(`its timestamp is offset from system time by ${fmt(d.time_offset_s, 2)} s`);
          break;
        case GnssCondition.STALE_GNSS_TIMESTAMP:
          parts.push('no fresh GNSS message has been received');
          break;
        case GnssCondition.SUDDEN_MULTI_SATELLITE_SNR_DROP:
          parts.push(`carrier-to-noise density fell by ${fmt(d.cn0_drop_db, 1)} dB across the constellation`);
          break;
        case GnssCondition.DEGRADED_SIGNAL_METRICS:
          parts.push('signal quality metrics are below the acceptable threshold');
          break;
        case GnssCondition.LOW_SATELLITE_COUNT:
          parts.push('too few satellites are being tracked');
          break;
        case GnssCondition.HIGH_DILUTION_OF_PRECISION:
          parts.push('the dilution of precision is too high for a usable fix');
          break;
        case GnssCondition.NO_FIX:
          parts.push('the receiver reports no valid fix');
          break;
        case GnssCondition.SIGNAL_LOST:
          parts.push('the GNSS signal has been lost');
          break;
        case GnssCondition.CLOCK_BIAS_ANOMALY:
          parts.push('the receiver clock bias is implausible');
          break;
        case GnssCondition.REPORTED_ACCURACY_IMPLAUSIBLE:
          parts.push('the receiver claims an accuracy inconsistent with its own dilution of precision');
          break;
        default:
          parts.push(c.toLowerCase().replace(/_/g, ' '));
      }
    }
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `GNSS is not trusted because ${list}.`;
  }

  /** Provide the wall-clock epoch so message timestamps can be checked. */
  setEpoch(epochMs) {
    this.epochMs = epochMs;
  }
}

function fmt(value, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'an unknown amount';
}

export default GnssIntegrityEngine;
