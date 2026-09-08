/**
 * The standardized internal sensor message (Section 7).
 *
 * Every adapter - simulated or real - must emit this shape. External data is
 * validated against the schema before it can reach the navigation pipeline
 * (Section 22 "input validation / schema validation").
 */

import { z } from 'zod';
import { SensorType } from './enums.js';

const finiteNumber = z.number().finite();

export const PositionSchema = z
  .object({
    latitude: finiteNumber.min(-90).max(90),
    longitude: finiteNumber.min(-180).max(180),
    altitude_m: finiteNumber.min(-12000).max(12000).optional().default(0)
  })
  .strict();

export const VelocitySchema = z
  .object({
    north_mps: finiteNumber.min(-60).max(60),
    east_mps: finiteNumber.min(-60).max(60),
    down_mps: finiteNumber.min(-30).max(30).optional().default(0)
  })
  .strict();

/**
 * Quality block. Contents differ per sensor type, so the schema is permissive
 * about which keys appear but strict about their types.
 */
export const QualitySchema = z
  .object({
    // GNSS
    satellites: z.number().int().min(0).max(64).optional(),
    hdop: finiteNumber.min(0).max(99).optional(),
    vdop: finiteNumber.min(0).max(99).optional(),
    pdop: finiteNumber.min(0).max(99).optional(),
    cn0_mean_dbhz: finiteNumber.min(0).max(70).optional(),
    cn0_min_dbhz: finiteNumber.min(0).max(70).optional(),
    fix_type: z.string().max(32).optional(),
    reported_accuracy_m: finiteNumber.min(0).max(10000).optional(),
    clock_bias_ns: finiteNumber.optional(),
    // Map-matching engines
    match_score: finiteNumber.min(0).max(1).optional(),
    matched_features: z.number().int().min(0).optional(),
    inliers: z.number().int().min(0).optional(),
    residual_m: finiteNumber.min(0).optional(),
    map_age_days: finiteNumber.min(0).optional(),
    confidence: finiteNumber.min(0).max(1).optional(),
    ambiguity_score: finiteNumber.min(0).max(1).optional(),
    terrain_observability: finiteNumber.min(0).max(1).optional(),
    candidate_count: z.number().int().min(0).optional(),
    feature_score: finiteNumber.min(0).max(1).optional(),
    // Covariance of the horizontal position fix, ENU metres^2, row major 2x2
    position_covariance: z.array(finiteNumber).length(4).optional(),
    // Velocity sensors
    bottom_lock: z.boolean().optional(),
    beam_count: z.number().int().min(0).optional(),
    velocity_sigma_mps: finiteNumber.min(0).optional(),
    // Heading sensors
    heading_sigma_deg: finiteNumber.min(0).optional(),
    // Depth sensors
    depth_sigma_m: finiteNumber.min(0).optional(),
    sound_velocity_mps: finiteNumber.min(1300).max(1700).optional(),
    // INS
    ins_aided: z.boolean().optional(),
    time_since_aiding_s: finiteNumber.min(0).optional(),
    // Local ranging
    beacon_count: z.number().int().min(0).optional(),
    gdop: finiteNumber.min(0).optional(),
    technology: z.string().max(32).optional(),
    // Generic
    status: z.string().max(64).optional(),
    latency_ms: finiteNumber.min(0).optional()
  })
  .passthrough();

export const SensorMessageSchema = z
  .object({
    sensor_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-.:]+$/, 'sensor_id must be alphanumeric'),
    sensor_type: z.nativeEnum(SensorType),
    timestamp_utc: z.string().datetime({ offset: true }),
    sequence_number: z.number().int().min(0),
    position: PositionSchema.nullable().optional(),
    velocity: VelocitySchema.nullable().optional(),
    heading_deg: finiteNumber.min(-360).max(360).nullable().optional(),
    depth_m: finiteNumber.min(-100).max(12000).nullable().optional(),
    quality: QualitySchema.optional().default({}),
    raw: z.record(z.any()).optional().default({}),
    valid: z.boolean().optional().default(true)
  })
  .strict();

/** Batch upload envelope for `POST /api/data/upload` and UDP ingestion. */
export const SensorMessageBatchSchema = z.object({
  messages: z.array(SensorMessageSchema).min(1).max(5000)
});

/**
 * Build a well-formed sensor message, filling defaults.
 * Simulated adapters use this so the emitted shape can never drift from the
 * schema the ingestion layer enforces.
 */
export function buildSensorMessage({
  sensorId,
  sensorType,
  timestampUtc,
  sequenceNumber,
  position = null,
  velocity = null,
  headingDeg = null,
  depthM = null,
  quality = {},
  raw = {},
  valid = true
}) {
  return {
    sensor_id: sensorId,
    sensor_type: sensorType,
    timestamp_utc: timestampUtc,
    sequence_number: sequenceNumber,
    position: position
      ? {
          latitude: position.latitude,
          longitude: position.longitude,
          altitude_m: position.altitude_m ?? 0
        }
      : null,
    velocity: velocity
      ? {
          north_mps: velocity.north_mps,
          east_mps: velocity.east_mps,
          down_mps: velocity.down_mps ?? 0
        }
      : null,
    heading_deg: headingDeg,
    depth_m: depthM,
    quality,
    raw,
    valid
  };
}

/**
 * Validate an untrusted message.
 * @returns {{ ok: true, message: object } | { ok: false, errors: string[] }}
 */
export function validateSensorMessage(input) {
  const result = SensorMessageSchema.safeParse(input);
  if (result.success) return { ok: true, message: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  };
}
