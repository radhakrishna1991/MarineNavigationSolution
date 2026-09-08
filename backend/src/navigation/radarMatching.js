/**
 * Radar and LiDAR map-matching engines (Sections 10.1 and 10.2).
 *
 * Two modes, exactly as the specification requires:
 *
 *   Mode A - Simulated / vendor radar fix.
 *            The adapter supplies a position, covariance, match score and
 *            feature count. The engine validates and normalises it.
 *
 *   Mode B - Simplified point-cloud map matching.
 *            The engine runs its own trimmed ICP against the stored reference
 *            cloud, starting from the filter's predicted pose, and reports its
 *            own independent fix.
 *
 * When both are available the engine reports both and selects Mode B if it
 * converged with acceptable residuals, because a fix the platform computed
 * itself is auditable end to end. The selection and the reason are published.
 */

import { SpatialIndex, icpMatch } from './pointCloudMatch.js';
import { LocalizationEngine } from '../models/enums.js';
import { normalizeHeading } from '../utils/geo.js';

/** Shared implementation; radar and LiDAR differ only in tuning and map. */
export class PointCloudLocalizationEngine {
  /**
   * @param {object} options
   * @param {object} options.environment
   * @param {Array} options.referencePoints reference map in local ENU metres
   * @param {string} options.engineId
   * @param {object} options.tuning
   */
  constructor({ environment, referencePoints, engineId, tuning = {} }) {
    this.env = environment;
    this.engineId = engineId;
    this.index = new SpatialIndex(referencePoints, tuning.cellSize ?? 60);
    this.tuning = {
      maxCorrespondenceM: 45,
      minInliers: 8,
      minConfidence: 0.05,
      maxAcceptableResidualM: 12,
      ...tuning
    };
    this.lastResult = null;
  }

  /**
   * Process one localization message.
   *
   * @param {object} message normalized sensor message
   * @param {object} prior { east, north, headingRad } predicted pose from the filter
   * @returns {object} localization result
   */
  process(message, prior) {
    const modeA = this.parseModeA(message);
    const modeB = this.runModeB(message, prior);

    let selected = 'MODE_A';
    let reason = 'Vendor-supplied fix used; no usable point cloud for independent matching.';

    if (modeB && modeB.valid) {
      if (!modeA || !modeA.valid) {
        selected = 'MODE_B';
        reason = 'Independent scan matching used; no valid vendor fix available.';
      } else if (modeB.rmsResidualM !== null && modeB.rmsResidualM <= this.tuning.maxAcceptableResidualM) {
        selected = 'MODE_B';
        reason = 'Independent scan matching converged with acceptable residuals.';
      } else {
        reason = 'Independent scan matching residuals too large; vendor fix retained.';
      }
    } else if (modeB && !modeB.valid) {
      reason = `Independent scan matching unavailable (${modeB.reason}); vendor fix retained.`;
    }

    const chosen = selected === 'MODE_B' ? modeB : modeA;
    const result = {
      engine: this.engineId,
      sensor_id: message.sensor_id,
      sensor_type: message.sensor_type,
      timestamp_utc: message.timestamp_utc,
      selected_mode: selected,
      selection_reason: reason,
      valid: Boolean(chosen && chosen.valid),
      mode_a: modeA,
      mode_b: modeB,
      ...(chosen && chosen.valid
        ? {
            east_m: chosen.east_m,
            north_m: chosen.north_m,
            latitude: chosen.latitude,
            longitude: chosen.longitude,
            heading_deg: chosen.heading_deg,
            covariance: chosen.covariance,
            sigma_m: chosen.sigma_m,
            confidence: chosen.confidence,
            match_score: chosen.match_score,
            residual_m: chosen.residual_m,
            inliers: chosen.inliers,
            matched_features: chosen.matched_features
          }
        : {
            east_m: null,
            north_m: null,
            latitude: null,
            longitude: null,
            heading_deg: null,
            covariance: null,
            sigma_m: null,
            confidence: 0,
            match_score: 0,
            residual_m: null,
            inliers: 0,
            matched_features: 0
          })
    };

    this.lastResult = result;
    return result;
  }

  /** Mode A: validate and normalise a vendor-supplied fix. */
  parseModeA(message) {
    if (!message.position || message.valid === false) {
      return { mode: 'MODE_A', valid: false, reason: 'NO_POSITION_IN_MESSAGE' };
    }
    const q = message.quality || {};
    const local = this.env.frame.toLocal(message.position.latitude, message.position.longitude);
    const cov = Array.isArray(q.position_covariance)
      ? [
          [q.position_covariance[0], q.position_covariance[1]],
          [q.position_covariance[2], q.position_covariance[3]]
        ]
      : null;
    const sigma = cov ? Math.sqrt(Math.max(cov[0][0], cov[1][1])) : (q.residual_m ?? 3.0);
    const confidence = q.confidence ?? q.match_score ?? 0;

    return {
      mode: 'MODE_A',
      valid: confidence >= this.tuning.minConfidence,
      reason: confidence >= this.tuning.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_THRESHOLD',
      east_m: local.east,
      north_m: local.north,
      latitude: message.position.latitude,
      longitude: message.position.longitude,
      heading_deg: message.heading_deg ?? null,
      covariance: cov ?? [
        [sigma * sigma, 0],
        [0, sigma * sigma]
      ],
      sigma_m: sigma,
      confidence,
      match_score: q.match_score ?? confidence,
      residual_m: q.residual_m ?? null,
      inliers: q.inliers ?? null,
      matched_features: q.matched_features ?? null,
      map_age_days: q.map_age_days ?? null
    };
  }

  /** Mode B: independent scan matching against the stored reference map. */
  runModeB(message, prior) {
    const scan = message.raw?.point_cloud;
    if (!Array.isArray(scan) || scan.length === 0) {
      return { mode: 'MODE_B', valid: false, reason: 'NO_POINT_CLOUD' };
    }
    if (!prior || !Number.isFinite(prior.east) || !Number.isFinite(prior.north)) {
      return { mode: 'MODE_B', valid: false, reason: 'NO_PRIOR_POSE' };
    }

    const result = icpMatch({
      scan,
      index: this.index,
      initialPose: { east: prior.east, north: prior.north, headingRad: prior.headingRad ?? 0 },
      options: {
        maxCorrespondenceM: this.tuning.maxCorrespondenceM,
        minInliers: this.tuning.minInliers
      }
    });

    if (!result.converged || result.inliers < this.tuning.minInliers) {
      return { mode: 'MODE_B', valid: false, reason: result.reason, detail: result };
    }

    const geo = this.env.frame.toGeodetic(result.pose.east, result.pose.north);
    return {
      mode: 'MODE_B',
      valid: result.confidence >= this.tuning.minConfidence,
      reason: result.confidence >= this.tuning.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_THRESHOLD',
      east_m: result.pose.east,
      north_m: result.pose.north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      heading_deg: normalizeHeading((result.pose.headingRad * 180) / Math.PI),
      covariance: result.covariance,
      sigma_m: result.sigmaM,
      confidence: result.confidence,
      match_score: result.inlierRatio,
      residual_m: result.rmsResidualM,
      inliers: result.inliers,
      matched_features: result.scanPoints,
      iterations: result.iterations
    };
  }
}

/** Radar engine with radar-appropriate tuning. */
export function createRadarEngine(environment) {
  return new PointCloudLocalizationEngine({
    environment,
    referencePoints: environment.radarPoints,
    engineId: LocalizationEngine.RADAR_MAP_MATCHING,
    tuning: { cellSize: 80, maxCorrespondenceM: 60, minInliers: 8, maxAcceptableResidualM: 15, minConfidence: 0.05 }
  });
}

/** LiDAR engine: shorter range, tighter correspondences, more inliers needed. */
export function createLidarEngine(environment) {
  return new PointCloudLocalizationEngine({
    environment,
    referencePoints: environment.lidarPoints,
    engineId: LocalizationEngine.LIDAR_MAP_MATCHING,
    tuning: { cellSize: 25, maxCorrespondenceM: 15, minInliers: 15, maxAcceptableResidualM: 4, minConfidence: 0.1 }
  });
}

export default PointCloudLocalizationEngine;
