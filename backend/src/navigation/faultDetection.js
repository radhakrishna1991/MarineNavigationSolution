/**
 * Fault Detection, Isolation and Exclusion (Section 12).
 *
 * Two independent layers:
 *
 *   1. Message-level checks that need no filter at all - staleness, missing
 *      data, duplicate sequence numbers, out-of-order timestamps, frozen
 *      values, invalid quality flags. These catch integration faults.
 *
 *   2. Residual monitoring against the fusion filter - normalized innovation,
 *      running chi-square consistency, and bias detection on the residual
 *      mean. These catch measurement faults that are individually plausible.
 *
 * Isolation strategy: when several sensors disagree, the one excluded is the
 * one whose residual is largest *relative to its own claimed uncertainty*, not
 * simply the largest in metres. A sensor that admits it is uncertain is not
 * punished for being uncertain.
 *
 * Every exclusion carries a plain-language explanation, and every excluded
 * sensor is offered a controlled path back in.
 */

import { FaultCategory, SensorDecision } from '../models/enums.js';
import { getConfig } from '../config/index.js';
import { RollingWindow, mean, stdDev, chi2Critical } from '../utils/stats.js';

/** Per-sensor monitoring state. */
class SensorMonitor {
  constructor(sensorId, sensorType, nominalRateHz) {
    this.sensorId = sensorId;
    this.sensorType = sensorType;
    this.nominalRateHz = nominalRateHz || 1;
    this.reset();
  }

  reset() {
    this.firstSeen = null;
    this.lastMessageTime = null;
    this.lastReceivedAt = null;
    this.messageCount = 0;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
    this.duplicateCount = 0;
    this.outOfOrderCount = 0;
    this.lastSequence = null;
    this.seenSequences = new Set();
    this.lastSignature = null;
    this.frozenCount = 0;
    this.residuals = new RollingWindow(80);
    this.normalized = new RollingWindow(80);
    // Signed innovation along the measurement's first axis. Bias must be
    // detected from signed values: the mean of a magnitude is always positive,
    // so testing magnitudes would flag every healthy sensor as biased.
    this.signed = new RollingWindow(80);
    this.gateFailures = 0;
    this.consecutiveGateFailures = 0;
    this.excluded = false;
    this.excludedAt = null;
    this.exclusionReason = null;
    this.exclusionCategory = null;
    this.reentryConsistentEpochs = 0;
    this.online = false;
    this.faults = new Set();
    this.lastDecision = SensorDecision.NOT_USED;
    this.lastReason = null;
    this.updateIntervals = new RollingWindow(40);
  }

  /** Observed update rate in Hz. */
  get updateRateHz() {
    const m = this.updateIntervals.mean();
    return m && m > 0 ? 1 / m : null;
  }
}

export class FaultDetectionEngine {
  /**
   * @param {object} options
   * @param {Array} options.sensorDefinitions catalogue entries
   */
  constructor({ sensorDefinitions = [] } = {}) {
    /** @type {Map<string, SensorMonitor>} */
    this.monitors = new Map();
    for (const def of sensorDefinitions) {
      this.monitors.set(def.sensor_id, new SensorMonitor(def.sensor_id, def.sensor_type, def.rate_hz));
    }
    this.events = [];
  }

  reset() {
    for (const m of this.monitors.values()) m.reset();
    this.events = [];
  }

  /** Get (or lazily create) a monitor for a sensor. */
  monitor(sensorId, sensorType = 'UNKNOWN', rateHz = 1) {
    let m = this.monitors.get(sensorId);
    if (!m) {
      m = new SensorMonitor(sensorId, sensorType, rateHz);
      this.monitors.set(sensorId, m);
    }
    return m;
  }

  /** Drain and clear accumulated events for publication. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  emit(event) {
    this.events.push(event);
  }

  /**
   * Message-level validation, run before a measurement is offered to the
   * filter.
   *
   * @returns {{ accept: boolean, faults: string[], reason: string|null }}
   */
  observeMessage(message, time) {
    const cfg = getConfig().fault_detection;
    const m = this.monitor(message.sensor_id, message.sensor_type);
    const faults = [];
    let accept = true;
    let reason = null;

    if (m.firstSeen === null) m.firstSeen = time;
    m.messageCount += 1;
    m.online = true;

    // --- Duplicate sequence numbers ---------------------------------------
    if (m.seenSequences.has(message.sequence_number)) {
      faults.push(FaultCategory.DUPLICATE_MESSAGE);
      m.duplicateCount += 1;
      accept = false;
      reason = `Duplicate sequence number ${message.sequence_number}`;
    } else {
      m.seenSequences.add(message.sequence_number);
      // Bound memory: keep only the most recent window of sequence numbers.
      if (m.seenSequences.size > 512) {
        const oldest = Math.min(...m.seenSequences);
        m.seenSequences.delete(oldest);
      }
    }

    // --- Out-of-order timestamps ------------------------------------------
    const msgTime = new Date(message.timestamp_utc).getTime();
    if (m.lastMessageTime !== null && Number.isFinite(msgTime)) {
      if (msgTime < m.lastMessageTime - 1) {
        faults.push(FaultCategory.OUT_OF_ORDER);
        m.outOfOrderCount += 1;
        accept = false;
        reason = 'Message timestamp is earlier than the previous message';
      }
    }

    // --- Staleness on arrival ---------------------------------------------
    if (m.epochMs === undefined && this.epochMs !== undefined) m.epochMs = this.epochMs;
    if (this.epochMs !== undefined && Number.isFinite(msgTime)) {
      const ageS = (this.epochMs + time * 1000 - msgTime) / 1000;
      m.lastAgeS = ageS;
      if (ageS > cfg.stale_data_s) {
        faults.push(FaultCategory.STALE_DATA);
        accept = false;
        reason = `Measurement is ${ageS.toFixed(1)} s old on arrival`;
      }
    }

    // --- Invalid quality flags --------------------------------------------
    if (message.valid === false) {
      faults.push(FaultCategory.INVALID_QUALITY_FLAGS);
      accept = false;
      reason = reason || `Sensor reports the measurement as invalid (${message.quality?.status ?? 'no status'})`;
    }
    if (message.sensor_type === 'DVL' && message.quality?.bottom_lock === false) {
      faults.push(FaultCategory.LOSS_OF_BOTTOM_LOCK);
      accept = false;
      reason = reason || 'DVL has lost bottom lock';
    }

    // --- Frozen values ------------------------------------------------------
    const signature = JSON.stringify([
      message.position?.latitude ?? null,
      message.position?.longitude ?? null,
      message.velocity?.north_mps ?? null,
      message.velocity?.east_mps ?? null,
      message.heading_deg ?? null,
      message.depth_m ?? null
    ]);
    if (signature === m.lastSignature && signature !== 'null') {
      m.frozenCount += 1;
      if (m.frozenCount >= cfg.frozen_value_epochs) {
        faults.push(FaultCategory.FROZEN_VALUE);
        accept = false;
        reason = `Sensor has reported an identical value for ${m.frozenCount} consecutive messages`;
      }
    } else {
      m.frozenCount = 0;
    }
    m.lastSignature = signature;

    // --- Rate bookkeeping ---------------------------------------------------
    if (m.lastReceivedAt !== null) m.updateIntervals.push(Math.max(1e-3, time - m.lastReceivedAt));
    m.lastReceivedAt = time;
    if (Number.isFinite(msgTime)) m.lastMessageTime = msgTime;
    m.lastSequence = message.sequence_number;

    for (const f of faults) m.faults.add(f);
    if (!accept) {
      m.rejectedCount += 1;
      m.lastDecision = SensorDecision.REJECTED;
      m.lastReason = reason;
    }

    return { accept, faults, reason };
  }

  /**
   * Record a filter residual for a sensor.
   *
   * @param {string} sensorId
   * @param {string} kind POSITION | VELOCITY | HEADING | DEPTH
   * @param {object} diagnostics from ExtendedKalmanFilter.update
   */
  recordResidual(sensorId, kind, diagnostics, { advisory = false } = {}) {
    const m = this.monitors.get(sensorId);
    if (!m || !diagnostics) return;
    // A measurement that was only *monitored* was never offered to the filter
    // as a correction. Its disagreement is worth reporting, but it must not
    // feed the exclusion statistics: a sensor cannot be thrown out of a
    // solution it was not contributing to in the first place.
    if (advisory || diagnostics.monitor_only) {
      if (Number.isFinite(diagnostics.normalizedInnovation)) {
        m.advisoryResiduals = m.advisoryResiduals ?? new RollingWindow(60);
        m.advisoryResiduals.push(diagnostics.normalizedInnovation);
      }
      m.lastAdvisoryKind = kind;
      return;
    }
    if (Number.isFinite(diagnostics.innovationNorm)) m.residuals.push(diagnostics.innovationNorm);
    if (Number.isFinite(diagnostics.normalizedInnovation)) m.normalized.push(diagnostics.normalizedInnovation);
    if (Array.isArray(diagnostics.innovation) && Number.isFinite(diagnostics.innovation[0])) {
      m.signed.push(diagnostics.innovation[0]);
    }
    if (Number.isFinite(diagnostics.measurement_sigma_m)) m.declaredSigma = diagnostics.measurement_sigma_m;
    if (diagnostics.gatePassed === false) {
      m.gateFailures += 1;
      m.consecutiveGateFailures += 1;
    } else {
      m.consecutiveGateFailures = 0;
    }
    if (diagnostics.applied) {
      m.acceptedCount += 1;
      m.lastDecision = SensorDecision.ACCEPTED;
      m.lastReason = null;
    }
    m.lastResidualKind = kind;
  }

  /**
   * Periodic evaluation: liveness, residual statistics, exclusion and
   * controlled reintegration.
   *
   * @param {number} time simulation time
   * @param {Set<string>} [protectedSensors] sensors that must not be excluded
   *        (e.g. the last remaining absolute source - excluding it would leave
   *        no solution at all, which the operator must be told about instead)
   * @returns {object[]} fault findings for this epoch
   */
  evaluate(time, protectedSensors = new Set(), { isolationHold = false, isolationReason = null } = {}) {
    const cfg = getConfig().fault_detection;
    const fusionCfg = getConfig().fusion;
    const findings = [];

    for (const m of this.monitors.values()) {
      const previouslyExcluded = m.excluded;
      const faults = new Set();

      // --- Liveness ---------------------------------------------------------
      const age = m.lastReceivedAt === null ? null : time - m.lastReceivedAt;
      if (age === null) {
        m.online = false;
      } else if (age > cfg.missing_data_s) {
        faults.add(FaultCategory.MISSING_DATA);
        m.online = false;
      } else if (age > cfg.stale_data_s) {
        faults.add(FaultCategory.STALE_DATA);
        m.online = true;
      } else {
        m.online = true;
      }

      // --- Residual statistics ----------------------------------------------
      const normalizedMean = m.normalized.mean();
      const normalizedRms = m.normalized.rms();
      const residualStd = m.residuals.stdDev();

      if (m.normalized.length >= 8) {
        if (normalizedRms !== null && normalizedRms > cfg.normalized_residual_exclude) {
          faults.add(FaultCategory.INDEPENDENT_DISAGREEMENT);
        } else if (normalizedRms !== null && normalizedRms > cfg.normalized_residual_warn) {
          faults.add(FaultCategory.EXCESSIVE_NOISE);
        }
        // A persistent non-zero *signed* residual mean is a bias, not noise.
        // The offset must exceed the sensor's own noise spread to count: a
        // sub-noise offset is not operationally meaningful and flagging it
        // would produce a stream of nuisance alarms.
        if (m.signed.length >= cfg.bias_detection_window / 2) {
          const signedMean = mean(m.signed.values());
          const signedStd = stdDev(m.signed.values());
          m.lastSignedMean = signedMean;
          m.lastSignedStd = signedStd;
          // Floor the test at a fraction of the sensor's declared uncertainty.
          // Without the floor, a very precise sensor with a sub-millimetre
          // systematic offset would be excluded for a bias nobody cares about.
          const floor = cfg.bias_absolute_floor_fraction * (m.declaredSigma ?? 0);
          const spread = Math.max(signedStd ?? 0, floor);
          if (spread > 0 && Math.abs(signedMean) > cfg.bias_threshold_sigma * spread) {
            faults.add(FaultCategory.BIAS);
          }
        }
      }

      // --- Running chi-square consistency test ------------------------------
      if (m.normalized.length >= 10) {
        const values = m.normalized.values();
        const chi = values.reduce((acc, v) => acc + v * v, 0);
        const dof = values.length;
        const threshold = chi2Critical(Math.min(4, dof), cfg.chi_square_alpha) * (dof / Math.min(4, dof));
        m.lastChiSquare = chi;
        m.lastChiThreshold = threshold;
        m.lastMeanNis = chi / dof;
        if (chi > threshold * cfg.chi_square_exclude_multiplier) {
          faults.add(FaultCategory.INDEPENDENT_DISAGREEMENT);
        }
      }

      if (m.consecutiveGateFailures >= fusionCfg.gating.max_consecutive_gate_failures) {
        faults.add(FaultCategory.IMPOSSIBLE_RATE);
      }

      // --- Rate check ---------------------------------------------------------
      // Recorded for the health panel but NOT an exclusion trigger. Several
      // sensors legitimately report only when they have something to report -
      // a LiDAR out of range of any structure is silent, not faulty.
      const observedRate = m.updateRateHz;
      m.rateDeficit =
        observedRate !== null && m.nominalRateHz > 0 ? Number((observedRate / m.nominalRateHz).toFixed(3)) : null;

      m.faults = new Set([...m.faults, ...faults]);

      // --- Exclusion decision -------------------------------------------------
      // Exclusion is reserved for sensors producing *wrong* data. A sensor that
      // is merely absent contributes nothing and needs no exclusion; saying it
      // was "excluded" would misrepresent what happened.
      const excludable =
        faults.has(FaultCategory.INDEPENDENT_DISAGREEMENT) ||
        faults.has(FaultCategory.FROZEN_VALUE) ||
        faults.has(FaultCategory.IMPOSSIBLE_RATE) ||
        faults.has(FaultCategory.BIAS);

      // --- Isolation hold ------------------------------------------------------
      // While a suspect sensor is still contributing, every *other* sensor's
      // residual is measured against a solution that suspect sensor is pulling
      // off track. Excluding on that basis removes the honest sensor and keeps
      // the liar - the exact inversion the platform exists to prevent. So
      // exclusions of the sensors that disagree with the suspect one are held
      // until the suspect is resolved.
      if (isolationHold && excludable && !m.excluded && m.sensorId !== 'GNSS_01') {
        findings.push({
          sensor_id: m.sensorId,
          sensor_type: m.sensorType,
          category: [...faults][0] ?? null,
          severity: 'INFO',
          action: 'EXCLUSION_HELD',
          explanation:
            `Exclusion of ${m.sensorId} is on hold: ${isolationReason ?? 'another source is under suspicion'}. ` +
            'Its residuals are measured against a solution that suspect source is influencing, so they are not ' +
            'yet evidence against this sensor.'
        });
        m.exclusionHeld = true;
        continue;
      }
      m.exclusionHeld = false;

      let justExcluded = false;
      if (cfg.auto_exclude && excludable && !m.excluded) {
        if (protectedSensors.has(m.sensorId)) {
          // Do not silently remove the last thing holding the solution up.
          findings.push({
            sensor_id: m.sensorId,
            sensor_type: m.sensorType,
            category: [...faults][0] ?? FaultCategory.EXCESSIVE_NOISE,
            severity: 'WARNING',
            action: 'RETAINED_UNDER_PROTEST',
            explanation:
              `${m.sensorId} is showing ${describeFaults(faults)} but is the only remaining absolute ` +
              'position source. It has been retained and the protection level inflated instead of excluded. ' +
              'Verify the position by independent means.'
          });
        } else {
          m.excluded = true;
          justExcluded = true;
          m.exclusionForced = false;
          m.excludedAt = time;
          m.exclusionCategory = [...faults][0];
          m.exclusionReason = this.explainExclusion(m, faults, normalizedRms, residualStd);
          m.lastDecision = SensorDecision.EXCLUDED;
          m.lastReason = m.exclusionReason;
          m.reentryConsistentEpochs = 0;
          // Clear the residual history at the moment of exclusion. An excluded
          // sensor contributes no new residuals, so a retained window would
          // keep re-triggering the same fault forever and the sensor could
          // never be reintegrated - the controlled re-entry path would be dead
          // code. The evidence has been acted on; it must not also block
          // recovery. If the sensor is still faulty, residuals rebuild and it
          // is excluded again.
          m.normalized.clear();
          m.residuals.clear();
          m.signed.clear();
          m.consecutiveGateFailures = 0;
          findings.push({
            sensor_id: m.sensorId,
            sensor_type: m.sensorType,
            category: m.exclusionCategory,
            severity: 'WARNING',
            action: 'EXCLUDED',
            explanation: m.exclusionReason
          });
          this.emit({ type: 'SENSOR_EXCLUDED', sensor_id: m.sensorId, time_s: time, reason: m.exclusionReason });
        }
      }

      // --- Controlled reintegration ------------------------------------------
      // A forced exclusion belongs to whichever engine imposed it (the GNSS
      // trust engine, or an operator). The residual monitor must not overrule
      // it, or the two would fight and the sensor would flicker in and out.
      // The `faults` set here is what was observed in *this* epoch only, so a
      // sensor that has started behaving is not judged on its history.
      if (cfg.auto_reintegrate && m.excluded && !m.exclusionForced && !justExcluded) {
        const quiet = time - m.excludedAt >= fusionCfg.sensor_reentry_delay_s;
        const consistent = faults.size === 0 && m.online;
        if (quiet && consistent) {
          m.reentryConsistentEpochs += 1;
          if (m.reentryConsistentEpochs >= fusionCfg.sensor_reentry_consistent_epochs) {
            m.excluded = false;
            m.exclusionReason = null;
            m.exclusionCategory = null;
            m.faults.clear();
            m.normalized.clear();
            m.residuals.clear();
            m.signed.clear();
            m.gateFailures = 0;
            m.lastDecision = SensorDecision.ACCEPTED;
            findings.push({
              sensor_id: m.sensorId,
              sensor_type: m.sensorType,
              category: null,
              severity: 'INFO',
              action: 'REINTEGRATED',
              explanation: `${m.sensorId} has been consistent for ${fusionCfg.sensor_reentry_consistent_epochs} consecutive epochs and has been returned to the navigation solution.`
            });
            this.emit({ type: 'SENSOR_REINTEGRATED', sensor_id: m.sensorId, time_s: time });
          }
        } else {
          m.reentryConsistentEpochs = 0;
        }
      }

      if (!previouslyExcluded && !m.excluded && faults.size > 0 && !excludable) {
        m.lastDecision = SensorDecision.DEWEIGHTED;
        m.lastReason = describeFaults(faults);
      }
    }

    return findings;
  }

  /** Human-readable exclusion sentence (Section 12). */
  explainExclusion(monitor, faults, normalizedRms, residualStd) {
    const bits = [];
    if (faults.has(FaultCategory.MISSING_DATA)) bits.push('it has stopped reporting');
    if (faults.has(FaultCategory.FROZEN_VALUE)) bits.push('its output is frozen');
    if (faults.has(FaultCategory.INDEPENDENT_DISAGREEMENT)) {
      bits.push(
        `its measurements disagree with the fused solution by ${
          Number.isFinite(normalizedRms) ? normalizedRms.toFixed(1) : 'an excessive number of'
        } standard deviations`
      );
    }
    if (faults.has(FaultCategory.BIAS)) bits.push('its residuals show a persistent bias rather than random noise');
    if (faults.has(FaultCategory.IMPOSSIBLE_RATE)) bits.push('it failed the innovation gate on consecutive updates');
    if (faults.has(FaultCategory.EXCESSIVE_NOISE)) {
      bits.push(`its noise level (${residualStd ? residualStd.toFixed(2) : 'unknown'}) exceeds its declared uncertainty`);
    }
    const list = bits.length
      ? bits.length === 1
        ? bits[0]
        : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
      : 'it failed consistency monitoring';
    return `${monitor.sensorId} was excluded from the navigation solution because ${list}.`;
  }

  /** Is a sensor currently excluded? */
  isExcluded(sensorId) {
    return this.monitors.get(sensorId)?.excluded ?? false;
  }

  /** Force-exclude a sensor (used when the GNSS trust engine rejects GNSS). */
  forceExclude(sensorId, reason, time, category = FaultCategory.INDEPENDENT_DISAGREEMENT) {
    const m = this.monitor(sensorId);
    if (m.excluded) return false;
    m.excluded = true;
    m.exclusionForced = true;
    m.excludedAt = time;
    m.exclusionReason = reason;
    m.exclusionCategory = category;
    m.lastDecision = SensorDecision.EXCLUDED;
    m.lastReason = reason;
    return true;
  }

  /** Clear a forced exclusion. */
  clearExclusion(sensorId) {
    const m = this.monitors.get(sensorId);
    if (!m || !m.excluded) return false;
    m.excluded = false;
    m.exclusionForced = false;
    m.exclusionReason = null;
    m.exclusionCategory = null;
    m.reentryConsistentEpochs = 0;
    // Residual history accumulated while the sensor was out of the solution
    // describes a filter it was not contributing to; keeping it would bias the
    // monitor against a sensor that has just been readmitted.
    m.normalized.clear();
    m.residuals.clear();
    m.signed.clear();
    return true;
  }

  /** Snapshot for the sensor-health panel (Section 15.2). */
  snapshot(time) {
    const out = [];
    for (const m of this.monitors.values()) {
      out.push({
        sensor_id: m.sensorId,
        sensor_type: m.sensorType,
        online: m.online,
        last_update_s: m.lastReceivedAt,
        data_age_s: m.lastReceivedAt === null ? null : Number((time - m.lastReceivedAt).toFixed(3)),
        update_rate_hz: m.updateRateHz === null ? null : Number(m.updateRateHz.toFixed(2)),
        nominal_rate_hz: m.nominalRateHz,
        message_count: m.messageCount,
        accepted_count: m.acceptedCount,
        rejected_count: m.rejectedCount,
        duplicate_count: m.duplicateCount,
        out_of_order_count: m.outOfOrderCount,
        gate_failures: m.gateFailures,
        residual_rms: m.residuals.rms() === null ? null : Number(m.residuals.rms().toFixed(4)),
        normalized_residual_rms: m.normalized.rms() === null ? null : Number(m.normalized.rms().toFixed(4)),
        chi_square: m.lastChiSquare ?? null,
        chi_square_threshold: m.lastChiThreshold ?? null,
        excluded: m.excluded,
        exclusion_reason: m.exclusionReason,
        exclusion_category: m.exclusionCategory,
        faults: [...m.faults],
        decision: m.lastDecision,
        reason: m.lastReason
      });
    }
    return out.sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  }

  setEpoch(epochMs) {
    this.epochMs = epochMs;
  }
}

function describeFaults(faults) {
  return [...faults].map((f) => f.toLowerCase().replace(/_/g, ' ')).join(', ');
}

export default FaultDetectionEngine;
