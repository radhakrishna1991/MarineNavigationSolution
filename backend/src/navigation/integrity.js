/**
 * Integrity engine (Sections 6 and 13).
 *
 * This engine is deliberately *separate* from the fusion filter. The filter's
 * job is to produce the best estimate; this engine's job is to decide whether
 * that estimate may be trusted, and to say so in the vocabulary the
 * specification requires. The two must not be the same code path, because a
 * filter that grades its own homework is exactly the failure mode the platform
 * exists to prevent.
 *
 * Vocabulary (Section 13 - these are NOT interchangeable):
 *   accuracy       how close the estimate is to truth. Only measurable against
 *                  a reference; reported in the performance report, never live.
 *   precision      the spread of the estimate: the filter covariance.
 *   confidence     a probability statement about a stated region (95%/99% radius).
 *   integrity      the ability to *bound* the error and warn when the bound is
 *                  exceeded. This is the protection level and its status.
 *   availability   whether a usable solution exists at all.
 *   continuity     whether it will keep existing for the intended operation.
 *
 * Protection-level model
 *   HPL = k_conf * sigma_major * inflation + bias_margin
 * where
 *   sigma_major   largest eigenvalue sqrt of the horizontal position covariance
 *   k_conf        Rayleigh quantile for the configured confidence (2.448 @ 95%)
 *   inflation     applied when redundancy is thin (single source / unbounded DR)
 *   bias_margin   worst-case undetected measurement bias, approximated as the
 *                 residual-monitor detection threshold projected onto position
 *                 (the classical RAIM fault-slope argument, simplified)
 *
 * This is a simplified formulation, clearly labelled as such. A certified
 * system would derive protection levels from a documented fault tree with
 * quantified prior probabilities per failure mode.
 */

import { IntegrityStatus, RequirementStatus } from '../models/enums.js';
import { getConfig } from '../config/index.js';
import { eigen2x2 } from '../utils/matrix.js';
import { rayleighK, RollingWindow, clamp, chi2Critical } from '../utils/stats.js';

export class IntegrityEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.hplWindow = new RollingWindow(50);
    this.lastResult = null;
    this.lastAbsoluteFixTime = null;
    this.lastAbsoluteFixSource = null;
    this.requirementHistory = [];
  }

  /**
   * @param {object} input
   * @param {number[][]} input.positionCovariance 2x2 ENU covariance
   * @param {number} input.time simulation time
   * @param {number|null} input.solutionAgeS age of the newest measurement used
   * @param {object[]} input.absoluteSources currently valid absolute sources
   *        [{ sensor_id, sensor_type, sigma_m, confidence }]
   * @param {object|null} input.deadReckoning DR state
   * @param {object[]} input.activeSensors all sensors currently contributing
   * @param {object[]} input.faultFindings findings from the FDE engine
   * @param {boolean} input.solutionAvailable
   * @param {number|null} input.mapConfidence best map-matching confidence
   * @param {boolean} input.timeSyncValid
   * @param {number|null} input.maxNormalizedResidual worst monitored residual
   */
  evaluate(input) {
    const cfg = getConfig();
    const intCfg = cfg.integrity;
    const reqCfg = cfg.requirements;
    const plCfg = intCfg.protection_level;

    const {
      positionCovariance,
      time,
      solutionAgeS = 0,
      absoluteSources = [],
      deadReckoning = null,
      activeSensors = [],
      faultFindings = [],
      solutionAvailable = true,
      mapConfidence = null,
      timeSyncValid = true,
      maxNormalizedResidual = null,
      unresolvedCriticalFault = false,
      observedDisagreementM = 0
    } = input;

    // --- Precision: the covariance ------------------------------------------
    const ellipse = positionCovariance ? eigen2x2(positionCovariance) : { major: null, minor: null, orientationDeg: 0 };
    const sigmaMajor = ellipse.major;
    const sigmaMinor = ellipse.minor;
    // DRMS: the single-number horizontal precision figure.
    const drms = positionCovariance ? Math.sqrt(positionCovariance[0][0] + positionCovariance[1][1]) : null;

    // --- Confidence radii -----------------------------------------------------
    const k95 = rayleighK(reqCfg.confidence_level);
    const k99 = rayleighK(reqCfg.secondary_confidence_level);
    const radius95 = sigmaMajor === null ? null : k95 * sigmaMajor;
    const radius99 = sigmaMajor === null ? null : k99 * sigmaMajor;

    // --- Redundancy ----------------------------------------------------------
    const independentAbsoluteSources = absoluteSources.length;
    if (independentAbsoluteSources > 0) {
      this.lastAbsoluteFixTime = time;
      this.lastAbsoluteFixSource = absoluteSources.map((s) => s.sensor_id).join(', ');
    }
    const absoluteFixAgeS = this.lastAbsoluteFixTime === null ? null : time - this.lastAbsoluteFixTime;
    const drDurationS = deadReckoning?.duration_s ?? absoluteFixAgeS ?? null;

    // --- Sensor diversity ----------------------------------------------------
    // How many *physically independent* measurement principles are contributing?
    // Two GNSS receivers are not diversity; a radar and a DVL are.
    const principles = new Set(
      activeSensors.map((s) => {
        switch (s.sensor_type) {
          case 'GNSS':
            return 'RADIO_NAVIGATION_SATELLITE';
          case 'LOCAL_RANGING':
            return 'RADIO_NAVIGATION_TERRESTRIAL';
          case 'RADAR':
            return 'RADIO_IMAGING';
          case 'LIDAR':
            return 'OPTICAL_IMAGING';
          case 'BATHYMETRIC_MATCH':
          case 'ECHO_SOUNDER':
          case 'MULTIBEAM':
            return 'ACOUSTIC_TERRAIN';
          case 'DVL':
            return 'ACOUSTIC_DOPPLER';
          case 'SPEED_LOG':
            return 'HYDRODYNAMIC';
          case 'GYRO':
            return 'INERTIAL_HEADING';
          case 'INS':
            return 'INERTIAL';
          default:
            return 'OTHER';
        }
      })
    );
    const sensorDiversityScore = clamp(principles.size / 5, 0, 1);

    // --- Protection level -----------------------------------------------------
    let inflation = 1;
    const inflationReasons = [];
    if (independentAbsoluteSources === 1) {
      inflation *= plCfg.single_source_inflation;
      inflationReasons.push('SINGLE_ABSOLUTE_SOURCE');
    }
    if (independentAbsoluteSources === 0) {
      inflation *= plCfg.unbounded_dr_inflation;
      inflationReasons.push('NO_ABSOLUTE_SOURCE');
    }
    if (unresolvedCriticalFault) {
      inflation *= 1.5;
      inflationReasons.push('UNRESOLVED_CRITICAL_FAULT');
    }

    // --- Bias margin (fault-slope argument, simplified) ---------------------
    // The largest position error a *just-undetectable* measurement fault could
    // induce. A fault in measurement i is caught once its normalized residual
    // exceeds the gate; the largest bias that stays under the gate is
    // T * sigma_i, and it moves the solution by that bias times the filter's
    // gain for that measurement. A noisy measurement therefore contributes a
    // *smaller* margin than a precise one, because the filter weights it less.
    //
    //   gain_i  = sigma_pos^2 / (sigma_pos^2 + sigma_i^2)
    //   bias_i  = gain_i * T * sigma_i
    //   margin  = max_i bias_i
    //
    // This is a simplified stand-in for a documented fault tree with
    // quantified per-mode prior probabilities, which certification would need.
    const gateSigma = Math.sqrt(
      chi2Critical(2, getConfig().fusion.gating.position_alpha)
    );
    const sigmaPos2 = sigmaMajor === null ? 1 : Math.max(1e-6, sigmaMajor ** 2);
    const candidateBiases = absoluteSources.map((s) => {
      const si = Math.max(0.05, s.sigma_m ?? 1);
      const gain = sigmaPos2 / (sigmaPos2 + si * si);
      return gain * gateSigma * si;
    });
    if (candidateBiases.length === 0 && deadReckoning?.sigma_m) {
      // With no absolute source the undetectable bias is bounded by the
      // dead-reckoning uncertainty itself; nothing is checking it.
      candidateBiases.push(0.5 * deadReckoning.sigma_m);
    }
    // --- Observed disagreement ----------------------------------------------
    // The fault-slope term above bounds a bias that has NOT been detected. When
    // two absolute sources are measurably disagreeing and both are still in the
    // solution, the bias is no longer hypothetical: the solution sits somewhere
    // between them and could be wrong by as much as the gap. Bounding it by the
    // covariance alone would publish a tight protection level during exactly
    // the window a slow spoof is taking effect - the moment the number matters
    // most. The observed gap is therefore carried straight into the bound.
    const disagreementMargin = Number.isFinite(observedDisagreementM) ? Math.max(0, observedDisagreementM) : 0;
    if (disagreementMargin > plCfg.min_bias_margin_m) inflationReasons.push('ABSOLUTE_SOURCES_DISAGREE');

    const biasMargin = Math.max(
      plCfg.min_bias_margin_m,
      plCfg.fault_slope_margin_multiplier * (candidateBiases.length ? Math.max(...candidateBiases) : 0),
      disagreementMargin
    );

    // --- Irreducible correlated error ---------------------------------------
    // Every absolute source carries a slowly varying error the filter cannot
    // average away: GNSS multipath and antenna offset, radar and LiDAR map
    // registration, bathymetric survey datum, beacon survey error. Over an
    // averaging window the filter's covariance shrinks towards zero while this
    // component does not, so a protection level built from the covariance alone
    // steadily *understates* the true error - it would claim assurance the
    // system does not have. Independent sources reduce it in inverse-variance
    // combination, which is why redundancy genuinely helps.
    let correlatedSigma = plCfg.default_correlated_sigma_m;
    if (absoluteSources.length > 0) {
      let precision = 0;
      for (const s of absoluteSources) {
        const sc = plCfg.correlated_sigma_m?.[s.sensor_type] ?? plCfg.default_correlated_sigma_m;
        if (sc > 0) precision += 1 / (sc * sc);
      }
      correlatedSigma = precision > 0 ? Math.sqrt(1 / precision) : plCfg.default_correlated_sigma_m;
    }

    let hpl = null;
    if (sigmaMajor !== null && Number.isFinite(sigmaMajor)) {
      const combinedSigma = Math.hypot(sigmaMajor, correlatedSigma);
      hpl = Math.min(plCfg.max_reported_m, k95 * combinedSigma * inflation + biasMargin);
    }
    // A dead-reckoned solution can never have a protection level smaller than
    // the dead-reckoning engine's own independent uncertainty estimate.
    if (deadReckoning && independentAbsoluteSources === 0 && Number.isFinite(deadReckoning.sigma_m)) {
      const drHpl = k95 * deadReckoning.sigma_m + biasMargin;
      hpl = hpl === null ? drHpl : Math.max(hpl, drHpl);
    }

    this.hplWindow.push(hpl ?? plCfg.max_reported_m);
    const hplGrowthRate = this.hplWindow.length >= 5 ? this.hplWindow.slope() * (cfg.simulation.publish_hz || 5) : 0;

    // Estimated position error: the expected magnitude of the error given the
    // covariance (Rayleigh mean). This is an *estimate*, never a measurement.
    const estimatedHorizontalErrorM =
      sigmaMajor === null ? null : Math.sqrt((Math.PI / 2)) * Math.sqrt((sigmaMajor ** 2 + sigmaMinor ** 2) / 2);

    // --- Availability and integrity status ------------------------------------
    let integrityStatus;
    const integrityReasons = [];

    // Ordering matters. "Unknown" means the question cannot be answered; it
    // must not be reported when the answer is in fact knowable and bad. A
    // solution that is old but whose bound demonstrably exceeds the limit is
    // NOT ASSURED, not unknown - the operator needs the stronger statement.
    if (!solutionAvailable) {
      integrityStatus = IntegrityStatus.NOT_ASSURED;
      integrityReasons.push('NO_NAVIGATION_SOLUTION');
    } else if (!timeSyncValid) {
      integrityStatus = IntegrityStatus.UNKNOWN;
      integrityReasons.push('TIME_SYNCHRONISATION_INVALID');
    } else if (hpl === null) {
      integrityStatus = IntegrityStatus.UNKNOWN;
      integrityReasons.push('PROTECTION_LEVEL_NOT_COMPUTABLE');
    } else if (hpl > intCfg.degraded_max_hpl_m || independentAbsoluteSources === 0) {
      integrityStatus = IntegrityStatus.NOT_ASSURED;
      if (hpl > intCfg.degraded_max_hpl_m) integrityReasons.push('PROTECTION_LEVEL_EXCEEDS_LIMIT');
      if (independentAbsoluteSources === 0) integrityReasons.push('NO_INDEPENDENT_ABSOLUTE_SOURCE');
      if (solutionAgeS > intCfg.max_solution_age_s) integrityReasons.push('SOLUTION_TOO_OLD');
    } else if (solutionAgeS > intCfg.max_solution_age_s) {
      // Bound is inside the limit but the measurement it rests on is stale, so
      // the bound itself can no longer be relied upon.
      integrityStatus = IntegrityStatus.UNKNOWN;
      integrityReasons.push('SOLUTION_TOO_OLD');
    } else if (
      hpl > intCfg.assured_max_hpl_m ||
      sensorDiversityScore < intCfg.min_sensor_diversity_score ||
      unresolvedCriticalFault
    ) {
      integrityStatus = IntegrityStatus.DEGRADED;
      if (hpl > intCfg.assured_max_hpl_m) integrityReasons.push('PROTECTION_LEVEL_ABOVE_ASSURED_LIMIT');
      if (sensorDiversityScore < intCfg.min_sensor_diversity_score) integrityReasons.push('LOW_SENSOR_DIVERSITY');
      if (unresolvedCriticalFault) integrityReasons.push('UNRESOLVED_CRITICAL_FAULT');
    } else {
      integrityStatus = IntegrityStatus.ASSURED;
    }

    // --- Safeen <2 m requirement status ---------------------------------------
    const requirement = this.evaluateRequirement({
      hpl,
      independentAbsoluteSources,
      integrityStatus,
      hplGrowthRate,
      mapConfidence,
      timeSyncValid,
      solutionAvailable,
      absoluteFixAgeS,
      unresolvedCriticalFault,
      faultFindings,
      maxNormalizedResidual,
      mapMatchingIsOnlySource:
        absoluteSources.length > 0 &&
        absoluteSources.every((s) => ['RADAR', 'LIDAR', 'BATHYMETRIC_MATCH'].includes(s.sensor_type))
    });

    const result = {
      time_s: time,
      // Precision
      sigma_east_m: positionCovariance ? Math.sqrt(positionCovariance[0][0]) : null,
      sigma_north_m: positionCovariance ? Math.sqrt(positionCovariance[1][1]) : null,
      drms_m: drms === null ? null : Number(drms.toFixed(4)),
      confidence_ellipse: {
        semi_major_m: sigmaMajor === null ? null : Number((sigmaMajor * k95).toFixed(4)),
        semi_minor_m: sigmaMinor === null ? null : Number((sigmaMinor * k95).toFixed(4)),
        orientation_deg: Number(ellipse.orientationDeg.toFixed(2)),
        confidence: reqCfg.confidence_level,
        one_sigma_major_m: sigmaMajor === null ? null : Number(sigmaMajor.toFixed(4)),
        one_sigma_minor_m: sigmaMinor === null ? null : Number(sigmaMinor.toFixed(4))
      },
      // Confidence
      radius_95_m: radius95 === null ? null : Number(radius95.toFixed(4)),
      radius_99_m: radius99 === null ? null : Number(radius99.toFixed(4)),
      // Integrity
      horizontal_protection_level_m: hpl === null ? null : Number(hpl.toFixed(4)),
      // Vertical protection level: placeholder. The platform has no independent
      // vertical reference beyond the sounder, so publishing a VPL would be
      // misleading. Documented in docs/limitations.md.
      vertical_protection_level_m: null,
      vertical_protection_level_status: 'NOT_IMPLEMENTED_NO_INDEPENDENT_VERTICAL_REFERENCE',
      estimated_horizontal_error_m:
        estimatedHorizontalErrorM === null ? null : Number(estimatedHorizontalErrorM.toFixed(4)),
      protection_level_inflation: Number(inflation.toFixed(3)),
      protection_level_inflation_reasons: inflationReasons,
      bias_margin_m: Number(biasMargin.toFixed(4)),
      observed_disagreement_m: Number(disagreementMargin.toFixed(4)),
      correlated_sigma_m: Number(correlatedSigma.toFixed(4)),
      protection_level_growth_rate_m_per_s: Number(hplGrowthRate.toFixed(5)),
      integrity_status: integrityStatus,
      integrity_reasons: integrityReasons,
      // Availability / continuity
      solution_available: solutionAvailable,
      solution_age_s: solutionAgeS === null ? null : Number(solutionAgeS.toFixed(3)),
      time_since_last_absolute_fix_s: absoluteFixAgeS === null ? null : Number(absoluteFixAgeS.toFixed(2)),
      last_absolute_fix_source: this.lastAbsoluteFixSource,
      dead_reckoning_duration_s: drDurationS === null ? null : Number(drDurationS.toFixed(2)),
      independent_absolute_sources: independentAbsoluteSources,
      absolute_source_ids: absoluteSources.map((s) => s.sensor_id),
      sensor_diversity_score: Number(sensorDiversityScore.toFixed(3)),
      measurement_principles: [...principles],
      fault_detection_status: faultFindings.length === 0 ? 'NO_FAULTS' : 'FAULTS_DETECTED',
      fault_count: faultFindings.length,
      // Requirement
      ...requirement
    };

    this.lastResult = result;
    this.requirementHistory.push({ t: time, status: requirement.requirement_status });
    if (this.requirementHistory.length > 5000) this.requirementHistory.shift();
    return result;
  }

  /**
   * Safeen <2 m requirement decision logic (Section 6).
   * Implemented exactly as specified, with every threshold configurable.
   */
  evaluateRequirement({
    hpl,
    independentAbsoluteSources,
    integrityStatus,
    hplGrowthRate,
    mapConfidence,
    timeSyncValid,
    solutionAvailable,
    absoluteFixAgeS,
    unresolvedCriticalFault,
    mapMatchingIsOnlySource = false
  }) {
    const req = getConfig().requirements;
    const reasons = [];

    // INSUFFICIENT_INFORMATION takes precedence: we must never colour a status
    // green or red when the inputs to the decision are missing.
    if (!solutionAvailable) {
      reasons.push('No navigation solution is available.');
      return this.requirementResult(RequirementStatus.INSUFFICIENT_INFORMATION, reasons, hpl);
    }
    if (!timeSyncValid) {
      reasons.push('Time synchronisation is invalid, so measurement alignment cannot be verified.');
      return this.requirementResult(RequirementStatus.INSUFFICIENT_INFORMATION, reasons, hpl);
    }
    if (hpl === null || !Number.isFinite(hpl)) {
      reasons.push('The horizontal protection level could not be computed.');
      return this.requirementResult(RequirementStatus.INSUFFICIENT_INFORMATION, reasons, hpl);
    }
    // REQUIREMENT_NOT_MET
    const unboundedDr =
      independentAbsoluteSources === 0 &&
      absoluteFixAgeS !== null &&
      absoluteFixAgeS > req.max_absolute_fix_age_s;
    if (hpl > req.horizontal_error_limit_m) {
      reasons.push(
        `Horizontal protection level ${hpl.toFixed(2)} m exceeds the ${req.horizontal_error_limit_m} m limit.`
      );
    }
    if (integrityStatus === IntegrityStatus.NOT_ASSURED) {
      reasons.push('Integrity is not assured.');
    }
    if (unboundedDr) {
      reasons.push(
        `The system is operating on unbounded dead reckoning (${absoluteFixAgeS.toFixed(0)} s since the last absolute fix).`
      );
    }
    if (reasons.length > 0) {
      return this.requirementResult(RequirementStatus.REQUIREMENT_NOT_MET, reasons, hpl);
    }

    // Low map-matching confidence makes the answer *unknowable* only when map
    // matching is the only absolute source there is. This is checked after the
    // NOT_MET tests deliberately: if the protection level already exceeds the
    // limit, that is a definite and more useful answer than "insufficient
    // information", and reporting the weaker statement would bury a breach.
    if (
      mapConfidence !== null &&
      mapConfidence < req.min_map_confidence &&
      independentAbsoluteSources > 0 &&
      mapMatchingIsOnlySource
    ) {
      reasons.push(
        `Map localization confidence (${mapConfidence.toFixed(2)}) is below the minimum of ${req.min_map_confidence}, and map matching is the only absolute position source available.`
      );
      return this.requirementResult(RequirementStatus.INSUFFICIENT_INFORMATION, reasons, hpl);
    }

    // REQUIREMENT_AT_RISK
    if (hpl > req.at_risk_lower_bound_m) {
      reasons.push(
        `Horizontal protection level ${hpl.toFixed(2)} m is within the caution band (${req.at_risk_lower_bound_m} - ${req.horizontal_error_limit_m} m).`
      );
    }
    if (independentAbsoluteSources <= 1) {
      reasons.push('Only one independent absolute positioning source is available - there is no redundancy.');
    }
    if (hplGrowthRate > req.rapid_uncertainty_growth_m_per_s) {
      reasons.push(`Uncertainty is growing rapidly (${hplGrowthRate.toFixed(3)} m/s).`);
    }
    if (unresolvedCriticalFault) {
      reasons.push('An unresolved sensor fault is being carried by the solution.');
    }
    if (reasons.length > 0) {
      return this.requirementResult(RequirementStatus.REQUIREMENT_AT_RISK, reasons, hpl);
    }

    // REQUIREMENT_MET requires all three positive conditions, not just a small
    // number. A green status is never shown on average accuracy alone.
    if (independentAbsoluteSources < req.min_independent_absolute_sources) {
      reasons.push('No independent absolute positioning source is valid.');
      return this.requirementResult(RequirementStatus.REQUIREMENT_NOT_MET, reasons, hpl);
    }
    reasons.push(
      `Protection level ${hpl.toFixed(2)} m is within the ${req.horizontal_error_limit_m} m limit at ${(req.confidence_level * 100).toFixed(0)}% confidence, with ${independentAbsoluteSources} independent absolute source(s) valid and no unresolved critical inconsistency.`
    );
    return this.requirementResult(RequirementStatus.REQUIREMENT_MET, reasons, hpl);
  }

  requirementResult(status, reasons, hpl) {
    const req = getConfig().requirements;
    return {
      requirement_status: status,
      requirement_reasons: reasons,
      requirement_limit_m: req.horizontal_error_limit_m,
      requirement_confidence: req.confidence_level,
      requirement_margin_m: hpl === null ? null : Number((req.horizontal_error_limit_m - hpl).toFixed(4)),
      requirement_statement:
        status === 'REQUIREMENT_MET'
          ? `Horizontal position error is bounded below ${req.horizontal_error_limit_m} m at ${(req.confidence_level * 100).toFixed(0)}% confidence.`
          : status === 'REQUIREMENT_AT_RISK'
            ? `The ${req.horizontal_error_limit_m} m requirement is still met but the margin is thin or shrinking.`
            : status === 'REQUIREMENT_NOT_MET'
              ? `The ${req.horizontal_error_limit_m} m requirement cannot currently be assured.`
              : 'There is not enough information to state whether the requirement is met.'
    };
  }
}

export default IntegrityEngine;
