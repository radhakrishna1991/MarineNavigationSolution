/**
 * Fusion tests (Section 24 "Fusion").
 */

import { ExtendedKalmanFilter, S_EAST, S_NORTH, S_HEADING } from '../src/navigation/fusion/ekf.js';
import { FusionEngine } from '../src/navigation/fusion/fusionEngine.js';
import { FaultDetectionEngine } from '../src/navigation/faultDetection.js';
import { BathymetricMatchingEngine } from '../src/navigation/bathymetricMatching.js';
import { DeadReckoningEngine } from '../src/navigation/deadReckoning.js';
import { createRadarEngine } from '../src/navigation/radarMatching.js';
import { buildEnvironment } from '../src/geospatial/environment.js';
import { getConfig, sensorCatalog } from '../src/config/index.js';
import { SensorType } from '../src/models/enums.js';

const environment = buildEnvironment();

function makeFilter() {
  const cfg = getConfig().fusion;
  const filter = new ExtendedKalmanFilter({
    processNoise: cfg.process_noise,
    initialUncertainty: cfg.initial_uncertainty
  });
  filter.initialize({ east: 0, north: 0, velocityEast: 0, velocityNorth: 3, headingRad: 0, time: 0 });
  return filter;
}

describe('extended Kalman filter', () => {
  it('propagates position from velocity', () => {
    const filter = makeFilter();
    filter.predict(1.0);
    expect(filter.north).toBeCloseTo(3, 5);
    expect(filter.east).toBeCloseTo(0, 5);
  });

  it('grows position uncertainty during prediction and shrinks it on update', () => {
    const filter = makeFilter();
    const before = filter.positionEllipse().major;
    for (let i = 0; i < 20; i += 1) filter.predict(0.2);
    const afterPredict = filter.positionEllipse().major;
    expect(afterPredict).toBeGreaterThan(before);

    filter.updatePosition(filter.east, filter.north, [[0.25, 0], [0, 0.25]], 0.001, true);
    const afterUpdate = filter.positionEllipse().major;
    expect(afterUpdate).toBeLessThan(afterPredict);
  });

  it('weights a precise measurement more than a noisy one', () => {
    const precise = makeFilter();
    const noisy = makeFilter();
    for (const f of [precise, noisy]) for (let i = 0; i < 10; i += 1) f.predict(0.2);

    // A modest offset, well inside the gate for both, so the comparison is
    // about weighting rather than about one of them being rejected.
    const target = 1.0;
    precise.updatePosition(target, precise.north, [[0.04, 0], [0, 0.04]], 0.001, true);
    noisy.updatePosition(target, noisy.north, [[100, 0], [0, 100]], 0.001, true);

    // The precise measurement should pull the state much closer to itself.
    expect(Math.abs(precise.east - target)).toBeLessThan(Math.abs(noisy.east - target));
    expect(precise.positionEllipse().major).toBeLessThan(noisy.positionEllipse().major);
  });

  it('gates an outlier out instead of applying it', () => {
    const filter = makeFilter();
    for (let i = 0; i < 5; i += 1) filter.predict(0.2);
    const eastBefore = filter.east;
    const diagnostics = filter.updatePosition(filter.east + 500, filter.north, [[1, 0], [0, 1]], 0.001, true);

    expect(diagnostics.gatePassed).toBe(false);
    expect(diagnostics.applied).toBe(false);
    expect(filter.east).toBeCloseTo(eastBefore, 6);
    expect(diagnostics.normalizedInnovation).toBeGreaterThan(5);
  });

  it('estimates a gyrocompass bias from an absolute heading reference', () => {
    const filter = makeFilter();
    const biasRad = (2 * Math.PI) / 180;
    for (let i = 0; i < 400; i += 1) {
      filter.predict(0.2, { headingRateDps: 0, headingRateSigmaDps: 0.1 });
      // Gyro reads true heading plus a constant bias.
      filter.updateHeading(0 + biasRad, ((0.35 * Math.PI) / 180) ** 2, 0.01, true, true);
      // Radar provides the unbiased absolute heading.
      filter.updateHeading(0, ((1.2 * Math.PI) / 180) ** 2, 0.01, false, true);
    }
    expect(filter.x[S_HEADING]).toBeCloseTo(0, 2);
    expect(filter.gyroBiasDeg).toBeGreaterThan(1.0);
    expect(filter.gyroBiasDeg).toBeLessThan(3.0);
  });

  it('keeps the covariance symmetric and positive', () => {
    const filter = makeFilter();
    for (let i = 0; i < 100; i += 1) {
      filter.predict(0.2);
      filter.updatePosition(filter.east + 0.3, filter.north - 0.2, [[1, 0], [0, 1]], 0.001, true);
    }
    const p = filter.P;
    for (let i = 0; i < p.length; i += 1) {
      expect(p[i][i]).toBeGreaterThan(0);
      for (let j = 0; j < p.length; j += 1) {
        expect(Math.abs(p[i][j] - p[j][i])).toBeLessThan(1e-9);
      }
    }
  });

  it('follows a turn when the measured rate of turn is supplied', () => {
    const withRate = makeFilter();
    const withoutRate = makeFilter();
    const rateDps = 8;
    for (let i = 0; i < 25; i += 1) {
      withRate.predict(0.2, { headingRateDps: rateDps, headingRateSigmaDps: 0.1 });
      withoutRate.predict(0.2);
    }
    // 25 steps of 0.2 s at 8 deg/s is a 40-degree alteration of course.
    expect(withRate.headingDeg).toBeCloseTo(40, 0);
    expect(withoutRate.headingDeg).toBeCloseTo(0, 3);
  });
});

describe('fusion engine', () => {
  it('records which sensors contributed and which were rejected', () => {
    const fusion = new FusionEngine({ environment });
    fusion.beginEpoch(0);
    fusion.applyPosition({ sensorId: 'RADAR_01', sensorType: SensorType.RADAR, east: 0, north: 0, covariance: null });
    fusion.beginEpoch(1);
    fusion.applyPosition({ sensorId: 'RADAR_01', sensorType: SensorType.RADAR, east: 0.2, north: 0.1, covariance: null });
    fusion.applyPosition({ sensorId: 'GNSS_01', sensorType: SensorType.GNSS, east: 400, north: 0, covariance: null });

    expect(fusion.contributingSensors()).toContain('RADAR_01');
    expect(fusion.rejectedSensors()).toContain('GNSS_01');
  });

  it('applies a runtime de-weighting factor to the measurement covariance', () => {
    const fusion = new FusionEngine({ environment });
    const plain = fusion.positionCovarianceFor('GNSS_01', SensorType.GNSS, null, 1);
    const deweighted = fusion.positionCovarianceFor('GNSS_01', SensorType.GNSS, null, 4);
    expect(deweighted[0][0]).toBeCloseTo(plain[0][0] * 16, 6);
  });

  it('never trusts a reported sigma below the configured floor', () => {
    const fusion = new FusionEngine({ environment });
    const floor = getConfig().fusion.measurement_noise.GNSS.position_sigma_m;
    const cov = fusion.positionCovarianceFor('GNSS_01', SensorType.GNSS, [[0.0001, 0], [0, 0.0001]], 1);
    expect(Math.sqrt(cov[0][0])).toBeGreaterThanOrEqual(floor - 1e-9);
  });

  it('resets onto a trusted absolute source after persistent divergence', () => {
    const fusion = new FusionEngine({ environment });
    fusion.beginEpoch(0);
    fusion.applyPosition({ sensorId: 'RADAR_01', sensorType: SensorType.RADAR, east: 0, north: 0, covariance: null });

    // Feed a source that is consistently far from the filter's belief.
    for (let i = 1; i <= 10; i += 1) {
      fusion.beginEpoch(i * 0.2);
      fusion.applyPosition({
        sensorId: 'RADAR_01',
        sensorType: SensorType.RADAR,
        east: 300,
        north: 0,
        covariance: [[1, 0], [0, 1]]
      });
    }
    expect(fusion.resets.length).toBeGreaterThan(0);
    expect(fusion.resets[0].reason).toMatch(/gated out/i);
    expect(fusion.filter.east).toBeGreaterThan(200);
  });
});

describe('fault detection', () => {
  const makeDetector = () => new FaultDetectionEngine({ sensorDefinitions: sensorCatalog });

  it('rejects a duplicate sequence number', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));
    const message = {
      sensor_id: 'GYRO_01',
      sensor_type: 'GYRO',
      timestamp_utc: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      sequence_number: 7,
      heading_deg: 10,
      quality: {},
      valid: true
    };
    expect(detector.observeMessage({ ...message }, 0).accept).toBe(true);
    const second = detector.observeMessage({ ...message }, 0.05);
    expect(second.accept).toBe(false);
    expect(second.faults).toContain('DUPLICATE_MESSAGE');
  });

  it('rejects an out-of-order timestamp', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));
    const base = Date.UTC(2024, 0, 1);
    detector.observeMessage(
      { sensor_id: 'DVL_01', sensor_type: 'DVL', timestamp_utc: new Date(base + 2000).toISOString(), sequence_number: 1, quality: {}, valid: true },
      2
    );
    const result = detector.observeMessage(
      { sensor_id: 'DVL_01', sensor_type: 'DVL', timestamp_utc: new Date(base + 500).toISOString(), sequence_number: 2, quality: {}, valid: true },
      2.1
    );
    expect(result.accept).toBe(false);
    expect(result.faults).toContain('OUT_OF_ORDER');
  });

  it('rejects a stale measurement', () => {
    const detector = makeDetector();
    const base = Date.UTC(2024, 0, 1);
    detector.setEpoch(base);
    const result = detector.observeMessage(
      { sensor_id: 'RADAR_01', sensor_type: 'RADAR', timestamp_utc: new Date(base).toISOString(), sequence_number: 1, quality: {}, valid: true },
      10
    );
    expect(result.accept).toBe(false);
    expect(result.faults).toContain('STALE_DATA');
  });

  it('detects a frozen sensor value', () => {
    const detector = makeDetector();
    const base = Date.UTC(2024, 0, 1);
    detector.setEpoch(base);
    let result = null;
    for (let i = 0; i < 20; i += 1) {
      result = detector.observeMessage(
        {
          sensor_id: 'DVL_01',
          sensor_type: 'DVL',
          timestamp_utc: new Date(base + i * 100).toISOString(),
          sequence_number: i,
          velocity: { north_mps: 3, east_mps: 0, down_mps: 0 },
          quality: { bottom_lock: true },
          valid: true
        },
        i * 0.1
      );
    }
    expect(result.faults).toContain('FROZEN_VALUE');
    expect(result.accept).toBe(false);
  });

  it('flags loss of bottom lock', () => {
    const detector = makeDetector();
    const base = Date.UTC(2024, 0, 1);
    detector.setEpoch(base);
    const result = detector.observeMessage(
      {
        sensor_id: 'DVL_01',
        sensor_type: 'DVL',
        timestamp_utc: new Date(base).toISOString(),
        sequence_number: 1,
        velocity: { north_mps: 0, east_mps: 0, down_mps: 0 },
        quality: { bottom_lock: false, status: 'NO_BOTTOM_LOCK' },
        valid: false
      },
      0
    );
    expect(result.accept).toBe(false);
    expect(result.faults).toContain('LOSS_OF_BOTTOM_LOCK');
  });

  it('excludes a sensor whose residuals are persistently inconsistent, then reintegrates it', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));

    // Feed large, consistent residuals.
    for (let i = 0; i < 60; i += 1) {
      detector.recordResidual('RADAR_01', 'POSITION', {
        innovationNorm: 20,
        normalizedInnovation: 9,
        innovation: [20, 0],
        measurement_sigma_m: 1.2,
        gatePassed: false,
        applied: false
      });
    }
    const findings = detector.evaluate(10);
    expect(detector.isExcluded('RADAR_01')).toBe(true);
    const exclusion = findings.find((f) => f.sensor_id === 'RADAR_01' && f.action === 'EXCLUDED');
    expect(exclusion).toBeDefined();
    expect(exclusion.explanation).toMatch(/RADAR_01/);

    // Behave well again: after the quiet period it should come back.
    const fusionCfg = getConfig().fusion;
    let reintegrated = false;
    for (let epoch = 0; epoch < 40; epoch += 1) {
      const t = 10 + fusionCfg.sensor_reentry_delay_s + epoch;
      detector.observeMessage(
        {
          sensor_id: 'RADAR_01',
          sensor_type: 'RADAR',
          timestamp_utc: new Date(Date.UTC(2024, 0, 1) + t * 1000).toISOString(),
          sequence_number: 1000 + epoch,
          position: { latitude: 24.5, longitude: 54.3, altitude_m: 0 },
          quality: {},
          valid: true
        },
        t
      );
      const result = detector.evaluate(t);
      if (result.some((f) => f.action === 'REINTEGRATED')) reintegrated = true;
    }
    expect(reintegrated).toBe(true);
    expect(detector.isExcluded('RADAR_01')).toBe(false);
  });

  it('does not exclude a sensor merely for being offline', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));
    detector.observeMessage(
      {
        sensor_id: 'LIDAR_01',
        sensor_type: 'LIDAR',
        timestamp_utc: new Date(Date.UTC(2024, 0, 1)).toISOString(),
        sequence_number: 1,
        position: { latitude: 24.5, longitude: 54.3, altitude_m: 0 },
        quality: {},
        valid: true
      },
      0
    );
    detector.evaluate(60);
    const snapshot = detector.snapshot(60).find((s) => s.sensor_id === 'LIDAR_01');
    expect(snapshot.online).toBe(false);
    expect(snapshot.excluded).toBe(false);
  });

  it('holds exclusions while a suspect source is still contributing', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));
    for (let i = 0; i < 60; i += 1) {
      detector.recordResidual('RADAR_01', 'POSITION', {
        innovationNorm: 20,
        normalizedInnovation: 9,
        innovation: [20, 0],
        measurement_sigma_m: 1.2,
        gatePassed: false,
        applied: false
      });
    }
    const findings = detector.evaluate(10, new Set(), {
      isolationHold: true,
      isolationReason: 'GNSS is under suspicion'
    });
    expect(detector.isExcluded('RADAR_01')).toBe(false);
    expect(findings.some((f) => f.action === 'EXCLUSION_HELD')).toBe(true);
  });

  it('retains rather than excludes the last remaining absolute source', () => {
    const detector = makeDetector();
    detector.setEpoch(Date.UTC(2024, 0, 1));
    for (let i = 0; i < 60; i += 1) {
      detector.recordResidual('RADAR_01', 'POSITION', {
        innovationNorm: 20,
        normalizedInnovation: 9,
        innovation: [20, 0],
        measurement_sigma_m: 1.2,
        gatePassed: false,
        applied: false
      });
    }
    const findings = detector.evaluate(10, new Set(['RADAR_01']));
    expect(detector.isExcluded('RADAR_01')).toBe(false);
    const finding = findings.find((f) => f.action === 'RETAINED_UNDER_PROTEST');
    expect(finding).toBeDefined();
    expect(finding.explanation).toMatch(/only remaining absolute position source/i);
  });
});

describe('bathymetric terrain matching', () => {
  it('reports ambiguity rather than a confident fix over featureless seabed', () => {
    const engine = new BathymetricMatchingEngine({ environment });
    // The dredged spoil ground in the synthetic harbour is deliberately flat.
    const flat = environment.flatZone.centre;
    for (let i = 0; i < 30; i += 1) {
      engine.addObservation({
        time: i * 1.0,
        depthBelowTransducerM: 13.8,
        transducerOffsetM: 1.8,
        tideM: 0,
        squatM: 0,
        east: flat[0] + i * 3,
        north: flat[1]
      });
    }
    const result = engine.match({ east: flat[0] + 87, north: flat[1], sigmaM: 3 }, 30);
    expect(result.valid).toBe(false);
    expect(['TERRAIN_NOT_OBSERVABLE', 'AMBIGUOUS_MULTIPLE_CANDIDATES']).toContain(result.reason);
    expect(result.ambiguity_score).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(0.3);
  });

  it('refuses to match without enough depth history', () => {
    const engine = new BathymetricMatchingEngine({ environment });
    engine.addObservation({
      time: 0,
      depthBelowTransducerM: 12,
      transducerOffsetM: 1.8,
      tideM: 0,
      squatM: 0,
      east: 0,
      north: 0
    });
    const result = engine.match({ east: 0, north: 0, sigmaM: 3 }, 1);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INSUFFICIENT_DEPTH_HISTORY');
  });

  it('returns a candidate surface that can be inspected', () => {
    const engine = new BathymetricMatchingEngine({ environment });
    for (let i = 0; i < 30; i += 1) {
      engine.addObservation({
        time: i,
        depthBelowTransducerM: 11 + Math.sin(i / 3),
        transducerOffsetM: 1.8,
        tideM: 0,
        squatM: 0,
        east: 1500 + i * 4,
        north: 600
      });
    }
    const result = engine.match({ east: 1500 + 29 * 4, north: 600, sigmaM: 5 }, 30);
    expect(result.candidate_count).toBeGreaterThan(100);
    expect(Array.isArray(result.top_candidates)).toBe(true);
    expect(result.top_candidates.length).toBeGreaterThan(0);
    expect(result.terrain_observability).toBeGreaterThanOrEqual(0);
  });
});

describe('dead reckoning', () => {
  it('grows uncertainty over time when no absolute update arrives', () => {
    const dr = new DeadReckoningEngine({ environment });
    dr.anchor(0, 0, 0.5, 0, 0);
    const samples = [];
    for (let i = 1; i <= 300; i += 1) {
      const state = dr.propagate({ time: i, headingDeg: 0, forwardMps: 3, bottomLock: true });
      samples.push(state.sigma_m);
    }
    expect(samples[299]).toBeGreaterThan(samples[0]);
    expect(samples[299]).toBeGreaterThan(samples[149]);
    // Monotone growth: uncertainty must never shrink without an update.
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9);
  });

  it('grows faster after losing bottom lock', () => {
    const withLock = new DeadReckoningEngine({ environment });
    const withoutLock = new DeadReckoningEngine({ environment });
    withLock.anchor(0, 0, 0.5, 0, 0);
    withoutLock.anchor(0, 0, 0.5, 0, 0);
    for (let i = 1; i <= 120; i += 1) {
      withLock.propagate({ time: i, headingDeg: 0, forwardMps: 3, bottomLock: true });
      withoutLock.propagate({ time: i, headingDeg: 0, forwardMps: 3, bottomLock: false });
    }
    expect(withoutLock.sigmaM).toBeGreaterThan(withLock.sigmaM);
  });

  it('names the dominant error source', () => {
    const dr = new DeadReckoningEngine({ environment });
    dr.anchor(0, 0, 0.5, 0, 0);
    for (let i = 1; i <= 600; i += 1) dr.propagate({ time: i, headingDeg: 0, forwardMps: 5, bottomLock: true });
    expect(['HEADING_BIAS', 'SPEED_SCALE_ERROR', 'VELOCITY_RANDOM_WALK']).toContain(dr.dominantErrorSource());
  });

  it('reports the remaining unassisted time', () => {
    const dr = new DeadReckoningEngine({ environment });
    dr.anchor(0, 0, 0.5, 0, 0);
    dr.propagate({ time: 30, headingDeg: 0, forwardMps: 3, bottomLock: true });
    const limit = getConfig().dead_reckoning.maximum_unassisted_duration_s;
    expect(dr.remainingUnassistedS()).toBeCloseTo(limit - 30, 3);
  });
});

describe('radar map matching', () => {
  it('runs independent scan matching against the stored reference cloud', () => {
    const engine = createRadarEngine(environment);
    // Build a synthetic scan from the reference map, seen from a known pose.
    const truth = { east: 200, north: 300, headingRad: 0.35 };
    const inRange = environment.radarPoints.filter((p) => {
      const range = Math.hypot(p.e - truth.east, p.n - truth.north);
      return range <= 2500 && range >= 20;
    });
    // Decimate uniformly across the whole in-range set, exactly as the sensor
    // adapter does. Taking a contiguous run of shoreline points instead would
    // give a scan that can slide along the coast, which is a property of the
    // sampling, not of the matcher.
    const step = Math.max(1, Math.ceil(inRange.length / 140));
    const c = Math.cos(truth.headingRad);
    const s = Math.sin(truth.headingRad);
    const scan = [];
    for (let i = 0; i < inRange.length; i += step) {
      const de = inRange[i].e - truth.east;
      const dn = inRange[i].n - truth.north;
      scan.push([dn * c + de * s, de * c - dn * s]);
    }
    expect(scan.length).toBeGreaterThan(30);

    const message = {
      sensor_id: 'RADAR_01',
      sensor_type: 'RADAR',
      timestamp_utc: new Date().toISOString(),
      position: null,
      quality: {},
      valid: true,
      raw: { point_cloud: scan }
    };
    // Seed the matcher a few metres away from the true pose.
    const result = engine.process(message, { east: truth.east + 6, north: truth.north - 5, headingRad: truth.headingRad + 0.02 });

    expect(result.mode_b).toBeDefined();
    expect(result.mode_b.valid).toBe(true);
    expect(Math.hypot(result.mode_b.east_m - truth.east, result.mode_b.north_m - truth.north)).toBeLessThan(3);
    expect(result.selected_mode).toBe('MODE_B');
  });

  it('falls back to the vendor fix when there is no usable point cloud', () => {
    const engine = createRadarEngine(environment);
    const geo = environment.frame.toGeodetic(120, 250);
    const message = {
      sensor_id: 'RADAR_01',
      sensor_type: 'RADAR',
      timestamp_utc: new Date().toISOString(),
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 0 },
      quality: { confidence: 0.8, match_score: 0.8, position_covariance: [1.5, 0, 0, 1.5] },
      valid: true,
      raw: {}
    };
    const result = engine.process(message, { east: 120, north: 250, headingRad: 0 });
    expect(result.selected_mode).toBe('MODE_A');
    expect(result.valid).toBe(true);
    expect(result.selection_reason).toMatch(/NO_POINT_CLOUD/);
  });
});
