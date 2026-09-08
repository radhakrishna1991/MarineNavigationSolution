/**
 * NMEA 0183 / IEC 61162-1 parser.
 *
 * Implemented because it is the protocol a first real integration is most
 * likely to use, it is plain text, and it can be tested without hardware.
 *
 * Supported sentences and the internal message each produces:
 *   GGA  fix, position, satellites, HDOP, altitude   -> GNSS
 *   RMC  position, SOG, COG, date/time, status       -> GNSS
 *   GLL  position and time                            -> GNSS
 *   VTG  course and speed over ground                 -> GNSS (velocity only)
 *   GSA  fix mode and DOP values                      -> GNSS quality update
 *   HDT  true heading                                 -> GYRO
 *   THS  true heading with status                     -> GYRO
 *   ROT  rate of turn                                 -> GYRO (rate only)
 *   VBW  dual-ground/water speed                      -> DVL or SPEED_LOG
 *   VHW  water speed and heading                      -> SPEED_LOG
 *   DBT  depth below transducer                       -> ECHO_SOUNDER
 *   DPT  depth with transducer offset                 -> ECHO_SOUNDER
 *
 * Checksums are verified. A sentence with a bad checksum is rejected rather
 * than repaired: silently accepting corrupt navigation data is exactly the
 * failure mode this platform exists to detect.
 */

import { buildSensorMessage } from '../models/sensorMessage.js';
import { SensorType } from '../models/enums.js';

export const NMEA_SUPPORTED_SENTENCES = Object.freeze([
  'GGA',
  'RMC',
  'GLL',
  'VTG',
  'GSA',
  'HDT',
  'THS',
  'ROT',
  'VBW',
  'VHW',
  'DBT',
  'DPT'
]);

/** XOR checksum of the characters between '$' and '*'. */
export function nmeaChecksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum ^= body.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** ddmm.mmmm + hemisphere -> signed decimal degrees. */
function parseLatLon(value, hemisphere, degreeDigits) {
  if (!value || !hemisphere) return null;
  const degrees = Number(value.slice(0, degreeDigits));
  const minutes = Number(value.slice(degreeDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  const decimal = degrees + minutes / 60;
  return ['S', 'W'].includes(hemisphere.toUpperCase()) ? -decimal : decimal;
}

/** hhmmss.ss (+ optional ddmmyy) -> ISO 8601. */
function parseTime(timeField, dateField) {
  if (!timeField) return new Date().toISOString();
  const hh = Number(timeField.slice(0, 2));
  const mm = Number(timeField.slice(2, 4));
  const ss = Number(timeField.slice(4));
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let day = now.getUTCDate();
  if (dateField && dateField.length === 6) {
    day = Number(dateField.slice(0, 2));
    month = Number(dateField.slice(2, 4)) - 1;
    // NMEA carries a two-digit year; the century is assumed to be the current
    // one. Documented rather than guessed at.
    year = 2000 + Number(dateField.slice(4, 6));
  }
  const ms = Date.UTC(year, month, day, hh, mm, Math.floor(ss), Math.round((ss % 1) * 1000));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

const KNOTS_TO_MPS = 0.514444;
const KMH_TO_MPS = 1 / 3.6;

/** GGA fix-quality codes. */
const FIX_QUALITY = {
  0: 'NO_FIX',
  1: 'SPS',
  2: 'DGPS',
  3: 'PPS',
  4: 'RTK_FIXED',
  5: 'RTK_FLOAT',
  6: 'DEAD_RECKONING',
  7: 'MANUAL',
  8: 'SIMULATION'
};

/**
 * Parse one sentence.
 *
 * @param {string} sentence raw sentence including '$' and checksum
 * @param {object} options
 * @returns {object|null} internal sensor message, or null for an unsupported
 *          but well-formed sentence
 * @throws on a malformed sentence or checksum failure
 */
export function parseNmeaSentence(sentence, { sensorIdPrefix = 'NMEA', sequenceNumber = 1, sensorIdOverride = null } = {}) {
  const text = sentence.trim();
  if (!text.startsWith('$') && !text.startsWith('!')) {
    throw new Error('Sentence must begin with $ or !');
  }
  const starIndex = text.lastIndexOf('*');
  if (starIndex === -1) throw new Error('Missing checksum delimiter');
  const body = text.slice(1, starIndex);
  const supplied = text.slice(starIndex + 1).trim().toUpperCase();
  const computed = nmeaChecksum(body);
  if (supplied !== computed) {
    throw new Error(`Checksum mismatch (sentence says ${supplied}, computed ${computed})`);
  }

  const fields = body.split(',');
  const talkerAndType = fields[0];
  if (talkerAndType.length < 5) throw new Error('Malformed sentence identifier');
  const type = talkerAndType.slice(-3).toUpperCase();
  const talker = talkerAndType.slice(0, -3).toUpperCase();

  const build = (sensorType, defaultId, payload) => {
    const { raw, ...rest } = payload;
    return buildSensorMessage({
      sensorId: sensorIdOverride || `${sensorIdPrefix}_${defaultId}`,
      sensorType,
      sequenceNumber,
      ...rest,
      // The originating sentence is always retained for the audit trail.
      raw: { sentence: text, talker, type, ...(raw ?? {}) }
    });
  };

  switch (type) {
    case 'GGA': {
      const quality = Number(fields[6]);
      const lat = parseLatLon(fields[2], fields[3], 2);
      const lon = parseLatLon(fields[4], fields[5], 3);
      return build(SensorType.GNSS, 'GNSS', {
        timestampUtc: parseTime(fields[1]),
        position: lat === null || lon === null ? null : { latitude: lat, longitude: lon, altitude_m: Number(fields[9]) || 0 },
        quality: {
          fix_type: FIX_QUALITY[quality] ?? 'UNKNOWN',
          satellites: Number(fields[7]) || 0,
          hdop: Number(fields[8]) || undefined,
          reported_accuracy_m: Number(fields[8]) ? Number(fields[8]) * 2.5 : undefined
        },
        raw: { geoid_separation_m: Number(fields[11]) || null, dgps_age_s: Number(fields[13]) || null },
        valid: quality > 0 && lat !== null && lon !== null
      });
    }

    case 'RMC': {
      const status = (fields[2] || 'V').toUpperCase();
      const lat = parseLatLon(fields[3], fields[4], 2);
      const lon = parseLatLon(fields[5], fields[6], 3);
      const sog = Number(fields[7]) * KNOTS_TO_MPS;
      const cog = Number(fields[8]);
      const hasVelocity = Number.isFinite(sog) && Number.isFinite(cog);
      const cogRad = (cog * Math.PI) / 180;
      return build(SensorType.GNSS, 'GNSS', {
        timestampUtc: parseTime(fields[1], fields[9]),
        position: lat === null || lon === null ? null : { latitude: lat, longitude: lon, altitude_m: 0 },
        velocity: hasVelocity
          ? { north_mps: sog * Math.cos(cogRad), east_mps: sog * Math.sin(cogRad), down_mps: 0 }
          : null,
        quality: { fix_type: status === 'A' ? 'SPS' : 'NO_FIX', status: status === 'A' ? 'VALID' : 'WARNING' },
        raw: { speed_over_ground_mps: hasVelocity ? sog : null, course_over_ground_deg: hasVelocity ? cog : null },
        valid: status === 'A' && lat !== null && lon !== null
      });
    }

    case 'GLL': {
      const status = (fields[6] || 'V').toUpperCase();
      const lat = parseLatLon(fields[1], fields[2], 2);
      const lon = parseLatLon(fields[3], fields[4], 3);
      return build(SensorType.GNSS, 'GNSS', {
        timestampUtc: parseTime(fields[5]),
        position: lat === null || lon === null ? null : { latitude: lat, longitude: lon, altitude_m: 0 },
        quality: { status: status === 'A' ? 'VALID' : 'WARNING' },
        valid: status === 'A' && lat !== null && lon !== null
      });
    }

    case 'VTG': {
      const cog = Number(fields[1]);
      const sogKnots = Number(fields[5]);
      const sogKmh = Number(fields[7]);
      const sog = Number.isFinite(sogKnots) ? sogKnots * KNOTS_TO_MPS : sogKmh * KMH_TO_MPS;
      if (!Number.isFinite(cog) || !Number.isFinite(sog)) return null;
      const cogRad = (cog * Math.PI) / 180;
      return build(SensorType.GNSS, 'GNSS', {
        timestampUtc: new Date().toISOString(),
        velocity: { north_mps: sog * Math.cos(cogRad), east_mps: sog * Math.sin(cogRad), down_mps: 0 },
        quality: { status: 'VELOCITY_ONLY' },
        raw: { course_over_ground_deg: cog, speed_over_ground_mps: sog },
        valid: true
      });
    }

    case 'GSA': {
      return build(SensorType.GNSS, 'GNSS', {
        timestampUtc: new Date().toISOString(),
        quality: {
          pdop: Number(fields[15]) || undefined,
          hdop: Number(fields[16]) || undefined,
          vdop: Number(fields[17]) || undefined,
          fix_type: fields[2] === '3' ? 'SPS' : fields[2] === '2' ? 'SPS_2D' : 'NO_FIX',
          status: 'DOP_UPDATE'
        },
        valid: fields[2] !== '1'
      });
    }

    case 'HDT':
    case 'THS': {
      const heading = Number(fields[1]);
      if (!Number.isFinite(heading)) return null;
      const status = type === 'THS' ? (fields[2] || 'A').toUpperCase() : 'A';
      return build(SensorType.GYRO, 'GYRO', {
        timestampUtc: new Date().toISOString(),
        headingDeg: heading,
        quality: { status: status === 'A' ? 'SETTLED' : `MODE_${status}` },
        valid: status === 'A'
      });
    }

    case 'ROT': {
      const rotPerMinute = Number(fields[1]);
      const status = (fields[2] || 'A').toUpperCase();
      if (!Number.isFinite(rotPerMinute)) return null;
      return build(SensorType.GYRO, 'GYRO', {
        timestampUtc: new Date().toISOString(),
        quality: { status: status === 'A' ? 'RATE_VALID' : 'RATE_INVALID' },
        raw: { rate_of_turn_dps: rotPerMinute / 60, rate_of_turn_dpm: rotPerMinute },
        valid: status === 'A'
      });
    }

    case 'VBW': {
      // Longitudinal/transverse water speed, then ground speed. Ground speed
      // present and valid means this is a bottom-tracking log (a DVL).
      const waterLong = Number(fields[1]) * KNOTS_TO_MPS;
      const waterTrans = Number(fields[2]) * KNOTS_TO_MPS;
      const waterStatus = (fields[3] || 'V').toUpperCase();
      const groundLong = Number(fields[4]) * KNOTS_TO_MPS;
      const groundTrans = Number(fields[5]) * KNOTS_TO_MPS;
      const groundStatus = (fields[6] || 'V').toUpperCase();
      const bottomLock = groundStatus === 'A' && Number.isFinite(groundLong);
      const forward = bottomLock ? groundLong : waterLong;
      const starboard = bottomLock ? groundTrans : waterTrans;
      if (!Number.isFinite(forward)) return null;
      return build(bottomLock ? SensorType.DVL : SensorType.SPEED_LOG, bottomLock ? 'DVL' : 'LOG', {
        timestampUtc: new Date().toISOString(),
        quality: {
          bottom_lock: bottomLock,
          status: bottomLock ? 'BOTTOM_TRACK' : waterStatus === 'A' ? 'WATER_TRACK' : 'INVALID'
        },
        raw: {
          forward_mps: forward,
          starboard_mps: Number.isFinite(starboard) ? starboard : 0,
          reference: bottomLock ? 'GROUND' : 'WATER'
        },
        valid: bottomLock || waterStatus === 'A'
      });
    }

    case 'VHW': {
      const speedKnots = Number(fields[5]);
      const heading = Number(fields[3]);
      const speed = Number.isFinite(speedKnots) ? speedKnots * KNOTS_TO_MPS : Number(fields[7]) * KMH_TO_MPS;
      if (!Number.isFinite(speed)) return null;
      return build(SensorType.SPEED_LOG, 'LOG', {
        timestampUtc: new Date().toISOString(),
        headingDeg: Number.isFinite(heading) ? heading : null,
        quality: { status: 'WATER_TRACK' },
        raw: { forward_mps: speed, reference: 'WATER' },
        valid: true
      });
    }

    case 'DBT': {
      const metres = Number(fields[3]);
      const feet = Number(fields[1]);
      const depth = Number.isFinite(metres) ? metres : feet * 0.3048;
      if (!Number.isFinite(depth)) return null;
      return build(SensorType.ECHO_SOUNDER, 'ECHO', {
        timestampUtc: new Date().toISOString(),
        depthM: depth,
        quality: { status: 'TRACKING' },
        raw: { reference: 'BELOW_TRANSDUCER' },
        valid: true
      });
    }

    case 'DPT': {
      const depth = Number(fields[1]);
      const offset = Number(fields[2]);
      if (!Number.isFinite(depth)) return null;
      return build(SensorType.ECHO_SOUNDER, 'ECHO', {
        timestampUtc: new Date().toISOString(),
        depthM: depth,
        quality: { status: 'TRACKING' },
        raw: {
          reference: 'BELOW_TRANSDUCER',
          // A positive offset is transducer-to-waterline, a negative one is
          // transducer-to-keel. Both are carried through unchanged.
          transducer_offset_m: Number.isFinite(offset) ? Math.abs(offset) : null,
          offset_reference: Number.isFinite(offset) ? (offset >= 0 ? 'WATERLINE' : 'KEEL') : null,
          max_range_m: Number(fields[3]) || null
        },
        valid: true
      });
    }

    default:
      // Well formed but not one we consume. Not an error.
      return null;
  }
}

export default parseNmeaSentence;
