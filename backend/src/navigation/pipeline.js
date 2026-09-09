/**
 * Navigation pipeline - the orchestrator (Section 3).
 *
 *   ingest -> time sync -> validation -> GNSS trust -> localization engines ->
 *   fusion -> FDE -> integrity -> mode -> trusted output
 *
 * The ordering matters and is deliberate:
 *
 *  1. The prior pose is captured immediately after the time update, *before*
 *     any measurement is applied. Every consistency check - GNSS innovation,
 *     scan-matching seed, terrain-matching search centre - uses that same
 *     prior, so no check is contaminated by the measurement it is judging.
 *  2. Heading and velocity are applied before position. Position updates rely
 *     on the heading estimate through the body-frame velocity model.
 *  3. GNSS is applied last, and only if the trust engine and the fault
 *     detector both allow it.
 *  4. Integrity is computed from the *result*, by a separate engine, and the
 *     mode machine consumes integrity rather than producing it.
 */

import { SensorType, SensorDecision, AlarmSeverity, ADVISORY_ONLY_SOURCES } from '../models/enums.js';
import { getConfig, sensorCatalog } from '../config/index.js';
import FusionEngine from './fusion/fusionEngine.js';
import DeadReckoningEngine from './deadReckoning.js';
import { createRadarEngine, createLidarEngine } from './radarMatching.js';
import BathymetricMatchingEngine from './bathymetricMatching.js';
import LocalPositioningEngine from './localPositioning.js';
import GnssIntegrityEngine from './gnssIntegrity.js';
import FaultDetectionEngine from './faultDetection.js';
import IntegrityEngine from './integrity.js';
import ModeManager from './modeManager.js';
import { TimeIntegrityMonitor } from './timeIntegrity.js';
import { haversineMetres, normalizeHeading } from '../utils/geo.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pipeline');

export class NavigationPipeline {
  /**
   * @param {object} options
   * @param {object} options.environment
   * @param {boolean} [options.insEnabled]
   * @param {boolean} [options.localRangingEnabled]
   * @param {number} [options.epochMs] wall-clock epoch of simulation time 0
   */
  constructor({ environment, insEnabled = true, localRangingEnabled = false, epochMs = Date.now() }) {
    this.env = environment;
    this.insEnabled = insEnabled;
    this.localRangingEnabled = localRangingEnabled;
    this.epochMs = epochMs;

    this.fusion = new FusionEngine({ environment });
    this.deadReckoning = new DeadReckoningEngine({ environment });
    this.radarEngine = createRadarEngine(environment);
    this.lidarEngine = createLidarEngine(environment);
    this.bathyEngine = new BathymetricMatchingEngine({ environment });
    this.localEngine = new LocalPositioningEngine({ environment });
    this.gnssEngine = new GnssIntegrityEngine({ environment });
    this.faultDetector = new FaultDetectionEngine({ sensorDefinitions: sensorCatalog });
    this.integrityEngine = new IntegrityEngine();
    this.modeManager = new ModeManager();
    this.timeIntegrity = new TimeIntegrityMonitor();

    this.gnssEngine.setEpoch(epochMs);
    this.faultDetector.setEpoch(epochMs);

    this.reset();
  }

  reset() {
    this.fusion.reset();
    this.timeIntegrity.reset();
    this.deadReckoning.reset();
    this.bathyEngine.reset();
    this.gnssEngine.reset();
    this.faultDetector.reset();
    this.integrityEngine.reset();
    this.modeManager.reset();
    this.gnssEngine.setEpoch(this.epochMs);
    this.faultDetector.setEpoch(this.epochMs);

    /** Messages awaiting their delivery time. */
    this.pending = [];
    /** Latest accepted message per sensor type. */
    this.latest = new Map();
    /** Latest ground truth (never fused - used only for scoring). */
    this.groundTruth = null;
    /** Latest AIS picture (advisory only). */
    this.aisContacts = [];
    this.time = 0;
    this.lastStepTime = null;
    this.alarmRequests = [];
    this.lastOutput = null;
    this.lastGnssResult = null;
    this.messageDecisions = [];
    this.lastRadarResult = null;
    this.lastLidarResult = null;
    this.lastBathyResult = null;
    this.lastLocalResult = null;
    this.previousRequirementStatus = null;
    this.previousIntegrityStatus = null;
    this.timeSyncValid = true;
    /** Absolute sources seen within the trailing redundancy window. */
    this.recentAbsoluteSources = new Map();
    /** Most recent measured rate of turn, used to propagate heading. */
    this.lastHeadingRateDps = null;
    this.lastHeadingRateSigmaDps = 0.5;
    /** GNSS exclusion state as decided by the trust engine (not the FDE). */
    this.gnssExcludedByTrust = false;
    this.gnssExclusionAnnounced = false;
    this.gnssJustExcluded = false;
    /** Residual bias left in the solution by a source that has been excluded. */
    this.contaminationM = 0;
    this.lastObservedRawM = 0;
  }

  /**
   * Queue a message for delivery at `deliverAtS` simulation time.
   * Real adapters call this from the ingestion layer; the simulator calls it
   * with the sensor's own latency applied.
   */
  ingest(message, deliverAtS) {
    this.pending.push({ message, deliverAtS: deliverAtS ?? this.time });
  }

  /**
   * Read the newest due rate-of-turn measurement without consuming the queue.
   *
   * The rate is a *derivative*, not a position fix: using it to propagate the
   * heading state is not circular and does not let a faulty sensor define its
   * own innovation, because the heading measurement is still checked against
   * the propagated state afterwards.
   *
   * @returns {{ dps: number|null, sigmaDps: number }}
   */
  peekHeadingRate(time) {
    let best = null;
    for (const item of this.pending) {
      if (item.deliverAtS > time) continue;
      const m = item.message;
      if (m.sensor_type !== SensorType.GYRO && m.sensor_type !== SensorType.INS) continue;
      if (m.sensor_type === SensorType.INS && !this.insEnabled) continue;
      if (this.faultDetector.isExcluded(m.sensor_id)) continue;
      if (!Number.isFinite(m.raw?.rate_of_turn_dps)) continue;
      if (!best || item.deliverAtS >= best.deliverAtS) best = item;
    }
    if (!best) return { dps: this.lastHeadingRateDps, sigmaDps: 2.0 };
    const dps = best.message.raw.rate_of_turn_dps;
    this.lastHeadingRateDps = dps;
    // The rate itself changes within an epoch, so its uncertainty grows with
    // the magnitude of the turn. A steady course is well known; a turn is not.
    const sigmaDps = Math.max(best.message.raw.rate_of_turn_sigma_dps ?? 0.1, 0.1 + 0.35 * Math.abs(dps));
    this.lastHeadingRateSigmaDps = sigmaDps;
    return { dps, sigmaDps };
  }

  /**
   * Overwrite the accuracy figures using the exact instantaneous ground truth.
   *
   * Ground truth arrives through the sensor path like everything else, which
   * means it is sampled and delivered on its own schedule and can be up to one
   * epoch old. Comparing against a stale reference adds speed*dt of apparent
   * error - at 3.5 m/s and a 0.2 s epoch that is 0.7 m, comparable to the
   * quantity being measured. Since this number is the yardstick the whole
   * performance report is built on, it is computed against the exact state.
   *
   * Simulation only: there is no such thing in a real deployment, where the
   * reference is an RTK track that genuinely has to be time-aligned.
   */
  /**
   * Simulation time at which a message was sampled, from its own timestamp.
   * @returns {number|null}
   */
  sampleTimeOf(message) {
    const ms = Date.parse(message?.timestamp_utc);
    return Number.isFinite(ms) ? (ms - this.epochMs) / 1000 : null;
  }

  /**
   * Time-align a position measurement to the current epoch (Section 3,
   * "Data Ingestion and Time Synchronization").
   *
   * Every sensor reports a position that was true when it was *sampled*, not
   * when it arrives. Applying it as if it were current makes the solution lag
   * by roughly the sensor's latency: at 3.5 m/s and 300 ms of radar processing
   * that is a full metre of systematic error - the same size as the quantity
   * being measured - sitting under a protection level that knows nothing about
   * it. That is misleading information in the strict sense.
   *
   * The measurement is carried forward on the filter's own velocity estimate,
   * and its covariance is inflated by the velocity uncertainty over that
   * interval plus an allowance for unmodelled acceleration. Extrapolation is
   * never free, and the covariance says so.
   *
   * @returns {{east:number, north:number, covariance:number[][], ageS:number}}
   */
  alignToEpoch(east, north, covariance, sampleTimeS, epochTimeS) {
    const cov = covariance ?? [
      [4, 0],
      [0, 4]
    ];
    if (!Number.isFinite(sampleTimeS)) return { east, north, covariance: cov, ageS: 0 };
    const ageS = Math.max(0, epochTimeS - sampleTimeS);
    if (ageS < 1e-6 || !this.fusion.initialized) return { east, north, covariance: cov, ageS: 0 };

    const usableAge = Math.min(ageS, getConfig().fusion.max_measurement_age_s);
    const solution = this.fusion.solution();
    const vEast = solution.available ? solution.velocity_east_mps : 0;
    const vNorth = solution.available ? solution.velocity_north_mps : 0;

    const velSigma = getConfig().fusion.initial_uncertainty.velocity_mps;
    const accelAllowance = getConfig().gnss_integrity.max_acceleration_mps2;
    const extra = (velSigma * usableAge) ** 2 + (0.5 * accelAllowance * usableAge * usableAge) ** 2;

    return {
      east: east + vEast * usableAge,
      north: north + vNorth * usableAge,
      covariance: [
        [cov[0][0] + extra, cov[0][1]],
        [cov[1][0], cov[1][1] + extra]
      ],
      ageS: Number(usableAge.toFixed(4))
    };
  }

  attachGroundTruth(output, truth) {
    if (!truth || !output) return output;
    output.ground_truth = {
      latitude: truth.latitude,
      longitude: truth.longitude,
      heading_deg: Number(truth.heading_deg.toFixed(3)),
      course_deg: Number(truth.course_deg.toFixed(3)),
      speed_mps: Number(truth.speed_mps.toFixed(4)),
      turn_rate_dps: Number(truth.turn_rate_dps.toFixed(4)),
      depth_m: Number(truth.seabed_depth_m.toFixed(3)),
      zone: truth.zone,
      east_m: Number(truth.east_m.toFixed(3)),
      north_m: Number(truth.north_m.toFixed(3))
    };
    if (output.trusted_position) {
      output.actual_error_vs_truth_m = Number(
        Math.hypot(
          output.trusted_position.east_m - truth.east_m,
          output.trusted_position.north_m - truth.north_m
        ).toFixed(4)
      );
      output.heading_error_deg = Number(
        (((output.heading_deg - truth.heading_deg + 540) % 360) - 180).toFixed(3)
      );
      output.speed_error_mps = Number((output.velocity.speed_mps - truth.speed_mps).toFixed(4));
    }
    if (output.gnss?.reported_position) {
      const g = this.env.frame.toLocal(
        output.gnss.reported_position.latitude,
        output.gnss.reported_position.longitude
      );
      output.gnss.error_vs_truth_m = Number(
        Math.hypot(g.east - truth.east_m, g.north - truth.north_m).toFixed(4)
      );
    }
    return output;
  }

  /** Drain and clear queued alarm requests. */
  drainAlarms() {
    const out = this.alarmRequests;
    this.alarmRequests = [];
    return out;
  }

  /** Drain and clear per-message ingestion decisions (for the audit trail). */
  drainMessageDecisions() {
    const out = this.messageDecisions;
    this.messageDecisions = [];
    return out;
  }

  raiseAlarm(code, source, message, { severity, reason, recommendedAction, detail = {} } = {}) {
    const cfg = getConfig().alarms;
    this.alarmRequests.push({
      code,
      severity: severity || cfg.severity_for?.[code] || AlarmSeverity.ADVISORY,
      source,
      message,
      reason: reason ?? null,
      recommended_action: recommendedAction ?? null,
      sim_time_s: this.time,
      detail
    });
  }

  /**
   * Advance the pipeline to `time`, consuming every message due by then.
   * @returns {object} the trusted navigation output for this epoch
   */
  step(time) {
    this.time = time;
    const dt = this.lastStepTime === null ? 0 : time - this.lastStepTime;
    this.lastStepTime = time;

    // --- 1. Time update, then capture the untainted prior -------------------
    // Heading is propagated with the measured rate of turn so the filter
    // follows an alteration of course instead of treating it as a sequence of
    // outliers. The rate is read from *this* epoch's gyro message rather than
    // the previous one: at 8 deg/s a single-epoch lag is 1.6 deg of systematic
    // heading error, which is several sigma and gates the gyro out at exactly
    // the moment the vessel is manoeuvring.
    const rate = this.peekHeadingRate(time);
    this.fusion.beginEpoch(time, {
      headingRateDps: rate.dps,
      headingRateSigmaDps: rate.sigmaDps
    });
    const prior = this.fusion.priorPose();

    // --- 2. Deliver due messages -------------------------------------------
    const due = [];
    const stillPending = [];
    for (const item of this.pending) {
      if (item.deliverAtS <= time) due.push(item);
      else stillPending.push(item);
    }
    this.pending = stillPending;
    // Process in timestamp order so out-of-order injections are visible to the
    // fault detector rather than silently reordered here.
    due.sort((a, b) => a.deliverAtS - b.deliverAtS);

    const epochMessages = new Map();
    for (const { message } of due) {
      if (message.sensor_type === SensorType.GROUND_TRUTH) {
        this.groundTruth = message;
        continue;
      }
      if (message.sensor_type === SensorType.AIS) {
        this.aisContacts = message.raw?.contacts ?? [];
        continue;
      }
      if (!this.insEnabled && message.sensor_type === SensorType.INS) continue;
      if (!this.localRangingEnabled && message.sensor_type === SensorType.LOCAL_RANGING) continue;

      const check = this.faultDetector.observeMessage(message, time);
      this.messageDecisions.push({
        sensor_id: message.sensor_id,
        sensor_type: message.sensor_type,
        sequence_number: message.sequence_number,
        timestamp_utc: message.timestamp_utc,
        sim_time_s: time,
        decision: check.accept ? SensorDecision.ACCEPTED : SensorDecision.REJECTED,
        reason: check.reason,
        faults: check.faults
      });
      if (!check.accept) continue;

      // Keep only the newest accepted message per sensor for this epoch.
      const existing = epochMessages.get(message.sensor_id);
      if (!existing || new Date(message.timestamp_utc) >= new Date(existing.timestamp_utc)) {
        epochMessages.set(message.sensor_id, message);
      }
      this.latest.set(message.sensor_id, { message, time });
    }

    // --- 3. Extract per-type observations -----------------------------------
    const obs = this.collectObservations(epochMessages, time);

    // --- 3b. First-fix initialization ---------------------------------------
    // The filter must be seeded with a heading as well as a position. Seeding
    // position alone leaves the heading state at zero, every body-velocity
    // update is then wrong by the true heading, and the filter diverges while
    // rejecting the very measurements that would have corrected it.
    const priorPose = this.ensureInitialized(obs, time) ?? prior;

    // --- 4. Localization engines --------------------------------------------
    // `fresh` marks a result computed from a message received in *this* epoch.
    // The engines run slower than the publish rate, so without this flag the
    // previous fix would be re-applied to the filter several times: the same
    // measurement counted repeatedly, shrinking the covariance dishonestly and
    // dragging the solution back towards a position the vessel has left.
    const radarResult = obs.radar
      ? {
          ...this.radarEngine.process(obs.radar, priorPose),
          time_s: time,
          sample_time_s: this.sampleTimeOf(obs.radar),
          fresh: true
        }
      : this.decayLocalization(this.lastRadarResult, time, 3.0);
    const lidarResult = obs.lidar
      ? {
          ...this.lidarEngine.process(obs.lidar, priorPose),
          time_s: time,
          sample_time_s: this.sampleTimeOf(obs.lidar),
          fresh: true
        }
      : this.decayLocalization(this.lastLidarResult, time, 1.5);
    this.lastRadarResult = radarResult;
    this.lastLidarResult = lidarResult;

    if (obs.echo && priorPose) {
      this.bathyEngine.addObservation({
        time,
        depthBelowTransducerM: obs.echo.depth_m,
        transducerOffsetM: obs.echo.raw?.transducer_offset_m ?? 0,
        tideM: this.bathyEngine.predictedTideM(time, obs.echo.raw?.tide_m ?? 0),
        squatM: obs.echo.raw?.squat_m ?? 0,
        east: priorPose.east,
        north: priorPose.north
      });
    }
    const bathyDue = !this.lastBathyResult || time - (this.lastBathyResult.time_s ?? -99) >= 1.0;
    const bathyResult =
      bathyDue && priorPose
        ? { ...this.bathyEngine.match(priorPose, time), fresh: true }
        : this.lastBathyResult
          ? { ...this.lastBathyResult, fresh: false }
          : null;
    this.lastBathyResult = bathyResult;

    const localResult = obs.localRanging
      ? {
          ...this.localEngine.process(obs.localRanging, priorPose),
          time_s: time,
          sample_time_s: this.sampleTimeOf(obs.localRanging),
          fresh: true
        }
      : this.decayLocalization(this.lastLocalResult, time, 2.0);
    this.lastLocalResult = localResult;

    // --- 5. GNSS trust assessment -------------------------------------------
    const gnssResult = this.gnssEngine.evaluate({
      message: obs.gnss,
      time,
      fused: priorPose,
      deadReckoning: this.deadReckoning.state(),
      radar: radarResult,
      lidar: lidarResult,
      bathymetric: bathyResult,
      gyroHeadingDeg: obs.gyroHeadingDeg,
      dvlSpeedMps: obs.dvlForwardMps,
      gnssCurrentlyExcluded: this.faultDetector.isExcluded('GNSS_01')
    });
    this.lastGnssResult = gnssResult;
    this.applyGnssDecision(gnssResult, time);

    // --- 6. Fusion updates ---------------------------------------------------
    // Heading first: the body-velocity model depends on it.
    //
    // Heading sources are not peers. The gyrocompass is the compass reference
    // and its slow bias is a filter state. Radar map matching supplies an
    // *absolute* heading and must also correct, because heading and gyro bias
    // are only jointly observable from a compass alone - without an absolute
    // reference they drift together while the gyro innovation stays near zero.
    // The INS heading is the same class of sensor as the gyro, so it is only
    // monitored while a gyro is available; a third corrector adds no
    // information and makes the two compasses fight.
    const gyroUsable = Boolean(obs.gyro) && !this.faultDetector.isExcluded(obs.gyro.sensor_id);
    if (gyroUsable) {
      const diag = this.fusion.applyHeading({
        sensorId: obs.gyro.sensor_id,
        sensorType: SensorType.GYRO,
        headingDeg: obs.gyro.heading_deg,
        sigmaDeg: obs.gyro.quality?.heading_sigma_deg,
        withBias: true
      });
      this.faultDetector.recordResidual(obs.gyro.sensor_id, 'HEADING', diag);
    }
    if (obs.ins && this.insEnabled && !this.faultDetector.isExcluded(obs.ins.sensor_id)) {
      const diag = this.fusion.applyHeading({
        sensorId: obs.ins.sensor_id,
        sensorType: SensorType.INS,
        headingDeg: obs.ins.heading_deg,
        sigmaDeg: obs.ins.quality?.heading_sigma_deg,
        withBias: false,
        monitorOnly: gyroUsable
      });
      this.faultDetector.recordResidual(obs.ins.sensor_id, 'HEADING', diag);
    }
    if (
      radarResult?.valid &&
      radarResult.fresh &&
      Number.isFinite(radarResult.heading_deg) &&
      !this.faultDetector.isExcluded('RADAR_01')
    ) {
      this.fusion.applyHeading({
        sensorId: 'RADAR_01',
        sensorType: SensorType.RADAR,
        headingDeg: radarResult.heading_deg,
        // Radar heading precision degrades with match confidence.
        sigmaDeg: Math.max(1.2, 6 * (1 - (radarResult.confidence ?? 0))),
        // Radar map matching yields an *absolute* heading, independent of any
        // compass. It corrects the filter even when the gyro is healthy,
        // because without an absolute heading the heading and gyro-bias states
        // are only jointly observable: they can drift together indefinitely
        // while the gyro innovation stays near zero, and the track quietly
        // curves away. This is the only thing anchoring heading during a GNSS
        // outage.
        withBias: false
      });
    }

    // Velocity. The DVL is preferred; the speed log is the fallback and the
    // filter's speed-scale state absorbs its calibration error.
    let velocitySource = null;
    if (obs.dvl && obs.dvl.quality?.bottom_lock !== false && !this.faultDetector.isExcluded(obs.dvl.sensor_id)) {
      const diag = this.fusion.applyBodyVelocity({
        sensorId: obs.dvl.sensor_id,
        sensorType: SensorType.DVL,
        forwardMps: obs.dvl.raw?.forward_mps ?? 0,
        starboardMps: obs.dvl.raw?.starboard_mps ?? 0,
        sigmaMps: obs.dvl.quality?.velocity_sigma_mps
      });
      this.faultDetector.recordResidual(obs.dvl.sensor_id, 'VELOCITY', diag);
      if (diag.applied) velocitySource = obs.dvl.sensor_id;
      this.fusion.setVelocityNoiseScale(1);
    } else if (obs.speedLog && !this.faultDetector.isExcluded(obs.speedLog.sensor_id)) {
      const diag = this.fusion.applyBodyVelocity({
        sensorId: obs.speedLog.sensor_id,
        sensorType: SensorType.SPEED_LOG,
        forwardMps: obs.speedLog.raw?.forward_mps ?? 0,
        starboardMps: 0,
        sigmaMps: obs.speedLog.quality?.velocity_sigma_mps
      });
      this.faultDetector.recordResidual(obs.speedLog.sensor_id, 'VELOCITY', diag);
      if (diag.applied) velocitySource = obs.speedLog.sensor_id;
      // Without bottom lock the velocity is through water, not over ground:
      // inflate the process noise to account for the unmodelled tidal stream.
      this.fusion.setVelocityNoiseScale(6);
      if (obs.dvl && obs.dvl.quality?.bottom_lock === false) {
        this.raiseAlarm('DVL_BOTTOM_LOCK_LOST', obs.dvl.sensor_id, 'DVL has lost bottom lock', {
          reason: 'Water depth or seabed conditions prevent bottom tracking.',
          recommendedAction: 'Expect faster uncertainty growth. Obtain an absolute fix as soon as practicable.'
        });
      }
    } else {
      this.fusion.setVelocityNoiseScale(12);
    }
    if (obs.ins && this.insEnabled && !this.faultDetector.isExcluded(obs.ins.sensor_id) && obs.ins.velocity) {
      this.fusion.applyVelocityNE({
        sensorId: obs.ins.sensor_id,
        sensorType: SensorType.INS,
        velocityNorth: obs.ins.velocity.north_mps,
        velocityEast: obs.ins.velocity.east_mps,
        sigmaMps: obs.ins.quality?.velocity_sigma_mps
      });
    }

    // Absolute positions, best first.
    const absoluteSources = [];
    const applyAbsolute = (result, sensorId, sensorType, extra = {}) => {
      if (!result || !result.valid || !result.fresh || !Number.isFinite(result.east_m)) return;
      if (this.faultDetector.isExcluded(sensorId)) return;
      const aligned = this.alignToEpoch(result.east_m, result.north_m, result.covariance, result.sample_time_s, time);
      const diag = this.fusion.applyPosition({
        sensorId,
        sensorType,
        east: aligned.east,
        north: aligned.north,
        covariance: aligned.covariance,
        deweight: extra.deweight ?? 1,
        absolute: true,
        label: extra.label ?? null
      });
      diag.measurement_age_s = aligned.ageS;
      this.faultDetector.recordResidual(sensorId, 'POSITION', diag);
      if (diag.applied) {
        absoluteSources.push({
          sensor_id: sensorId,
          sensor_type: sensorType,
          sigma_m: result.sigma_m ?? null,
          confidence: result.confidence ?? null
        });
      }
    };

    applyAbsolute(localResult, 'LOCAL_01', SensorType.LOCAL_RANGING);
    applyAbsolute(lidarResult, 'LIDAR_01', SensorType.LIDAR);
    applyAbsolute(radarResult, 'RADAR_01', SensorType.RADAR, {
      // A low-confidence match is used but heavily de-weighted rather than
      // discarded: some information is better than none, as long as the
      // covariance tells the truth about how little there is.
      deweight: radarResult?.confidence ? Math.max(1, 1 / Math.max(0.05, radarResult.confidence)) : 1
    });
    if (bathyResult?.valid) {
      applyAbsolute(bathyResult, 'BATHY_01', SensorType.BATHYMETRIC_MATCH, {
        deweight: 1 + 3 * (bathyResult.ambiguity_score ?? 0)
      });
    } else if (bathyResult?.fresh && bathyResult.reason === 'AMBIGUOUS_MULTIPLE_CANDIDATES') {
      this.raiseAlarm('BATHYMETRIC_AMBIGUITY', 'BATHY_01', 'Bathymetric matching is ambiguous', {
        reason: `${bathyResult.mode_count} candidate positions are almost equally consistent with the seabed (ambiguity score ${bathyResult.ambiguity_score}).`,
        recommendedAction: 'Do not rely on the bathymetric fix. Seek radar, LiDAR or GNSS aiding.',
        detail: { top_candidates: bathyResult.top_candidates?.slice(0, 3) ?? [] }
      });
    }

    // GNSS last, and only if permitted.
    const gnssAllowed =
      obs.gnss &&
      obs.gnss.position &&
      !this.faultDetector.isExcluded(obs.gnss.sensor_id) &&
      ['USE_IN_FUSION', 'DEWEIGHT_IN_FUSION'].includes(gnssResult.recommended_action);
    let gnssUsed = false;
    if (gnssAllowed) {
      const local = this.env.frame.toLocal(obs.gnss.position.latitude, obs.gnss.position.longitude);
      const q = obs.gnss.quality || {};
      const cov = Array.isArray(q.position_covariance)
        ? [
            [q.position_covariance[0], q.position_covariance[1]],
            [q.position_covariance[2], q.position_covariance[3]]
          ]
        : null;
      const aligned = this.alignToEpoch(local.east, local.north, cov, this.sampleTimeOf(obs.gnss), time);
      const diag = this.fusion.applyPosition({
        sensorId: obs.gnss.sensor_id,
        sensorType: SensorType.GNSS,
        east: aligned.east,
        north: aligned.north,
        covariance: aligned.covariance,
        deweight: gnssResult.deweight_factor,
        absolute: true
      });
      diag.measurement_age_s = aligned.ageS;
      this.faultDetector.recordResidual(obs.gnss.sensor_id, 'POSITION', diag);
      gnssUsed = Boolean(diag.applied);
      if (gnssUsed) {
        absoluteSources.push({
          sensor_id: obs.gnss.sensor_id,
          sensor_type: SensorType.GNSS,
          sigma_m: cov ? Math.sqrt(cov[0][0]) : null,
          confidence: gnssResult.trust_score / 100
        });
        if (obs.gnss.velocity) {
          this.fusion.applyVelocityNE({
            sensorId: obs.gnss.sensor_id,
            sensorType: SensorType.GNSS,
            velocityNorth: obs.gnss.velocity.north_mps,
            velocityEast: obs.gnss.velocity.east_mps,
            deweight: gnssResult.deweight_factor
          });
        }
      }
    }

    // --- 7. Dead reckoning ----------------------------------------------------
    this.updateDeadReckoning({ absoluteSources, obs, time, velocitySource });

    // --- 8. Fault detection ---------------------------------------------------
    const protectedSensors = new Set();
    if (absoluteSources.length === 1) protectedSensors.add(absoluteSources[0].sensor_id);
    // The compass is protected in the same way as a sole absolute source.
    // Silently excluding the only heading reference leaves the filter unable to
    // rotate the DVL velocity into the local frame at all: the track then walks
    // off in a straight line while every panel still shows a position. Better
    // to keep it, inflate the protection level, and tell the operator.
    const headingReferences = ['GYRO_01', 'INS_01'].filter(
      (id) => !this.faultDetector.isExcluded(id) && (id !== 'INS_01' || this.insEnabled)
    );
    if (headingReferences.length === 1) protectedSensors.add(headingReferences[0]);
    // Hold exclusions of independent sources while GNSS is still contributing
    // but not fully trusted: their residuals are contaminated by it.
    const isolationHold = gnssUsed && gnssResult.trust_score < getConfig().gnss_integrity.acceptable_score_below;
    const findings = this.faultDetector.evaluate(time, protectedSensors, {
      isolationHold,
      isolationReason: isolationHold
        ? `GNSS trust score is ${gnssResult.trust_score} and it is still contributing to the solution`
        : null
    });
    for (const finding of findings) {
      if (finding.action === 'EXCLUDED') {
        this.raiseAlarm('SENSOR_EXCLUDED', finding.sensor_id, `${finding.sensor_id} excluded from the navigation solution`, {
          reason: finding.explanation,
          recommendedAction: 'Investigate the sensor. The system will attempt controlled reintegration automatically.'
        });
      } else if (finding.action === 'REINTEGRATED') {
        this.raiseAlarm('SENSOR_REINTEGRATED', finding.sensor_id, `${finding.sensor_id} returned to the navigation solution`, {
          reason: finding.explanation
        });
      } else if (finding.action === 'RETAINED_UNDER_PROTEST') {
        this.raiseAlarm('SENSOR_EXCLUDED', finding.sensor_id, `${finding.sensor_id} is faulty but cannot be excluded`, {
          severity: AlarmSeverity.WARNING,
          reason: finding.explanation,
          recommendedAction: 'Verify position by independent means.'
        });
      }
    }

    // Filter resets are published, never hidden: a reset means the previous
    // published solution was wrong and the operator must know.
    for (const reset of this.fusion.drainResets()) {
      this.raiseAlarm('SENSOR_REINTEGRATED', 'FUSION_ENGINE', 'Navigation filter reset onto an absolute source', {
        severity: AlarmSeverity.WARNING,
        reason: `${reset.reason} The solution moved ${reset.displacement_m} m.`,
        recommendedAction: 'Treat positions published in the preceding period as unreliable and verify independently.',
        detail: reset
      });
    }

    // --- 9. Integrity ---------------------------------------------------------
    const solution = this.fusion.solution();
    const solutionAgeS = solution.available && solution.last_absolute_update
      ? time - solution.last_absolute_update.time
      : null;
    const mapConfidence = Math.max(
      radarResult?.valid ? (radarResult.confidence ?? 0) : 0,
      lidarResult?.valid ? (lidarResult.confidence ?? 0) : 0,
      bathyResult?.valid ? (bathyResult.confidence ?? 0) : 0
    );
    const healthSnapshot = this.faultDetector.snapshot(time);
    const worstNormalized = healthSnapshot.reduce(
      (acc, s) => (Number.isFinite(s.normalized_residual_rms) ? Math.max(acc, s.normalized_residual_rms) : acc),
      0
    );
    const unresolvedCriticalFault = healthSnapshot.some(
      (s) => s.excluded && ['RADAR_01', 'LIDAR_01', 'BATHY_01', 'LOCAL_01'].includes(s.sensor_id)
    );

    // Absolute sources are counted over a short trailing window rather than
    // per epoch. Radar publishes at 2 Hz and the pipeline at 5 Hz, so a strict
    // per-epoch count would report "no redundancy" on three epochs out of five
    // even while two independent sources are perfectly healthy.
    for (const s of absoluteSources) this.recentAbsoluteSources.set(s.sensor_id, { ...s, time });
    const window = getConfig().requirements.absolute_source_window_s ?? 3.0;
    for (const [id, entry] of this.recentAbsoluteSources) {
      if (time - entry.time > window) this.recentAbsoluteSources.delete(id);
    }
    const windowedAbsoluteSources = [...this.recentAbsoluteSources.values()];

    // How far apart are the absolute sources that are *currently in the
    // solution*? A measurable gap between two sources that are both being used
    // is an observed bias, not a hypothetical one, and the protection level has
    // to carry it. This is what keeps the bound honest during a slow spoof,
    // before the trust engine has accumulated enough evidence to exclude GNSS.
    const disagreement = this.measureSourceDisagreement(obs, radarResult, lidarResult, localResult, gnssUsed);
    const absoluteSourceExcluded = findings.some(
      (f) => f.action === 'EXCLUDED' && ['GNSS_01', 'RADAR_01', 'LIDAR_01', 'LOCAL_01', 'BATHY_01'].includes(f.sensor_id)
    );
    const contaminationM = this.updateContamination(
      time,
      dt,
      disagreement.raw,
      absoluteSourceExcluded || this.gnssJustExcluded
    );
    this.gnssJustExcluded = false;
    const observedDisagreementM = Math.max(disagreement.excess, contaminationM);

    const integrity = this.integrityEngine.evaluate({
      positionCovariance: solution.available ? solution.position_covariance : null,
      time,
      solutionAgeS: solutionAgeS ?? 0,
      absoluteSources: windowedAbsoluteSources,
      observedDisagreementM,
      deadReckoning: this.deadReckoning.state(),
      activeSensors: this.activeSensorList(obs, absoluteSources, velocitySource),
      faultFindings: findings,
      solutionAvailable: solution.available,
      mapConfidence: mapConfidence > 0 ? mapConfidence : null,
      timeSyncValid: this.timeSyncValid,
      maxNormalizedResidual: worstNormalized,
      unresolvedCriticalFault
    });

    // --- 9b. Time integrity ---------------------------------------------------
    // Position is not the only thing GNSS provides, nor the only thing an
    // attacker can falsify. Once GNSS is rejected, UTC is in holdover.
    const timeIntegrity = this.timeIntegrity.evaluate({ time, gnssResult, gnssUsed });

    // --- 10. Mode state machine ----------------------------------------------
    const context = this.buildModeContext({
      gnssResult,
      gnssUsed,
      radarResult,
      lidarResult,
      bathyResult,
      localResult,
      obs,
      integrity,
      absoluteSources: windowedAbsoluteSources,
      solution
    });
    const modeOutcome = this.modeManager.evaluate(context, time);
    if (modeOutcome.changed) {
      const def = this.modeManager.definition;
      this.raiseAlarm('MODE_TRANSITION', 'MODE_MANAGER', `Navigation mode: ${def.label}`, {
        severity: def.operator_alarm || AlarmSeverity.INFO,
        reason: modeOutcome.transition.reason,
        recommendedAction: def.operator_guidance
      });
    }

    // --- 11. Requirement / integrity alarms ----------------------------------
    this.emitStatusAlarms(integrity, time);

    // --- 12. Build the trusted output ----------------------------------------
    const output = this.buildOutput({
      time,
      solution,
      integrity,
      timeIntegrity,
      gnssResult,
      gnssUsed,
      radarResult,
      lidarResult,
      bathyResult,
      localResult,
      absoluteSources: windowedAbsoluteSources,
      healthSnapshot,
      modeOutcome,
      obs,
      dt
    });
    this.lastOutput = output;
    return output;
  }

  /**
   * Seed the filter on the first epoch that offers both an absolute position
   * and a heading. Until both exist there is no navigation solution, and the
   * platform says so rather than publishing a position it cannot justify.
   *
   * @returns {object|null} the prior pose after initialization
   */
  ensureInitialized(obs, time) {
    if (this.fusion.initialized) return this.fusion.priorPose();

    const headingDeg = obs.gyro?.heading_deg ?? obs.ins?.heading_deg ?? null;
    if (headingDeg === null) return null;

    // Prefer a non-GNSS absolute source for the seed where one exists, so the
    // very first solution is not defined by the sensor under suspicion.
    let seed = null;
    if (obs.radar?.position && obs.radar.valid !== false) {
      seed = { source: obs.radar, sensorId: obs.radar.sensor_id, type: SensorType.RADAR };
    } else if (obs.lidar?.position && obs.lidar.valid !== false) {
      seed = { source: obs.lidar, sensorId: obs.lidar.sensor_id, type: SensorType.LIDAR };
    } else if (obs.localRanging?.position) {
      seed = { source: obs.localRanging, sensorId: obs.localRanging.sensor_id, type: SensorType.LOCAL_RANGING };
    } else if (obs.gnss?.position && obs.gnss.valid !== false) {
      seed = { source: obs.gnss, sensorId: obs.gnss.sensor_id, type: SensorType.GNSS };
    }
    if (!seed) return null;

    const local = this.env.frame.toLocal(seed.source.position.latitude, seed.source.position.longitude);
    const speed = obs.dvl?.raw?.forward_mps ?? obs.speedLog?.raw?.forward_mps ?? 0;
    const hr = (headingDeg * Math.PI) / 180;
    this.fusion.initialize({
      east: local.east,
      north: local.north,
      headingDeg,
      velocityNorth: speed * Math.cos(hr),
      velocityEast: speed * Math.sin(hr),
      time
    });
    this.deadReckoning.anchor(local.east, local.north, getConfig().fusion.initial_uncertainty.position_m, time, headingDeg);
    log.info('navigation solution initialized', {
      seed_sensor: seed.sensorId,
      heading_deg: Number(headingDeg.toFixed(2)),
      time_s: Number(time.toFixed(2))
    });
    this.raiseAlarm('MODE_TRANSITION', 'FUSION_ENGINE', 'Navigation solution initialized', {
      severity: AlarmSeverity.INFO,
      reason: `Seeded from ${seed.sensorId} with heading ${headingDeg.toFixed(1)} deg from ${obs.gyro ? obs.gyro.sensor_id : obs.ins.sensor_id}.`
    });
    return this.fusion.priorPose();
  }

  /** Pull the observations this epoch needs out of the accepted messages. */
  collectObservations(epochMessages, time) {
    const byType = (type) => {
      for (const m of epochMessages.values()) if (m.sensor_type === type) return m;
      return null;
    };
    const gyro = byType(SensorType.GYRO);
    const dvl = byType(SensorType.DVL);
    return {
      gnss: byType(SensorType.GNSS),
      gyro,
      dvl,
      speedLog: byType(SensorType.SPEED_LOG),
      radar: byType(SensorType.RADAR),
      lidar: byType(SensorType.LIDAR),
      echo: byType(SensorType.ECHO_SOUNDER),
      multibeam: byType(SensorType.MULTIBEAM),
      ins: byType(SensorType.INS),
      localRanging: byType(SensorType.LOCAL_RANGING),
      gyroHeadingDeg: gyro?.heading_deg ?? null,
      dvlForwardMps: dvl?.quality?.bottom_lock === false ? null : (dvl?.raw?.forward_mps ?? null),
      count: epochMessages.size,
      time
    };
  }

  /**
   * A localization result older than `maxAgeS` is no longer a valid fix.
   * Returning the stale result with `valid: false` keeps the reason visible in
   * the UI instead of silently dropping the engine from the display.
   */
  decayLocalization(previous, time, maxAgeS) {
    if (!previous) return null;
    const stamp = previous.time_s ?? (previous.timestamp_utc ? (new Date(previous.timestamp_utc).getTime() - this.epochMs) / 1000 : null);
    if (stamp === null) return previous;
    if (time - stamp > maxAgeS) {
      return {
        ...previous,
        valid: false,
        fresh: false,
        reason: 'STALE_NO_RECENT_FIX',
        stale: true,
        age_s: Number((time - stamp).toFixed(2))
      };
    }
    return { ...previous, fresh: false, age_s: Number((time - stamp).toFixed(2)) };
  }

  /**
   * Largest disagreement, in metres, between absolute position sources that are
   * both contributing to the solution right now.
   *
   * Only sources actually in the fusion are compared: a source that has already
   * been excluded is not evidence of a bias in the published position, and
   * counting it would inflate the bound for a fault the platform has already
   * dealt with.
   *
   * @returns {number} metres, or 0 when fewer than two sources are contributing
   */
  measureSourceDisagreement(obs, radarResult, lidarResult, localResult, gnssUsed) {
    const cfg = getConfig();
    const k = cfg.integrity.protection_level.disagreement_sigma_multiple ?? 2.0;
    const points = [];

    if (gnssUsed && obs.gnss?.position) {
      const local = this.env.frame.toLocal(obs.gnss.position.latitude, obs.gnss.position.longitude);
      const reported = obs.gnss.quality?.position_covariance;
      const sigma = Array.isArray(reported)
        ? Math.max(cfg.fusion.measurement_noise.GNSS.position_sigma_m, Math.sqrt(reported[0]))
        : cfg.fusion.measurement_noise.GNSS.position_sigma_m;
      points.push({ east: local.east, north: local.north, sigma });
    }
    const add = (result, id, floor) => {
      if (result?.valid && result.fresh && Number.isFinite(result.east_m) && !this.faultDetector.isExcluded(id)) {
        points.push({ east: result.east_m, north: result.north_m, sigma: Math.max(floor, result.sigma_m ?? floor) });
      }
    };
    add(radarResult, 'RADAR_01', cfg.fusion.measurement_noise.RADAR.position_sigma_m);
    add(lidarResult, 'LIDAR_01', cfg.fusion.measurement_noise.LIDAR.position_sigma_m);
    add(localResult, 'LOCAL_01', cfg.fusion.measurement_noise.LOCAL_RANGING.position_sigma_m);

    // Only the part of the gap that the two sources' own uncertainties cannot
    // explain counts as evidence of bias. Two honest sources with 1 m and 1.3 m
    // uncertainty will routinely sit 2 m apart; treating that as a bias would
    // inflate the bound permanently and make the requirement unachievable even
    // when everything is working.
    let worstExcess = 0;
    let worstRaw = 0;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const separation = Math.hypot(points[i].east - points[j].east, points[i].north - points[j].north);
        const expected = k * Math.hypot(points[i].sigma, points[j].sigma);
        worstExcess = Math.max(worstExcess, separation - expected);
        worstRaw = Math.max(worstRaw, separation);
      }
    }
    return { excess: Math.max(0, worstExcess), raw: worstRaw };
  }

  /**
   * Residual contamination left behind when a source that had been pulling the
   * solution is excluded.
   *
   * Excluding a spoofed source stops it doing further harm, but it does not
   * undo the harm already done: the filter has been walked off the true
   * position and needs several updates from the surviving sources to come back.
   * During that window the covariance is small - the filter is confident, and
   * wrong - so the protection level has to carry the size of the disagreement
   * that was observed at the moment of exclusion, decaying as the remaining
   * sources pull the solution back.
   *
   * @returns {number} metres of residual bias to include in the bound
   */
  updateContamination(time, dt, observedRawM, sourceJustExcluded) {
    const tau = getConfig().integrity.protection_level.contamination_decay_s ?? 8;
    if (dt > 0 && this.contaminationM > 0) {
      this.contaminationM *= Math.exp(-dt / tau);
      if (this.contaminationM < 0.05) this.contaminationM = 0;
    }
    if (sourceJustExcluded) {
      this.contaminationM = Math.max(this.contaminationM, this.lastObservedRawM ?? 0, observedRawM);
    }
    this.lastObservedRawM = observedRawM;
    return this.contaminationM;
  }

  /** Enforce the GNSS trust decision on the fault detector's exclusion set. */
  applyGnssDecision(gnssResult, time) {
    const excludeNow = ['EXCLUDE_FROM_FUSION', 'HOLD_FOR_VALIDATION'].includes(gnssResult.recommended_action);
    // The alarm follows the *trust engine's* own transition, not the fault
    // detector's exclusion flag. The residual monitor can exclude GNSS a
    // fraction of a second earlier on raw inconsistency; if the alarm were tied
    // to that flag, the operator would be told "GNSS excluded" and never told
    // that it was excluded because it was being spoofed.
    const previouslyExcluded = this.gnssExcludedByTrust === true;
    this.gnssExcludedByTrust = excludeNow;
    const alreadyExcluded = previouslyExcluded;

    if (excludeNow && !this.faultDetector.isExcluded('GNSS_01')) {
      this.faultDetector.forceExclude('GNSS_01', gnssResult.explanation, time);
      // Flag it for the integrity engine: the solution GNSS was influencing is
      // still contaminated until the remaining sources have re-anchored it.
      this.gnssJustExcluded = true;
    }

    // Before the receiver has ever produced a usable fix there is nothing to
    // report: "GNSS excluded" on the first epoch of every run, followed by
    // "GNSS reintegrated" on the second, is noise that trains operators to
    // ignore GNSS alarms.
    if (!this.gnssEngine.hasHadValidFix) return;

    if (excludeNow && !alreadyExcluded) {
      this.gnssExclusionAnnounced = true;
      if (gnssResult.spoofing_suspected) {
        this.raiseAlarm('GNSS_SPOOFING_DETECTED', 'GNSS_01', 'GNSS spoofing detected - GNSS excluded', {
          reason: gnssResult.explanation,
          recommendedAction:
            'Do not use GNSS on any bridge system until investigated. Navigation continues on independent sources. Report the event.',
          detail: { conditions: gnssResult.detected_conditions, trust_score: gnssResult.trust_score }
        });
      } else if (gnssResult.jamming_suspected) {
        this.raiseAlarm('GNSS_JAMMING_DETECTED', 'GNSS_01', 'GNSS interference detected - GNSS excluded', {
          reason: gnssResult.explanation,
          recommendedAction: 'Maintain visual and radar watch. Record the position and time for reporting.',
          detail: { conditions: gnssResult.detected_conditions, trust_score: gnssResult.trust_score }
        });
      } else if (gnssResult.recommended_action === 'HOLD_FOR_VALIDATION') {
        this.raiseAlarm('GNSS_RECOVERY_STARTED', 'GNSS_01', 'GNSS returned - validation in progress', {
          reason: `GNSS will be compared against the trusted solution for ${gnssResult.recovery?.required_s ?? 30} s before reintegration.`,
          recommendedAction: 'No action required.'
        });
      } else {
        this.raiseAlarm('GNSS_EXCLUDED', 'GNSS_01', 'GNSS excluded from the navigation solution', {
          reason: gnssResult.explanation
        });
      }
    } else if (!excludeNow && (alreadyExcluded || this.faultDetector.isExcluded('GNSS_01'))) {
      this.faultDetector.clearExclusion('GNSS_01');
      // Only announce a return if a departure was announced. Otherwise the
      // first epoch of every run reports a reintegration that never happened.
      if (!this.gnssExclusionAnnounced) return;
      this.gnssExclusionAnnounced = false;
      this.raiseAlarm('GNSS_REINTEGRATED', 'GNSS_01', 'GNSS reintegrated into the navigation solution', {
        reason: gnssResult.recovery?.complete
          ? `GNSS agreed with the trusted solution for ${gnssResult.recovery.elapsed_s} s (maximum difference ${gnssResult.recovery.max_difference_m} m).`
          : 'GNSS is consistent with all independent measurements.',
        recommendedAction: 'Monitor the GNSS integrity panel.'
      });
    }
  }

  /** Anchor or propagate the independent dead-reckoning solution. */
  updateDeadReckoning({ absoluteSources, obs, time, velocitySource }) {
    const solution = this.fusion.solution();
    if (!solution.available) return;
    const headingDeg = normalizeHeading(solution.heading_deg);
    const forward = obs.dvl?.quality?.bottom_lock === false
      ? (obs.speedLog?.raw?.forward_mps ?? null)
      : (obs.dvl?.raw?.forward_mps ?? obs.speedLog?.raw?.forward_mps ?? null);

    if (absoluteSources.length > 0) {
      // Re-anchor on the fused solution whenever an absolute fix is available.
      const ellipse = solution.ellipse;
      this.deadReckoning.anchor(solution.east_m, solution.north_m, ellipse.major, time, headingDeg);
    } else if (this.deadReckoning.initialized) {
      this.deadReckoning.propagate({
        time,
        headingDeg,
        forwardMps: forward,
        starboardMps: obs.dvl?.raw?.starboard_mps ?? 0,
        bottomLock: obs.dvl?.quality?.bottom_lock !== false,
        velocitySource
      });
    } else {
      this.deadReckoning.anchor(solution.east_m, solution.north_m, solution.ellipse.major, time, headingDeg);
    }
  }

  /** Sensors currently contributing, for the diversity calculation. */
  activeSensorList(obs, absoluteSources, velocitySource) {
    const list = [];
    const push = (message) => {
      if (message && !this.faultDetector.isExcluded(message.sensor_id)) {
        list.push({ sensor_id: message.sensor_id, sensor_type: message.sensor_type });
      }
    };
    push(obs.gyro);
    push(obs.echo);
    if (velocitySource) {
      const m = obs.dvl?.sensor_id === velocitySource ? obs.dvl : obs.speedLog;
      push(m);
    }
    if (this.insEnabled) push(obs.ins);
    for (const s of absoluteSources) list.push({ sensor_id: s.sensor_id, sensor_type: s.sensor_type });
    const seen = new Set();
    return list.filter((s) => (seen.has(s.sensor_id) ? false : seen.add(s.sensor_id)));
  }

  /** Flat context object consumed by the mode state machine. */
  buildModeContext({ gnssResult, gnssUsed, radarResult, lidarResult, bathyResult, localResult, obs, integrity, absoluteSources, solution }) {
    return {
      gnss_present: Boolean(obs.gnss),
      gnss_trust_score: gnssResult.trust_score,
      gnss_status: gnssResult.status,
      gnss_action: gnssResult.recommended_action,
      gnss_conditions: gnssResult.detected_conditions,
      gnss_used_in_fusion: gnssUsed,
      gnss_recovery_active: Boolean(gnssResult.recovery?.active),
      gnss_recovery_progress: gnssResult.recovery?.progress ?? 0,
      spoofing_suspected: gnssResult.spoofing_suspected,
      jamming_suspected: gnssResult.jamming_suspected,
      radar_valid: Boolean(radarResult?.valid),
      radar_confidence: radarResult?.confidence ?? 0,
      lidar_valid: Boolean(lidarResult?.valid),
      lidar_confidence: lidarResult?.confidence ?? 0,
      bathy_valid: Boolean(bathyResult?.valid),
      bathy_confidence: bathyResult?.confidence ?? 0,
      bathy_ambiguous: (bathyResult?.ambiguity_score ?? 1) >= 0.6,
      local_ranging_valid: Boolean(localResult?.valid),
      ins_enabled: this.insEnabled,
      ins_valid: Boolean(obs.ins) && this.insEnabled,
      dvl_valid: Boolean(obs.dvl) && obs.dvl.quality?.bottom_lock !== false,
      dvl_bottom_lock: obs.dvl?.quality?.bottom_lock !== false,
      gyro_valid: Boolean(obs.gyro),
      independent_absolute_sources: absoluteSources.length,
      absolute_fix_age_s: integrity.time_since_last_absolute_fix_s ?? 9999,
      dead_reckoning_duration_s: integrity.dead_reckoning_duration_s ?? 0,
      horizontal_protection_level_m: integrity.horizontal_protection_level_m ?? 9999,
      integrity_status: integrity.integrity_status,
      requirement_status: integrity.requirement_status,
      manual_fallback_requested: this.modeManager.manualFallback,
      solution_available: solution.available
    };
  }

  /** Raise alarms on requirement and integrity status transitions. */
  emitStatusAlarms(integrity, time) {
    // The filter needs a few seconds and a few absolute fixes to converge from
    // its initial uncertainty. Alarming on that transient would train operators
    // to ignore the very alarms that matter.
    const grace = getConfig().alarms.startup_grace_s ?? 5;
    if (time < grace) {
      this.previousRequirementStatus = integrity.requirement_status;
      this.previousIntegrityStatus = integrity.integrity_status;
      return;
    }

    if (integrity.requirement_status !== this.previousRequirementStatus) {
      const prev = this.previousRequirementStatus;
      this.previousRequirementStatus = integrity.requirement_status;
      if (prev !== null) {
        if (integrity.requirement_status === 'REQUIREMENT_NOT_MET') {
          this.raiseAlarm('REQUIREMENT_NOT_MET', 'INTEGRITY_ENGINE', 'Safeen 2 m requirement is NOT MET', {
            reason: integrity.requirement_reasons.join(' '),
            recommendedAction: 'Verify position using independent means. Consider suspending survey operations.'
          });
        } else if (integrity.requirement_status === 'REQUIREMENT_AT_RISK') {
          this.raiseAlarm('REQUIREMENT_AT_RISK', 'INTEGRITY_ENGINE', 'Safeen 2 m requirement is AT RISK', {
            reason: integrity.requirement_reasons.join(' '),
            recommendedAction: 'Prepare an independent position check. Monitor the protection level.'
          });
        } else if (integrity.requirement_status === 'INSUFFICIENT_INFORMATION') {
          this.raiseAlarm('INSUFFICIENT_INFORMATION', 'INTEGRITY_ENGINE', 'Insufficient information to assess the 2 m requirement', {
            reason: integrity.requirement_reasons.join(' '),
            recommendedAction: 'Do not rely on the displayed position until the required measurements are restored.'
          });
        }
      }
    }

    if (integrity.integrity_status !== this.previousIntegrityStatus) {
      const prev = this.previousIntegrityStatus;
      this.previousIntegrityStatus = integrity.integrity_status;
      if (prev !== null && integrity.integrity_status === 'NOT_ASSURED') {
        this.raiseAlarm('INTEGRITY_NOT_ASSURED', 'INTEGRITY_ENGINE', 'INTEGRITY NOT ASSURED', {
          reason: integrity.integrity_reasons.join(', '),
          recommendedAction: 'VERIFY POSITION USING INDEPENDENT MEANS.'
        });
      }
    }

    const limit = getConfig().requirements.horizontal_error_limit_m;
    if (
      Number.isFinite(integrity.horizontal_protection_level_m) &&
      integrity.horizontal_protection_level_m > limit &&
      (this.lastHplAlarmTime === undefined || time - this.lastHplAlarmTime > 60)
    ) {
      this.lastHplAlarmTime = time;
      this.raiseAlarm('PROTECTION_LEVEL_EXCEEDED', 'INTEGRITY_ENGINE', `Horizontal protection level ${integrity.horizontal_protection_level_m.toFixed(2)} m exceeds ${limit} m`, {
        reason: integrity.integrity_reasons.join(', ') || 'Position uncertainty has grown beyond the requirement.',
        recommendedAction: 'Verify position using independent means.'
      });
    }

    const drCfg = getConfig().dead_reckoning;
    const drState = this.deadReckoning.state();
    if (
      drState &&
      drState.duration_s > drCfg.maximum_unassisted_duration_s &&
      (this.lastDrAlarmTime === undefined || time - this.lastDrAlarmTime > 60)
    ) {
      this.lastDrAlarmTime = time;
      this.raiseAlarm('DEAD_RECKONING_LIMIT', 'DEAD_RECKONING', `Dead reckoning has exceeded ${drCfg.maximum_unassisted_duration_s} s without an absolute fix`, {
        reason: `Elapsed ${drState.duration_s.toFixed(0)} s. Dominant error source: ${drState.dominant_error_source}.`,
        recommendedAction: 'Obtain an absolute position fix or verify position by independent means.'
      });
    }
  }

  /** Assemble the trusted navigation output published to the UI and the log. */
  buildOutput({
    time,
    solution,
    integrity,
    timeIntegrity,
    gnssResult,
    gnssUsed,
    radarResult,
    lidarResult,
    bathyResult,
    localResult,
    absoluteSources,
    healthSnapshot,
    obs
  }) {
    const modeDescription = this.modeManager.describeCurrent(time);
    const contributing = this.fusion.contributingSensors();
    const excluded = healthSnapshot.filter((s) => s.excluded).map((s) => s.sensor_id);
    const drState = this.deadReckoning.state();

    // Accuracy against ground truth is available only in simulation and is
    // labelled unambiguously so it can never be confused with the estimate.
    let truthErrorM = null;
    let gnssTruthErrorM = null;
    if (this.groundTruth?.position && solution.available) {
      truthErrorM = haversineMetres(
        solution.latitude,
        solution.longitude,
        this.groundTruth.position.latitude,
        this.groundTruth.position.longitude
      );
      if (obs.gnss?.position) {
        gnssTruthErrorM = haversineMetres(
          obs.gnss.position.latitude,
          obs.gnss.position.longitude,
          this.groundTruth.position.latitude,
          this.groundTruth.position.longitude
        );
      }
    }

    return {
      time_s: Number(time.toFixed(3)),
      timestamp_utc: new Date(this.epochMs + time * 1000).toISOString(),
      // Whether that timestamp can be relied upon, and on what basis.
      time_integrity: timeIntegrity ?? null,
      trusted_position: solution.available
        ? {
            latitude: solution.latitude,
            longitude: solution.longitude,
            east_m: Number(solution.east_m.toFixed(3)),
            north_m: Number(solution.north_m.toFixed(3))
          }
        : null,
      velocity: solution.available
        ? {
            north_mps: Number(solution.velocity_north_mps.toFixed(4)),
            east_mps: Number(solution.velocity_east_mps.toFixed(4)),
            speed_mps: Number(solution.speed_mps.toFixed(4))
          }
        : null,
      course_deg: solution.available ? Number(solution.course_deg.toFixed(2)) : null,
      heading_deg: solution.available ? Number(solution.heading_deg.toFixed(2)) : null,
      gyro_bias_deg: solution.available ? Number(solution.gyro_bias_deg.toFixed(4)) : null,
      speed_scale_factor: solution.available ? Number(solution.speed_scale_factor.toFixed(5)) : null,
      solution_available: solution.available,
      solution_confidence: this.fusion.solutionConfidence(integrity.time_since_last_absolute_fix_s),
      navigation_mode: modeDescription.mode,
      navigation_mode_detail: modeDescription,
      integrity,
      gnss: {
        trust_score: gnssResult.trust_score,
        status: gnssResult.status,
        recommended_action: gnssResult.recommended_action,
        detected_conditions: gnssResult.detected_conditions,
        pending_conditions: gnssResult.pending_conditions,
        spoofing_suspected: gnssResult.spoofing_suspected,
        jamming_suspected: gnssResult.jamming_suspected,
        used_in_fusion: gnssUsed,
        explanation: gnssResult.explanation,
        recovery: gnssResult.recovery,
        diagnostics: gnssResult.diagnostics,
        quality: gnssResult.quality,
        reported_position: obs.gnss?.position ?? null,
        error_vs_truth_m: gnssTruthErrorM === null ? null : Number(gnssTruthErrorM.toFixed(3))
      },
      localization: {
        radar: summariseLocalization(radarResult),
        lidar: summariseLocalization(lidarResult),
        bathymetric: summariseBathymetric(bathyResult),
        local_ranging: summariseLocalization(localResult),
        dead_reckoning: drState
      },
      contributing_sensors: contributing,
      excluded_sensors: excluded,
      absolute_sources: absoluteSources,
      sensor_health: healthSnapshot,
      ais_contacts: this.aisContacts,
      ground_truth: this.groundTruth
        ? {
            latitude: this.groundTruth.position.latitude,
            longitude: this.groundTruth.position.longitude,
            heading_deg: this.groundTruth.heading_deg,
            speed_mps: Math.hypot(
              this.groundTruth.velocity?.north_mps ?? 0,
              this.groundTruth.velocity?.east_mps ?? 0
            ),
            depth_m: this.groundTruth.depth_m,
            zone: this.groundTruth.raw?.zone ?? null
          }
        : null,
      // ACTUAL error measured against simulated ground truth. Distinct from the
      // estimated error and from the protection level (Section 26).
      actual_error_vs_truth_m: truthErrorM === null ? null : Number(truthErrorM.toFixed(4)),
      fusion_debug: {
        residuals: this.fusion.residualLog,
        velocity_noise_scale: this.fusion.velocityNoiseScale,
        update_count: this.fusion.updateCount
      }
    };
  }
}

function summariseLocalization(result) {
  if (!result) return { available: false, valid: false };
  return {
    available: true,
    valid: Boolean(result.valid),
    reason: result.reason ?? null,
    latitude: result.latitude ?? null,
    longitude: result.longitude ?? null,
    east_m: result.east_m ?? null,
    north_m: result.north_m ?? null,
    heading_deg: result.heading_deg ?? null,
    sigma_m: result.sigma_m === null || result.sigma_m === undefined ? null : Number(result.sigma_m.toFixed(4)),
    confidence: result.confidence ?? 0,
    match_score: result.match_score ?? null,
    residual_m: result.residual_m ?? null,
    inliers: result.inliers ?? null,
    matched_features: result.matched_features ?? null,
    selected_mode: result.selected_mode ?? null,
    selection_reason: result.selection_reason ?? null,
    stale: Boolean(result.stale),
    method: result.method ?? null,
    beacon_count: result.beacon_count ?? null,
    gdop: result.gdop ?? null
  };
}

function summariseBathymetric(result) {
  if (!result) return { available: false, valid: false };
  return {
    available: true,
    valid: Boolean(result.valid),
    reason: result.reason,
    latitude: result.latitude,
    longitude: result.longitude,
    east_m: result.east_m,
    north_m: result.north_m,
    sigma_m: result.sigma_m,
    confidence: result.confidence,
    ambiguity_score: result.ambiguity_score,
    terrain_observability: result.terrain_observability,
    candidate_count: result.candidate_count,
    mode_count: result.mode_count,
    residual_rms_m: result.residual_rms_m,
    depth_bias_m: result.depth_bias_m,
    sequence_length: result.sequence_length,
    top_candidates: result.top_candidates
  };
}

export default NavigationPipeline;
