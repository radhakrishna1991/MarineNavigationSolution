/**
 * Canonical vocabulary for the platform.
 *
 * Section 13 of the specification is explicit that accuracy, precision,
 * confidence, integrity, availability and continuity are distinct concepts.
 * Keeping every state name in one place makes it impossible for a UI component
 * to invent a synonym.
 */

/** Navigation mode state machine (Section 5). */
export const NavigationMode = Object.freeze({
  NORMAL_GNSS: 'NORMAL_GNSS',
  GNSS_DEGRADED: 'GNSS_DEGRADED',
  SPOOFING_SUSPECTED: 'SPOOFING_SUSPECTED',
  JAMMING_SUSPECTED: 'JAMMING_SUSPECTED',
  GNSS_REJECTED: 'GNSS_REJECTED',
  RADAR_AIDED_NAVIGATION: 'RADAR_AIDED_NAVIGATION',
  BATHYMETRIC_AIDED_NAVIGATION: 'BATHYMETRIC_AIDED_NAVIGATION',
  LIDAR_AIDED_NAVIGATION: 'LIDAR_AIDED_NAVIGATION',
  DEAD_RECKONING: 'DEAD_RECKONING',
  INS_AIDED_NAVIGATION: 'INS_AIDED_NAVIGATION',
  LOCAL_POSITIONING_MODE: 'LOCAL_POSITIONING_MODE',
  MANUAL_FALLBACK: 'MANUAL_FALLBACK',
  GNSS_RECOVERY_VALIDATION: 'GNSS_RECOVERY_VALIDATION',
  INTEGRITY_NOT_ASSURED: 'INTEGRITY_NOT_ASSURED'
});

/** Integrity state of the navigation solution (Section 13). */
export const IntegrityStatus = Object.freeze({
  ASSURED: 'ASSURED',
  DEGRADED: 'DEGRADED',
  NOT_ASSURED: 'NOT_ASSURED',
  UNKNOWN: 'UNKNOWN'
});

/** Safeen <2 m requirement compliance status (Section 6). */
export const RequirementStatus = Object.freeze({
  REQUIREMENT_MET: 'REQUIREMENT_MET',
  REQUIREMENT_AT_RISK: 'REQUIREMENT_AT_RISK',
  REQUIREMENT_NOT_MET: 'REQUIREMENT_NOT_MET',
  INSUFFICIENT_INFORMATION: 'INSUFFICIENT_INFORMATION'
});

/** GNSS trust bands (Section 9). */
export const GnssTrustStatus = Object.freeze({
  REJECTED: 'REJECTED',
  HIGHLY_SUSPECT: 'HIGHLY_SUSPECT',
  DEGRADED: 'DEGRADED',
  ACCEPTABLE: 'ACCEPTABLE',
  TRUSTED: 'TRUSTED'
});

/** Recommended action returned by the GNSS trust engine. */
export const GnssAction = Object.freeze({
  USE_IN_FUSION: 'USE_IN_FUSION',
  DEWEIGHT_IN_FUSION: 'DEWEIGHT_IN_FUSION',
  EXCLUDE_FROM_FUSION: 'EXCLUDE_FROM_FUSION',
  HOLD_FOR_VALIDATION: 'HOLD_FOR_VALIDATION'
});

/** Sensor types supported by the internal message model (Section 7). */
export const SensorType = Object.freeze({
  GNSS: 'GNSS',
  GYRO: 'GYRO',
  DVL: 'DVL',
  SPEED_LOG: 'SPEED_LOG',
  RADAR: 'RADAR',
  LIDAR: 'LIDAR',
  ECHO_SOUNDER: 'ECHO_SOUNDER',
  MULTIBEAM: 'MULTIBEAM',
  BATHYMETRIC_MATCH: 'BATHYMETRIC_MATCH',
  INS: 'INS',
  LOCAL_RANGING: 'LOCAL_RANGING',
  AIS: 'AIS',
  GROUND_TRUTH: 'GROUND_TRUTH'
});

/** Sensor acceptance decision recorded per measurement. */
export const SensorDecision = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  DEWEIGHTED: 'DEWEIGHTED',
  REJECTED: 'REJECTED',
  EXCLUDED: 'EXCLUDED',
  NOT_USED: 'NOT_USED',
  ADVISORY_ONLY: 'ADVISORY_ONLY'
});

/** Fault categories (Section 12). */
export const FaultCategory = Object.freeze({
  STALE_DATA: 'STALE_DATA',
  MISSING_DATA: 'MISSING_DATA',
  EXCESSIVE_NOISE: 'EXCESSIVE_NOISE',
  BIAS: 'BIAS',
  FROZEN_VALUE: 'FROZEN_VALUE',
  SCALE_ERROR: 'SCALE_ERROR',
  TIMESTAMP_ERROR: 'TIMESTAMP_ERROR',
  IMPOSSIBLE_RATE: 'IMPOSSIBLE_RATE',
  INDEPENDENT_DISAGREEMENT: 'INDEPENDENT_DISAGREEMENT',
  MAP_MISMATCH: 'MAP_MISMATCH',
  LOSS_OF_BOTTOM_LOCK: 'LOSS_OF_BOTTOM_LOCK',
  INVALID_QUALITY_FLAGS: 'INVALID_QUALITY_FLAGS',
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  AMBIGUOUS_SOLUTION: 'AMBIGUOUS_SOLUTION'
});

/** GNSS anomaly conditions (Section 9). */
export const GnssCondition = Object.freeze({
  EXCESSIVE_POSITION_JUMP: 'EXCESSIVE_POSITION_JUMP',
  GRADUAL_POSITION_DRAG: 'GRADUAL_POSITION_DRAG',
  IMPROBABLE_ACCELERATION: 'IMPROBABLE_ACCELERATION',
  IMPOSSIBLE_VESSEL_SPEED: 'IMPOSSIBLE_VESSEL_SPEED',
  IMPOSSIBLE_TURN_RATE: 'IMPOSSIBLE_TURN_RATE',
  OUTSIDE_ALLOWED_WATER_POLYGON: 'OUTSIDE_ALLOWED_WATER_POLYGON',
  POSITION_CROSSING_LAND: 'POSITION_CROSSING_LAND',
  RADAR_POSITION_DISAGREEMENT: 'RADAR_POSITION_DISAGREEMENT',
  LIDAR_POSITION_DISAGREEMENT: 'LIDAR_POSITION_DISAGREEMENT',
  BATHYMETRIC_POSITION_DISAGREEMENT: 'BATHYMETRIC_POSITION_DISAGREEMENT',
  DEAD_RECKONING_DISAGREEMENT: 'DEAD_RECKONING_DISAGREEMENT',
  VELOCITY_DISAGREEMENT: 'VELOCITY_DISAGREEMENT',
  HEADING_DISAGREEMENT: 'HEADING_DISAGREEMENT',
  GNSS_TIME_JUMP: 'GNSS_TIME_JUMP',
  STALE_GNSS_TIMESTAMP: 'STALE_GNSS_TIMESTAMP',
  FROZEN_COORDINATES: 'FROZEN_COORDINATES',
  DEGRADED_SIGNAL_METRICS: 'DEGRADED_SIGNAL_METRICS',
  SUDDEN_MULTI_SATELLITE_SNR_DROP: 'SUDDEN_MULTI_SATELLITE_SNR_DROP',
  LOW_SATELLITE_COUNT: 'LOW_SATELLITE_COUNT',
  HIGH_DILUTION_OF_PRECISION: 'HIGH_DILUTION_OF_PRECISION',
  NO_FIX: 'NO_FIX',
  SIGNAL_LOST: 'SIGNAL_LOST',
  CLOCK_BIAS_ANOMALY: 'CLOCK_BIAS_ANOMALY',
  REPORTED_ACCURACY_IMPLAUSIBLE: 'REPORTED_ACCURACY_IMPLAUSIBLE'
});

/** Alarm severity ladder (Section 15.5). */
export const AlarmSeverity = Object.freeze({
  INFO: 'INFO',
  ADVISORY: 'ADVISORY',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL'
});

export const ALARM_SEVERITY_ORDER = ['INFO', 'ADVISORY', 'WARNING', 'CRITICAL'];

/** Role-based access control roles (Section 22). */
export const Role = Object.freeze({
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  ENGINEER: 'engineer',
  ADMINISTRATOR: 'administrator'
});

/** Ordered from least to most privileged; used by the RBAC middleware. */
export const ROLE_ORDER = ['viewer', 'operator', 'engineer', 'administrator'];

/** Scenario runtime states. */
export const ScenarioState = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED'
});

/** Localization engine identifiers. */
export const LocalizationEngine = Object.freeze({
  RADAR_MAP_MATCHING: 'RADAR_MAP_MATCHING',
  LIDAR_MAP_MATCHING: 'LIDAR_MAP_MATCHING',
  BATHYMETRIC_TERRAIN_MATCHING: 'BATHYMETRIC_TERRAIN_MATCHING',
  DEAD_RECKONING: 'DEAD_RECKONING',
  INS_AIDING: 'INS_AIDING',
  LOCAL_POSITIONING: 'LOCAL_POSITIONING',
  GNSS: 'GNSS'
});

/**
 * Sensor types that provide an *independent absolute* position fix.
 * Section 6 forbids a green requirement status without at least one of these.
 */
export const ABSOLUTE_POSITION_SOURCES = Object.freeze([
  SensorType.RADAR,
  SensorType.LIDAR,
  SensorType.BATHYMETRIC_MATCH,
  SensorType.LOCAL_RANGING,
  SensorType.GNSS
]);

/** Sensor types that are advisory only and never enter the fusion filter. */
export const ADVISORY_ONLY_SOURCES = Object.freeze([SensorType.AIS]);

/** Map a numeric trust score to its band. */
export function trustScoreToStatus(score) {
  if (!Number.isFinite(score)) return GnssTrustStatus.REJECTED;
  if (score <= 20) return GnssTrustStatus.REJECTED;
  if (score <= 50) return GnssTrustStatus.HIGHLY_SUSPECT;
  if (score <= 75) return GnssTrustStatus.DEGRADED;
  if (score <= 90) return GnssTrustStatus.ACCEPTABLE;
  return GnssTrustStatus.TRUSTED;
}
