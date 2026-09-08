/**
 * Adapter layer (Sections 7 and 8).
 *
 * Every source of sensor data - simulated, recorded or live - reaches the
 * navigation pipeline through an adapter that emits the standard internal
 * message. The point of the abstraction is that the pipeline cannot tell them
 * apart, so a demonstration on simulated data and a shadow-mode installation on
 * a vessel exercise exactly the same code.
 *
 * Implemented and working:
 *   CSV replay, JSON replay, WebSocket ingestion, REST ingestion, simulated UDP.
 *
 * Declared with a defined contract but not implemented (the platform has no
 * hardware to talk to, and a half-working marine protocol parser is worse than
 * an honest placeholder): NMEA 2000, IEC 61162-450, TCP, MQTT, ROS bag, PCAP.
 * NMEA 0183 *is* implemented, because it is text, well documented, and the most
 * likely first real integration.
 */

import { validateSensorMessage } from '../models/sensorMessage.js';
import { parseNmeaSentence, NMEA_SUPPORTED_SENTENCES } from './nmea0183.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('adapters');

/**
 * @typedef {object} AdapterDescriptor
 * @property {string} id
 * @property {string} name
 * @property {'IMPLEMENTED'|'PLACEHOLDER'} status
 * @property {string} transport
 * @property {string} description
 * @property {string} [contract] input/output contract for a placeholder
 * @property {string} [production_notes] how it would be completed
 */

/** The adapter catalogue, exposed over the API so the UI can show the truth. */
export const ADAPTERS = Object.freeze([
  {
    id: 'SIMULATION',
    name: 'Deterministic scenario simulator',
    status: 'IMPLEMENTED',
    transport: 'internal',
    description:
      'Generates ground truth and every sensor stream from a seeded model. The only source that also provides a reference track.'
  },
  {
    id: 'NMEA_0183',
    name: 'NMEA 0183 / IEC 61162-1',
    status: 'IMPLEMENTED',
    transport: 'serial / TCP / UDP text',
    description: `Parses ${NMEA_SUPPORTED_SENTENCES.join(', ')} into internal messages, with checksum verification.`,
    production_notes:
      'Talker-ID filtering, multi-sentence reassembly for VDM, and per-port sentence allow-lists would be added for a vessel installation.'
  },
  {
    id: 'CSV_REPLAY',
    name: 'CSV replay',
    status: 'IMPLEMENTED',
    transport: 'file upload',
    description: 'Column-mapped CSV of recorded sensor messages. Header names are matched case-insensitively.'
  },
  {
    id: 'JSON_REPLAY',
    name: 'JSON replay',
    status: 'IMPLEMENTED',
    transport: 'file upload',
    description: 'An array of internal sensor messages, or an object with a `messages` array.'
  },
  {
    id: 'REST_INGEST',
    name: 'REST ingestion',
    status: 'IMPLEMENTED',
    transport: 'HTTPS POST',
    description: 'POST /api/data/ingest accepts a validated batch of internal sensor messages.'
  },
  {
    id: 'WEBSOCKET_INGEST',
    name: 'WebSocket ingestion',
    status: 'IMPLEMENTED',
    transport: 'WebSocket',
    description: 'Authenticated clients may push sensor messages on /ws/live using the `ingest` frame type.'
  },
  {
    id: 'UDP_INGEST',
    name: 'UDP ingestion',
    status: 'IMPLEMENTED',
    transport: 'UDP datagram',
    description:
      'Accepts JSON sensor messages or raw NMEA 0183 sentences on a bound UDP port. Bound to loopback by default.'
  },
  {
    id: 'NMEA_2000',
    name: 'NMEA 2000 / CAN',
    status: 'PLACEHOLDER',
    transport: 'CAN bus via gateway',
    description: 'Not implemented. A binary PGN decoder requires hardware to validate against.',
    contract:
      'in: PGN frames from a CAN gateway (PGN 129025 position, 129026 COG/SOG, 127250 heading, 128267 depth). out: internal sensor messages.',
    production_notes:
      'Implement with a certified gateway (Actisense NGT-1 class) and a PGN dictionary; validate each PGN against a bench simulator before sea trials.'
  },
  {
    id: 'IEC_61162_450',
    name: 'IEC 61162-450 (Ethernet)',
    status: 'PLACEHOLDER',
    transport: 'UDP multicast',
    description: 'Not implemented. Requires a shipboard LAN with correctly configured multicast groups.',
    contract: 'in: UDP multicast datagrams carrying tagged NMEA sentences. out: internal sensor messages.',
    production_notes:
      'Reuses the NMEA 0183 parser once the transport tag block is stripped; needs multicast group and source filtering, and network segmentation review.'
  },
  {
    id: 'TCP_STREAM',
    name: 'TCP sensor stream',
    status: 'PLACEHOLDER',
    transport: 'TCP',
    description: 'Not implemented. Reconnection, back-pressure and framing policy differ per vendor.',
    contract: 'in: newline-delimited NMEA or JSON over a persistent TCP socket. out: internal sensor messages.'
  },
  {
    id: 'MQTT',
    name: 'MQTT broker',
    status: 'PLACEHOLDER',
    transport: 'MQTT',
    description: 'Not implemented. Requires a broker and a topic scheme agreed with the operator.',
    contract: 'in: JSON sensor messages on per-sensor topics. out: internal sensor messages.'
  },
  {
    id: 'ROS_BAG',
    name: 'ROS bag import',
    status: 'PLACEHOLDER',
    transport: 'file',
    description: 'Not implemented. Bag decoding needs the message definitions used when the bag was recorded.',
    contract: 'in: .bag or .mcap file plus a topic-to-sensor mapping. out: internal sensor messages.'
  },
  {
    id: 'PCAP',
    name: 'PCAP import',
    status: 'PLACEHOLDER',
    transport: 'file',
    description: 'Not implemented. Useful for forensic replay of a real interference event.',
    contract: 'in: .pcap capture of the sensor VLAN plus a port-to-sensor mapping. out: internal sensor messages.'
  },
  {
    id: 'SURVEY_ACQUISITION',
    name: 'Survey acquisition system export',
    status: 'PLACEHOLDER',
    transport: 'file / share',
    description:
      'Not implemented. Vendor-neutral placeholder for multibeam and positioning logs from a survey package.',
    contract: 'in: vendor export (e.g. GSF, S7K, HSX) plus a channel mapping. out: internal sensor messages.'
  }
]);

/**
 * Base adapter contract. A concrete adapter reads from its transport, converts
 * to internal messages, validates them, and hands them to `onMessage`.
 */
export class BaseAdapter {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {(message: object, meta: object) => void} options.onMessage
   */
  constructor({ id, onMessage }) {
    this.id = id;
    this.onMessage = onMessage;
    this.stats = { received: 0, accepted: 0, rejected: 0, lastError: null, startedAt: null };
  }

  async start() {
    this.stats.startedAt = new Date().toISOString();
  }

  async stop() {}

  /**
   * Validate and forward. Invalid input is counted and reported, never passed
   * through: the pipeline may only ever see schema-valid messages.
   * @returns {{ ok: boolean, errors?: string[] }}
   */
  emit(candidate, meta = {}) {
    this.stats.received += 1;
    const result = validateSensorMessage(candidate);
    if (!result.ok) {
      this.stats.rejected += 1;
      this.stats.lastError = { at: new Date().toISOString(), errors: result.errors.slice(0, 5) };
      log.warn('adapter rejected a message', { adapter: this.id, errors: result.errors.slice(0, 3) });
      return { ok: false, errors: result.errors };
    }
    this.stats.accepted += 1;
    this.onMessage?.(result.message, { adapter: this.id, ...meta });
    return { ok: true };
  }

  status() {
    return { id: this.id, ...this.stats };
  }
}

/**
 * Convert a chunk of NMEA text into internal messages.
 * @param {string} text
 * @param {object} options
 * @returns {{ messages: object[], errors: string[] }}
 */
export function parseNmeaChunk(text, { sensorIdPrefix = 'NMEA', sequenceStart = 0 } = {}) {
  const messages = [];
  const errors = [];
  let sequence = sequenceStart;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseNmeaSentence(trimmed, { sensorIdPrefix, sequenceNumber: sequence + 1 });
      if (parsed) {
        sequence += 1;
        messages.push(parsed);
      }
    } catch (err) {
      errors.push(`${trimmed.slice(0, 40)}: ${err.message}`);
    }
  }
  return { messages, errors };
}

/**
 * Convert CSV text into internal messages.
 *
 * Column names are matched case-insensitively and dotted names are supported
 * (`position.latitude`), so a CSV exported from this platform round-trips.
 */
export function parseCsv(text, { defaultSensorId = 'CSV_01', defaultSensorType = 'GNSS' } = {}) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { messages: [], errors: ['CSV must contain a header row and at least one data row.'] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i !== -1) return i;
    }
    return -1;
  };

  const cols = {
    sensorId: idx('sensor_id', 'sensorid', 'sensor'),
    sensorType: idx('sensor_type', 'sensortype', 'type'),
    timestamp: idx('timestamp_utc', 'timestamp', 'time_utc', 'utc'),
    simTime: idx('sim_time_s', 'time_s', 't'),
    sequence: idx('sequence_number', 'sequence', 'seq'),
    latitude: idx('latitude', 'position.latitude', 'lat'),
    longitude: idx('longitude', 'position.longitude', 'lon', 'lng'),
    altitude: idx('altitude_m', 'position.altitude_m', 'alt'),
    vNorth: idx('velocity_north_mps', 'velocity.north_mps', 'v_north'),
    vEast: idx('velocity_east_mps', 'velocity.east_mps', 'v_east'),
    vDown: idx('velocity_down_mps', 'velocity.down_mps', 'v_down'),
    heading: idx('heading_deg', 'heading'),
    depth: idx('depth_m', 'depth'),
    quality: idx('quality'),
    raw: idx('raw'),
    valid: idx('valid')
  };

  // A CSV with none of the expected measurement columns is not a sensor
  // recording. Accepting it would manufacture a stream of empty but
  // schema-valid messages from arbitrary data, which is worse than rejecting
  // the file: the operator would believe an import had succeeded.
  const measurementColumns = ['latitude', 'longitude', 'vNorth', 'vEast', 'heading', 'depth'];
  if (!measurementColumns.some((c) => cols[c] !== -1)) {
    return {
      messages: [],
      errors: [
        'No recognised measurement columns found. Expected at least one of: latitude, longitude, ' +
          'velocity_north_mps, velocity_east_mps, heading_deg, depth_m. ' +
          `Found: ${header.join(', ')}`
      ]
    };
  }

  const messages = [];
  const errors = [];
  const epoch = Date.now();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const num = (c) => (cols[c] === -1 || cells[cols[c]] === undefined || cells[cols[c]] === '' ? null : Number(cells[cols[c]]));
    const str = (c) => (cols[c] === -1 ? null : (cells[cols[c]] ?? '').trim());

    const lat = num('latitude');
    const lon = num('longitude');
    const timestamp =
      str('timestamp') ||
      (cols.simTime !== -1 ? new Date(epoch + Number(cells[cols.simTime]) * 1000).toISOString() : new Date(epoch + i * 200).toISOString());

    const candidate = {
      sensor_id: str('sensorId') || defaultSensorId,
      sensor_type: (str('sensorType') || defaultSensorType).toUpperCase(),
      timestamp_utc: normaliseTimestamp(timestamp),
      sequence_number: cols.sequence === -1 ? i : Number(cells[cols.sequence]) || i,
      position: lat !== null && lon !== null ? { latitude: lat, longitude: lon, altitude_m: num('altitude') ?? 0 } : null,
      velocity:
        num('vNorth') !== null || num('vEast') !== null
          ? { north_mps: num('vNorth') ?? 0, east_mps: num('vEast') ?? 0, down_mps: num('vDown') ?? 0 }
          : null,
      heading_deg: num('heading'),
      depth_m: num('depth'),
      quality: safeJson(str('quality')) ?? {},
      raw: safeJson(str('raw')) ?? {},
      valid: cols.valid === -1 ? true : !['false', '0', 'no'].includes(String(cells[cols.valid]).toLowerCase())
    };

    const result = validateSensorMessage(candidate);
    if (result.ok) messages.push(result.message);
    else errors.push(`row ${i + 1}: ${result.errors.slice(0, 2).join('; ')}`);
    if (errors.length > 50) {
      errors.push('… further errors suppressed.');
      break;
    }
  }
  return { messages, errors };
}

/** Convert JSON text into internal messages. */
export function parseJson(text) {
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    return { messages: [], errors: [`Invalid JSON: ${err.message}`] };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.messages) ? parsed.messages : null;
  if (!list) return { messages: [], errors: ['Expected an array of messages or an object with a `messages` array.'] };

  const messages = [];
  const errors = [];
  for (let i = 0; i < list.length; i += 1) {
    const candidate = { ...list[i] };
    if (candidate.timestamp_utc) candidate.timestamp_utc = normaliseTimestamp(candidate.timestamp_utc);
    const result = validateSensorMessage(candidate);
    if (result.ok) messages.push(result.message);
    else errors.push(`item ${i}: ${result.errors.slice(0, 2).join('; ')}`);
    if (errors.length > 50) {
      errors.push('… further errors suppressed.');
      break;
    }
  }
  return { messages, errors };
}

/** Minimal RFC 4180 line splitter. */
function splitCsvLine(line) {
  const out = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out;
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Accept an ISO string or an epoch value and return a strict ISO string. */
function normaliseTimestamp(value) {
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
}

export { normaliseTimestamp };
