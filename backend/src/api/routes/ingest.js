/**
 * Sensor ingestion endpoints (Section 8).
 *
 * Separated from the rest of the API surface both logically and by rate limit,
 * in line with the "separation between sensor ingestion and UI access"
 * requirement. Every message is schema-validated before it can reach the
 * navigation pipeline; nothing is trusted because of where it came from.
 */

import { Router } from 'express';
import { z } from 'zod';
import { SensorMessageBatchSchema, validateSensorMessage } from '../../models/sensorMessage.js';
import { parseNmeaChunk, ADAPTERS } from '../../adapters/index.js';
import { getConfig } from '../../config/index.js';
import { Role } from '../../models/enums.js';
import { asyncHandler, requireAuth, requireRole, validate, ingestLimiter, audit } from '../../middleware/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ingest');

const router = Router();

/**
 * Handler injected at wiring time so this module stays free of engine imports.
 * @type {null | ((message: object, meta: object) => { ok: boolean, errors?: string[] })}
 */
let ingestHandler = null;

export function setIngestHandler(fn) {
  ingestHandler = fn;
}

/** Live counters exposed through /api/data/status. */
const stats = {
  rest_messages_received: 0,
  rest_messages_accepted: 0,
  rest_messages_rejected: 0,
  nmea_sentences_received: 0,
  nmea_sentences_accepted: 0,
  last_error: null,
  last_accepted_at: null
};

router.post(
  '/data/ingest',
  requireAuth,
  requireRole(Role.ENGINEER),
  ingestLimiter,
  validate(SensorMessageBatchSchema),
  asyncHandler(async (req, res) => {
    if (!ingestHandler) {
      return res.status(503).json({
        error: 'INGESTION_UNAVAILABLE',
        message: 'No navigation pipeline is running. Start a scenario or a replay first.'
      });
    }
    const results = [];
    let accepted = 0;
    for (const message of req.body.messages) {
      stats.rest_messages_received += 1;
      const result = ingestHandler(message, { via: 'rest', user: req.user.username });
      if (result?.ok) {
        accepted += 1;
        stats.rest_messages_accepted += 1;
        stats.last_accepted_at = new Date().toISOString();
      } else {
        stats.rest_messages_rejected += 1;
        stats.last_error = { at: new Date().toISOString(), errors: result?.errors ?? ['unknown'] };
        results.push({ sensor_id: message.sensor_id, errors: result?.errors ?? ['Rejected.'] });
      }
    }
    res.status(accepted > 0 ? 202 : 400).json({
      accepted,
      rejected: req.body.messages.length - accepted,
      errors: results.slice(0, 20)
    });
  })
);

const NmeaSchema = z.object({
  sentences: z.string().min(1).max(1024 * 1024),
  sensorIdPrefix: z.string().max(32).optional()
});

/** Ingest raw NMEA 0183 text. */
router.post(
  '/data/ingest/nmea',
  requireAuth,
  requireRole(Role.ENGINEER),
  ingestLimiter,
  validate(NmeaSchema),
  asyncHandler(async (req, res) => {
    const { messages, errors } = parseNmeaChunk(req.body.sentences, {
      sensorIdPrefix: req.body.sensorIdPrefix ?? 'NMEA'
    });
    stats.nmea_sentences_received += messages.length + errors.length;

    if (!ingestHandler) {
      return res.status(200).json({
        parsed: messages.length,
        errors,
        forwarded: 0,
        message: 'Parsed only: no navigation pipeline is running.',
        messages: messages.slice(0, 20)
      });
    }
    let accepted = 0;
    for (const message of messages) {
      const result = ingestHandler(message, { via: 'rest-nmea', user: req.user.username });
      if (result?.ok) {
        accepted += 1;
        stats.nmea_sentences_accepted += 1;
      }
    }
    res.status(202).json({ parsed: messages.length, forwarded: accepted, errors: errors.slice(0, 20) });
  })
);

/**
 * Validate a message without ingesting it.
 * Useful when integrating a new source: it answers "would you have accepted
 * this?" without side effects.
 */
router.post(
  '/data/validate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = validateSensorMessage(req.body);
    res.status(result.ok ? 200 : 400).json(
      result.ok
        ? { valid: true, normalized: result.message }
        : { valid: false, errors: result.errors }
    );
  })
);

router.get('/data/status', requireAuth, (req, res) => {
  res.json({
    ...stats,
    handler_attached: Boolean(ingestHandler),
    max_batch_size: 5000,
    max_body_bytes: getConfig().security.max_message_size_bytes,
    adapters: ADAPTERS.map((a) => ({ id: a.id, status: a.status, transport: a.transport }))
  });
});

/** The internal sensor message schema, published so integrators can target it. */
router.get('/data/schema', requireAuth, (req, res) => {
  res.json({
    description:
      'Standardized internal sensor message. Every adapter, simulated or real, must emit this shape. ' +
      'Messages are validated against it before they can reach the navigation pipeline.',
    example: {
      sensor_id: 'GNSS_01',
      sensor_type: 'GNSS',
      timestamp_utc: new Date().toISOString(),
      sequence_number: 1,
      position: { latitude: 24.51, longitude: 54.35, altitude_m: 1.6 },
      velocity: { north_mps: 2.1, east_mps: 0.4, down_mps: 0 },
      heading_deg: 11.2,
      depth_m: null,
      quality: { satellites: 14, hdop: 0.8, cn0_mean_dbhz: 45, fix_type: 'RTK_FIXED' },
      raw: {},
      valid: true
    },
    sensor_types: [
      'GNSS',
      'GYRO',
      'DVL',
      'SPEED_LOG',
      'RADAR',
      'LIDAR',
      'ECHO_SOUNDER',
      'MULTIBEAM',
      'BATHYMETRIC_MATCH',
      'INS',
      'LOCAL_RANGING',
      'AIS',
      'GROUND_TRUTH'
    ],
    rules: [
      'timestamp_utc must be ISO-8601 with an offset.',
      'sequence_number must increase per sensor; duplicates are detected and rejected.',
      'Unknown top-level fields are rejected rather than ignored.',
      'A message whose position or velocity is out of physical range is rejected at the schema.'
    ]
  });
});

export default router;
