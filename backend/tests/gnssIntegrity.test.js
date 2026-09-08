/**
 * GNSS integrity tests (Section 24 "GNSS Integrity").
 *
 * Each test drives the trust engine directly with constructed inputs, so the
 * assertion is about the detection logic and not about whichever scenario
 * happened to produce a similar situation.
 */

import { jest } from '@jest/globals';
import { GnssIntegrityEngine } from '../src/navigation/gnssIntegrity.js';
import { buildEnvironment } from '../src/geospatial/environment.js';
import { buildSensorMessage } from '../src/models/sensorMessage.js';
import { SensorType, GnssCondition, GnssAction } from '../src/models/enums.js';
import { getConfig } from '../src/config/index.js';

const EPOCH_MS = Date.UTC(2024, 10, 18, 6, 0, 0);

function makeEngine() {
  const environment = buildEnvironment();
  const engine = new GnssIntegrityEngine({ environment });
  engine.setEpoch(EPOCH_MS);
  return { engine, environment };
}

/** Build a healthy GNSS message at a local ENU offset. */
function gnssAt(environment, east, north, time, overrides = {}) {
  const geo = environment.frame.toGeodetic(east, north);
  return buildSensorMessage({
    sensorId: 'GNSS_01',
    sensorType: SensorType.GNSS,
    timestampUtc: new Date(EPOCH_MS + time * 1000).toISOString(),
    sequenceNumber: Math.round(time * 5),
    position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 1.6 },
    velocity: { north_mps: 3, east_mps: 0, down_mps: 0 },
    quality: {
      satellites: 14,
      hdop: 0.8,
      pdop: 1.5,
      cn0_mean_dbhz: 45,
      fix_type: 'RTK_FIXED',
      reported_accuracy_m: 1.2,
      ...(overrides.quality ?? {})
    },
    valid: overrides.valid !== false
  });
}

/** Run a sequence of epochs, returning the final assessment. */
function run(engine, environment, epochs) {
  let result = null;
  for (const epoch of epochs) {
    result = engine.evaluate({
      message: epoch.message,
      time: epoch.time,
      fused: epoch.fused,
      deadReckoning: epoch.deadReckoning ?? null,
      radar: epoch.radar ?? null,
      lidar: null,
      bathymetric: null,
      gyroHeadingDeg: epoch.gyroHeadingDeg ?? 0,
      dvlSpeedMps: epoch.dvlSpeedMps ?? 3,
      gnssCurrentlyExcluded: epoch.excluded ?? false
    });
  }
  return result;
}

describe('healthy GNSS', () => {
  it('is not falsely rejected over a long healthy run', () => {
    const { engine, environment } = makeEngine();
    const epochs = [];
    for (let i = 0; i < 300; i += 1) {
      const t = i * 0.2;
      const north = t * 3;
      // Realistic sub-metre noise on both the GNSS fix and the fused solution.
      const noise = () => (Math.sin(i * 12.9898) * 43758.5453) % 1;
      epochs.push({
        message: gnssAt(environment, noise() * 0.8, north + noise() * 0.8, t),
        time: t,
        fused: { east: 0, north, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: north, sigma_m: 1.2 },
        deadReckoning: { east_m: 0, north_m: north, sigma_m: 0.5, speed_mps: 3, bottom_lock: true }
      });
    }
    const result = run(engine, environment, epochs);

    expect(result.trust_score).toBeGreaterThanOrEqual(76);
    expect(result.status).toBe('TRUSTED');
    expect(result.recommended_action).toBe(GnssAction.USE_IN_FUSION);
    expect(result.detected_conditions).toHaveLength(0);
    expect(result.spoofing_suspected).toBe(false);
  });
});

describe('sudden position jump', () => {
  it('is detected and GNSS is excluded', () => {
    const { engine, environment } = makeEngine();
    const epochs = [];
    for (let i = 0; i < 30; i += 1) {
      const t = i * 0.2;
      epochs.push({
        message: gnssAt(environment, 0, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 }
      });
    }
    // A 50 m jump east, with the independent sources unchanged.
    for (let i = 30; i < 36; i += 1) {
      const t = i * 0.2;
      epochs.push({
        message: gnssAt(environment, 50, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 }
      });
    }
    const result = run(engine, environment, epochs);

    expect(result.detected_conditions).toContain(GnssCondition.RADAR_POSITION_DISAGREEMENT);
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);
    expect(result.spoofing_suspected).toBe(true);
    expect(result.trust_score).toBeLessThanOrEqual(50);
    expect(result.explanation).toMatch(/radar/i);
  });
});

describe('gradual spoofing drag', () => {
  it('is detected well before the offset reaches 20 m', () => {
    const { engine, environment } = makeEngine();
    const cfg = getConfig().gnss_integrity;
    let detectedAtOffset = null;

    for (let i = 0; i < 400; i += 1) {
      const t = i * 0.2;
      // Drag at 0.1 m/s, the specification's scenario 3.
      const dragOffset = Math.max(0, (t - 20) * 0.1);
      const result = engine.evaluate({
        message: gnssAt(environment, dragOffset, t * 3, t),
        time: t,
        fused: { east: dragOffset * 0.3, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        deadReckoning: { east_m: 0, north_m: t * 3, sigma_m: 0.6, speed_mps: 3, bottom_lock: true },
        gyroHeadingDeg: 0,
        dvlSpeedMps: 3,
        gnssCurrentlyExcluded: false
      });
      if (detectedAtOffset === null && result.recommended_action === GnssAction.EXCLUDE_FROM_FUSION) {
        detectedAtOffset = dragOffset;
      }
    }

    expect(detectedAtOffset).not.toBeNull();
    expect(detectedAtOffset).toBeLessThan(20);
    expect(cfg.drag_min_offset_m).toBeLessThan(20);
  });
});

describe('frozen coordinates', () => {
  it('are detected while the DVL shows the vessel making way', () => {
    const { engine, environment } = makeEngine();
    let result = null;
    for (let i = 0; i < 120; i += 1) {
      const t = i * 0.2;
      // Position frozen at the origin; DVL reports 3 m/s throughout.
      result = engine.evaluate({
        message: gnssAt(environment, 0, 0, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.5 },
        radar: null,
        deadReckoning: { east_m: 0, north_m: t * 3, sigma_m: 0.6, speed_mps: 3, bottom_lock: true },
        gyroHeadingDeg: 0,
        dvlSpeedMps: 3,
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.detected_conditions).toContain(GnssCondition.FROZEN_COORDINATES);
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);
    expect(result.explanation).toMatch(/frozen/i);
  });

  it('are NOT reported when the vessel is genuinely stationary', () => {
    const { engine, environment } = makeEngine();
    let result = null;
    for (let i = 0; i < 120; i += 1) {
      const t = i * 0.2;
      result = engine.evaluate({
        message: gnssAt(environment, 0, 0, t),
        time: t,
        fused: { east: 0, north: 0, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: 0, sigma_m: 1.2 },
        deadReckoning: { east_m: 0, north_m: 0, sigma_m: 0.4, speed_mps: 0, bottom_lock: true },
        gyroHeadingDeg: 0,
        dvlSpeedMps: 0,
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.detected_conditions).not.toContain(GnssCondition.FROZEN_COORDINATES);
  });
});

describe('degraded signal metrics', () => {
  it('are detected when C/N0 collapses and satellites drop out', () => {
    const { engine, environment } = makeEngine();
    let result = null;
    for (let i = 0; i < 40; i += 1) {
      const t = i * 0.2;
      const jammed = i > 10;
      result = engine.evaluate({
        message: gnssAt(environment, 0, t * 3, t, {
          quality: jammed
            ? { satellites: 3, cn0_mean_dbhz: 24, hdop: 9.5, pdop: 12, fix_type: 'SPS' }
            : {}
        }),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gyroHeadingDeg: 0,
        dvlSpeedMps: 3,
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.detected_conditions).toEqual(
      expect.arrayContaining([GnssCondition.LOW_SATELLITE_COUNT, GnssCondition.HIGH_DILUTION_OF_PRECISION])
    );
    expect(result.jamming_suspected).toBe(true);
    expect(result.spoofing_suspected).toBe(false);
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);
  });
});

describe('false time', () => {
  it('is detected as a timestamp offset', () => {
    const { engine, environment } = makeEngine();
    let result = null;
    for (let i = 0; i < 20; i += 1) {
      const t = i * 0.2;
      const message = gnssAt(environment, 0, t * 3, t);
      if (i > 5) {
        // Timestamp four seconds ahead of true UTC.
        message.timestamp_utc = new Date(EPOCH_MS + (t + 4) * 1000).toISOString();
      }
      result = engine.evaluate({
        message,
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gyroHeadingDeg: 0,
        dvlSpeedMps: 3,
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.detected_conditions).toContain(GnssCondition.GNSS_TIME_JUMP);
    expect(Math.abs(result.diagnostics.time_offset_s)).toBeGreaterThan(3);
  });
});

describe('no fix', () => {
  it('is rejected outright', () => {
    const { engine, environment } = makeEngine();
    const message = gnssAt(environment, 0, 0, 1, { quality: { fix_type: 'NO_FIX', satellites: 2 }, valid: false });
    const result = engine.evaluate({
      message,
      time: 1,
      fused: { east: 0, north: 0, sigmaM: 0.4 },
      gnssCurrentlyExcluded: false
    });
    expect(result.detected_conditions).toContain(GnssCondition.NO_FIX);
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);
    expect(result.status).toBe('REJECTED');
  });

  it('reports signal loss when no message arrives at all', () => {
    const { engine } = makeEngine();
    let result = null;
    for (let i = 0; i < 10; i += 1) {
      result = engine.evaluate({ message: null, time: i * 0.2, fused: { east: 0, north: 0, sigmaM: 0.4 } });
    }
    expect(result.detected_conditions).toContain(GnssCondition.SIGNAL_LOST);
    expect(result.explanation).toMatch(/signal has been lost/i);
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);
  });
});

describe('position on land', () => {
  it('is treated as impossible', () => {
    const { engine, environment } = makeEngine();
    // The mainland polygon sits south of the origin in the synthetic harbour.
    const onLand = environment.frame.toGeodetic(0, -2500);
    const message = buildSensorMessage({
      sensorId: 'GNSS_01',
      sensorType: SensorType.GNSS,
      timestampUtc: new Date(EPOCH_MS + 1000).toISOString(),
      sequenceNumber: 5,
      position: { latitude: onLand.latitude, longitude: onLand.longitude, altitude_m: 0 },
      velocity: { north_mps: 0, east_mps: 0, down_mps: 0 },
      quality: { satellites: 12, hdop: 0.9, cn0_mean_dbhz: 44, fix_type: 'SPS', reported_accuracy_m: 2 },
      valid: true
    });
    let result = null;
    for (let i = 0; i < 5; i += 1) {
      result = engine.evaluate({
        message,
        time: 1 + i * 0.2,
        fused: { east: 0, north: 0, sigmaM: 0.5 },
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.detected_conditions).toContain(GnssCondition.POSITION_CROSSING_LAND);
    expect(result.trust_score).toBe(0);
  });
});

describe('recovery validation', () => {
  it('holds GNSS out for the full validation window after a rejection', () => {
    const { engine, environment } = makeEngine();
    const validationS = getConfig().gnss_integrity.recovery_validation_s;

    // Healthy, then a jump that gets it rejected.
    for (let i = 0; i < 40; i += 1) {
      const t = i * 0.2;
      engine.evaluate({
        message: gnssAt(environment, 0, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: false
      });
    }
    let result = null;
    for (let i = 40; i < 60; i += 1) {
      const t = i * 0.2;
      result = engine.evaluate({
        message: gnssAt(environment, 60, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: false
      });
    }
    expect(result.recommended_action).toBe(GnssAction.EXCLUDE_FROM_FUSION);

    // GNSS returns clean. It must be held for the whole validation window.
    const startT = 12;
    const heldActions = [];
    let completedAt = null;
    for (let i = 0; i < 250; i += 1) {
      const t = startT + i * 0.2;
      result = engine.evaluate({
        message: gnssAt(environment, 0, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: result.recommended_action !== GnssAction.USE_IN_FUSION
      });
      heldActions.push({ t, action: result.recommended_action });
      if (completedAt === null && result.recommended_action === GnssAction.USE_IN_FUSION) completedAt = t;
    }

    expect(completedAt).not.toBeNull();
    const heldFor = completedAt - startT;
    expect(heldFor).toBeGreaterThanOrEqual(validationS);
    // While held, the action must be HOLD_FOR_VALIDATION, not USE.
    const duringWindow = heldActions.filter((h) => h.t < startT + validationS - 1);
    expect(duringWindow.every((h) => h.action !== GnssAction.USE_IN_FUSION)).toBe(true);
  });

  it('restarts the validation window if an anomaly reappears', () => {
    const { engine, environment } = makeEngine();
    // Establish a valid fix, then reject.
    for (let i = 0; i < 30; i += 1) {
      const t = i * 0.2;
      engine.evaluate({
        message: gnssAt(environment, 0, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: false
      });
    }
    for (let i = 30; i < 45; i += 1) {
      const t = i * 0.2;
      engine.evaluate({
        message: gnssAt(environment, 80, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: false
      });
    }
    // Ten seconds of clean data starts the window.
    let result = null;
    for (let i = 0; i < 50; i += 1) {
      const t = 9 + i * 0.2;
      result = engine.evaluate({
        message: gnssAt(environment, 0, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: true
      });
    }
    const progressBefore = result.recovery?.elapsed_s ?? 0;
    expect(progressBefore).toBeGreaterThan(5);

    // A fresh anomaly must reset the window.
    for (let i = 0; i < 6; i += 1) {
      const t = 19 + i * 0.2;
      result = engine.evaluate({
        message: gnssAt(environment, 90, t * 3, t),
        time: t,
        fused: { east: 0, north: t * 3, sigmaM: 0.4 },
        radar: { valid: true, east_m: 0, north_m: t * 3, sigma_m: 1.2 },
        gnssCurrentlyExcluded: true
      });
    }
    expect(result.recovery).toBeNull();
  });
});
