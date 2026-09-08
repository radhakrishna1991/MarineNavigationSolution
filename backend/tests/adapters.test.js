/**
 * Adapter and message-model tests (Sections 7 and 8).
 *
 * The message schema is the platform's trust boundary: anything that gets past
 * it is treated as a real measurement. These tests are about what must NOT get
 * through as much as what must.
 */

import { parseNmeaSentence, nmeaChecksum, NMEA_SUPPORTED_SENTENCES } from '../src/adapters/nmea0183.js';
import { parseCsv, parseJson, parseNmeaChunk, ADAPTERS, BaseAdapter } from '../src/adapters/index.js';
import { validateSensorMessage, buildSensorMessage } from '../src/models/sensorMessage.js';
import { SensorType } from '../src/models/enums.js';

/** Append the correct checksum to a sentence body. */
function withChecksum(body) {
  return `$${body}*${nmeaChecksum(body)}`;
}

describe('NMEA 0183 parser', () => {
  it('verifies the checksum and rejects a corrupted sentence', () => {
    const good = withChecksum('GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,');
    expect(() => parseNmeaSentence(good)).not.toThrow();

    const corrupted = good.replace('2430.600', '2430.700');
    expect(() => parseNmeaSentence(corrupted)).toThrow(/Checksum mismatch/);
  });

  it('rejects a sentence with no checksum delimiter', () => {
    expect(() => parseNmeaSentence('$GPGGA,123519,2430.600,N')).toThrow(/Missing checksum/);
  });

  it('parses GGA into a GNSS position with quality', () => {
    const message = parseNmeaSentence(withChecksum('GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,'));
    expect(message.sensor_type).toBe(SensorType.GNSS);
    expect(message.position.latitude).toBeCloseTo(24 + 30.6 / 60, 6);
    expect(message.position.longitude).toBeCloseTo(54 + 21 / 60, 6);
    expect(message.quality.fix_type).toBe('RTK_FIXED');
    expect(message.quality.satellites).toBe(12);
    expect(message.quality.hdop).toBeCloseTo(0.8, 6);
    expect(message.valid).toBe(true);
  });

  it('handles southern and western hemispheres', () => {
    const message = parseNmeaSentence(withChecksum('GPGGA,123519,3345.500,S,15112.250,W,1,08,1.2,10.0,M,,M,,'));
    expect(message.position.latitude).toBeLessThan(0);
    expect(message.position.longitude).toBeLessThan(0);
    expect(message.position.latitude).toBeCloseTo(-(33 + 45.5 / 60), 6);
  });

  it('marks a GGA with no fix as invalid', () => {
    const message = parseNmeaSentence(withChecksum('GPGGA,123519,2430.600,N,05421.000,E,0,00,99.9,,M,,M,,'));
    expect(message.quality.fix_type).toBe('NO_FIX');
    expect(message.valid).toBe(false);
  });

  it('parses RMC into position and velocity', () => {
    const message = parseNmeaSentence(withChecksum('GPRMC,123519,A,2430.600,N,05421.000,E,6.0,090.0,181124,,,A'));
    expect(message.position).not.toBeNull();
    // 6 knots on a course of 090 is due east.
    expect(message.velocity.east_mps).toBeCloseTo(6 * 0.514444, 4);
    expect(message.velocity.north_mps).toBeCloseTo(0, 6);
    expect(message.valid).toBe(true);
  });

  it('marks an RMC with a void status as invalid', () => {
    const message = parseNmeaSentence(withChecksum('GPRMC,123519,V,2430.600,N,05421.000,E,0.0,000.0,181124,,,N'));
    expect(message.valid).toBe(false);
  });

  it('parses HDT into a gyro heading', () => {
    const message = parseNmeaSentence(withChecksum('HEHDT,123.4,T'));
    expect(message.sensor_type).toBe(SensorType.GYRO);
    expect(message.heading_deg).toBeCloseTo(123.4, 6);
  });

  it('parses ROT into a rate of turn in degrees per second', () => {
    const message = parseNmeaSentence(withChecksum('HEROT,-60.0,A'));
    expect(message.raw.rate_of_turn_dps).toBeCloseTo(-1.0, 6);
    expect(message.valid).toBe(true);
  });

  it('distinguishes a bottom-tracking VBW from a water-tracking one', () => {
    const bottom = parseNmeaSentence(withChecksum('VDVBW,5.0,0.1,A,6.0,0.2,A,,,'));
    expect(bottom.sensor_type).toBe(SensorType.DVL);
    expect(bottom.quality.bottom_lock).toBe(true);
    expect(bottom.raw.forward_mps).toBeCloseTo(6 * 0.514444, 4);

    const water = parseNmeaSentence(withChecksum('VDVBW,5.0,0.1,A,,,V,,,'));
    expect(water.sensor_type).toBe(SensorType.SPEED_LOG);
    expect(water.quality.bottom_lock).toBe(false);
  });

  it('parses DBT and DPT depths', () => {
    const dbt = parseNmeaSentence(withChecksum('SDDBT,32.8,f,10.0,M,5.5,F'));
    expect(dbt.sensor_type).toBe(SensorType.ECHO_SOUNDER);
    expect(dbt.depth_m).toBeCloseTo(10.0, 6);

    const dpt = parseNmeaSentence(withChecksum('SDDPT,12.5,0.5,100.0'));
    expect(dpt.depth_m).toBeCloseTo(12.5, 6);
    expect(dpt.raw.transducer_offset_m).toBeCloseTo(0.5, 6);
    expect(dpt.raw.offset_reference).toBe('WATERLINE');
  });

  it('returns null for a well-formed sentence it does not consume', () => {
    expect(parseNmeaSentence(withChecksum('GPZDA,123519,18,11,2024,00,00'))).toBeNull();
  });

  it('retains the originating sentence for the audit trail', () => {
    const sentence = withChecksum('HEHDT,45.0,T');
    const message = parseNmeaSentence(sentence);
    expect(message.raw.sentence).toBe(sentence);
    expect(message.raw.talker).toBe('HE');
  });

  it('produces messages that satisfy the internal schema', () => {
    const sentences = [
      'GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,',
      'GPRMC,123519,A,2430.600,N,05421.000,E,6.0,090.0,181124,,,A',
      'HEHDT,123.4,T',
      'VDVBW,5.0,0.1,A,6.0,0.2,A,,,',
      'SDDBT,32.8,f,10.0,M,5.5,F'
    ].map(withChecksum);

    for (const sentence of sentences) {
      const message = parseNmeaSentence(sentence);
      if (!message) continue;
      const result = validateSensorMessage({ ...message, sequence_number: 1 });
      expect(result.ok).toBe(true);
    }
  });

  it('parses a multi-line chunk and reports per-line errors', () => {
    const text = [
      withChecksum('GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,'),
      '$GPGGA,BROKEN*00',
      withChecksum('HEHDT,45.0,T')
    ].join('\r\n');
    const { messages, errors } = parseNmeaChunk(text);
    expect(messages.length).toBe(2);
    expect(errors.length).toBe(1);
    expect(messages[0].sequence_number).toBe(1);
    expect(messages[1].sequence_number).toBe(2);
  });

  it('documents which sentences it supports', () => {
    expect(NMEA_SUPPORTED_SENTENCES).toContain('GGA');
    expect(NMEA_SUPPORTED_SENTENCES).toContain('VBW');
    expect(NMEA_SUPPORTED_SENTENCES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('CSV replay adapter', () => {
  it('parses a round-tripped export', () => {
    const csv = [
      'sensor_id,sensor_type,timestamp_utc,sequence_number,latitude,longitude,heading_deg',
      'GNSS_01,GNSS,2024-11-18T06:00:00.000Z,1,24.51,54.35,',
      'GNSS_01,GNSS,2024-11-18T06:00:00.200Z,2,24.5101,54.3501,',
      'GYRO_01,GYRO,2024-11-18T06:00:00.050Z,3,,,12.5'
    ].join('\n');
    const { messages, errors } = parseCsv(csv);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(3);
    expect(messages[0].position.latitude).toBeCloseTo(24.51, 6);
    expect(messages[2].heading_deg).toBeCloseTo(12.5, 6);
    expect(messages[2].position).toBeNull();
  });

  it('handles quoted cells containing commas', () => {
    const csv = [
      'sensor_id,sensor_type,timestamp_utc,sequence_number,latitude,longitude,quality',
      'GNSS_01,GNSS,2024-11-18T06:00:00.000Z,1,24.51,54.35,"{""fix_type"":""RTK_FIXED"",""satellites"":12}"'
    ].join('\n');
    const { messages, errors } = parseCsv(csv);
    expect(errors).toHaveLength(0);
    expect(messages[0].quality.satellites).toBe(12);
    expect(messages[0].quality.fix_type).toBe('RTK_FIXED');
  });

  it('reports a row it cannot accept rather than silently dropping it', () => {
    const csv = [
      'sensor_id,sensor_type,timestamp_utc,sequence_number,latitude,longitude',
      'GNSS_01,GNSS,2024-11-18T06:00:00.000Z,1,999,54.35'
    ].join('\n');
    const { messages, errors } = parseCsv(csv);
    expect(messages).toHaveLength(0);
    expect(errors[0]).toMatch(/row 2/);
  });

  it('rejects a file with no data rows', () => {
    const { messages, errors } = parseCsv('sensor_id,sensor_type\n');
    expect(messages).toHaveLength(0);
    expect(errors[0]).toMatch(/header row/);
  });

  it('rejects a file with no recognisable measurement columns', () => {
    const { messages, errors } = parseCsv('alpha,beta\n1,2\n3,4');
    expect(messages).toHaveLength(0);
    expect(errors[0]).toMatch(/No recognised measurement columns/);
    expect(errors[0]).toMatch(/alpha, beta/);
  });
});

describe('JSON replay adapter', () => {
  it('accepts an array or a messages envelope', () => {
    const message = buildSensorMessage({
      sensorId: 'GNSS_01',
      sensorType: SensorType.GNSS,
      timestampUtc: '2024-11-18T06:00:00.000Z',
      sequenceNumber: 1,
      position: { latitude: 24.51, longitude: 54.35, altitude_m: 0 }
    });
    expect(parseJson(JSON.stringify([message])).messages).toHaveLength(1);
    expect(parseJson(JSON.stringify({ messages: [message] })).messages).toHaveLength(1);
  });

  it('reports malformed JSON clearly', () => {
    const { messages, errors } = parseJson('{ not json');
    expect(messages).toHaveLength(0);
    expect(errors[0]).toMatch(/Invalid JSON/);
  });

  it('rejects a payload that is neither an array nor an envelope', () => {
    const { errors } = parseJson(JSON.stringify({ foo: 'bar' }));
    expect(errors[0]).toMatch(/Expected an array/);
  });
});

describe('internal message schema', () => {
  const valid = () => ({
    sensor_id: 'GNSS_01',
    sensor_type: 'GNSS',
    timestamp_utc: '2024-11-18T06:00:00.000Z',
    sequence_number: 1,
    position: { latitude: 24.51, longitude: 54.35, altitude_m: 0 },
    velocity: { north_mps: 1, east_mps: 0, down_mps: 0 },
    heading_deg: 10,
    depth_m: 12,
    quality: {},
    raw: {},
    valid: true
  });

  it('accepts a well-formed message', () => {
    expect(validateSensorMessage(valid()).ok).toBe(true);
  });

  it('rejects an out-of-range latitude', () => {
    const result = validateSensorMessage({ ...valid(), position: { latitude: 91, longitude: 0, altitude_m: 0 } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/latitude/);
  });

  it('rejects an impossible velocity', () => {
    const result = validateSensorMessage({
      ...valid(),
      velocity: { north_mps: 500, east_mps: 0, down_mps: 0 }
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown sensor type', () => {
    const result = validateSensorMessage({ ...valid(), sensor_type: 'TELEPATHY' });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed timestamp', () => {
    const result = validateSensorMessage({ ...valid(), timestamp_utc: 'yesterday' });
    expect(result.ok).toBe(false);
  });

  it('rejects a negative sequence number', () => {
    expect(validateSensorMessage({ ...valid(), sequence_number: -1 }).ok).toBe(false);
  });

  it('rejects unknown top-level fields rather than ignoring them', () => {
    const result = validateSensorMessage({ ...valid(), inject: 'rm -rf /' });
    expect(result.ok).toBe(false);
  });

  it('rejects a sensor id with unexpected characters', () => {
    expect(validateSensorMessage({ ...valid(), sensor_id: "GNSS'; DROP TABLE users;--" }).ok).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(validateSensorMessage({ ...valid(), heading_deg: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateSensorMessage({ ...valid(), depth_m: Number.NaN }).ok).toBe(false);
  });
});

describe('adapter catalogue', () => {
  it('states honestly which adapters are implemented and which are placeholders', () => {
    const implemented = ADAPTERS.filter((a) => a.status === 'IMPLEMENTED').map((a) => a.id);
    const placeholders = ADAPTERS.filter((a) => a.status === 'PLACEHOLDER');

    expect(implemented).toEqual(
      expect.arrayContaining(['NMEA_0183', 'CSV_REPLAY', 'JSON_REPLAY', 'REST_INGEST', 'WEBSOCKET_INGEST', 'UDP_INGEST'])
    );
    // Every placeholder must document its input/output contract.
    for (const placeholder of placeholders) {
      expect(placeholder.description).toMatch(/not implemented/i);
      expect(placeholder.contract ?? '').not.toHaveLength(0);
    }
    expect(placeholders.map((p) => p.id)).toEqual(
      expect.arrayContaining(['NMEA_2000', 'IEC_61162_450', 'MQTT', 'ROS_BAG', 'PCAP'])
    );
  });
});

describe('base adapter', () => {
  it('validates before forwarding and counts rejections', () => {
    const received = [];
    const adapter = new BaseAdapter({ id: 'TEST', onMessage: (m) => received.push(m) });

    const good = adapter.emit({
      sensor_id: 'GNSS_01',
      sensor_type: 'GNSS',
      timestamp_utc: '2024-11-18T06:00:00.000Z',
      sequence_number: 1,
      position: { latitude: 24.5, longitude: 54.3, altitude_m: 0 }
    });
    expect(good.ok).toBe(true);
    expect(received).toHaveLength(1);

    const bad = adapter.emit({ sensor_id: 'X', sensor_type: 'NOPE', timestamp_utc: 'x', sequence_number: 1 });
    expect(bad.ok).toBe(false);
    expect(received).toHaveLength(1);
    expect(adapter.status().rejected).toBe(1);
    expect(adapter.status().accepted).toBe(1);
  });
});
