/**
 * Simulated sensor adapters (Section 7 and Section 16).
 *
 * Each class models one instrument: its update rate, its noise, its slowly
 * wandering biases, its latency and its quality reporting. Every one of them
 * emits the standard internal sensor message, so from the ingestion layer
 * downwards there is no way to tell a simulated sensor from a real one.
 *
 * All randomness comes from a seeded generator, so a scenario replays exactly.
 */

import { buildSensorMessage } from '../models/sensorMessage.js';
import { SensorType } from '../models/enums.js';
import { Rng, GaussMarkov } from '../utils/random.js';
import { normalizeHeading, neToCourseSpeed } from '../utils/geo.js';
import { trueDepthAt, sampleGridDepth } from '../geospatial/environment.js';
import { applyGnssFaults, applyMessageFaults } from './faults.js';

/**
 * Base class handling rate scheduling, sequence numbers and message-level
 * fault application. Subclasses implement `measure()`.
 */
export class SimulatedSensor {
  /**
   * @param {object} definition entry from sensors.yaml
   * @param {object} ctx { rng, environment, injector }
   */
  constructor(definition, ctx) {
    this.def = definition;
    this.id = definition.sensor_id;
    this.type = definition.sensor_type;
    this.rateHz = definition.rate_hz || 1;
    this.sim = definition.simulation || {};
    this.env = ctx.environment;
    this.injector = ctx.injector;
    this.rng = ctx.rng.fork(definition.sensor_id);
    this.sequence = 0;
    this.accumulator = 0;
    this.enabled = true;
    this.lastEmitTime = null;
  }

  reset() {
    this.rng.reset();
    this.sequence = 0;
    this.accumulator = 0;
    this.lastEmitTime = null;
  }

  /** Nominal interval between messages, seconds. */
  get interval() {
    return 1 / this.rateHz;
  }

  /**
   * Advance the sensor clock and produce zero or more scheduled messages.
   * @param {number} t simulation time at the end of the step
   * @param {number} dt step length
   * @param {object} truth ground-truth state
   * @returns {{ message: object, deliverAtS: number }[]}
   */
  tick(t, dt, truth) {
    if (!this.enabled) return [];
    this.accumulator += dt;
    const out = [];
    // Guard against a huge dt (e.g. after a pause) flooding the queue.
    let budget = 20;
    while (this.accumulator >= this.interval && budget > 0) {
      this.accumulator -= this.interval;
      budget -= 1;
      const sampleTime = t - this.accumulator;
      const faults = this.injector.activeFor(this.id, sampleTime);
      const built = this.measure(sampleTime, dt, truth, faults);
      if (!built) continue;
      this.sequence += 1;
      const message = { ...built, sequence_number: this.sequence };
      const latencyS = (this.sim.latency_ms || 0) / 1000;
      const result = applyMessageFaults(message, faults, this.injector, sampleTime + latencyS, this.rng);
      for (const item of result.deliver) out.push(item);
      this.lastEmitTime = sampleTime;
    }
    return out;
  }

  /** Build an ISO timestamp for a simulation time. */
  stamp(t, offsetS = 0) {
    return new Date(this.epochMs + (t + offsetS) * 1000).toISOString();
  }

  /** Set by the engine so every sensor shares one wall-clock epoch. */
  setEpoch(epochMs) {
    this.epochMs = epochMs;
  }

  /** @abstract */
  // eslint-disable-next-line no-unused-vars
  measure(t, dt, truth, faults) {
    throw new Error(`${this.constructor.name} must implement measure()`);
  }
}

// ---------------------------------------------------------------------------
// GNSS
// ---------------------------------------------------------------------------

export class GnssSensor extends SimulatedSensor {
  constructor(def, ctx) {
    super(def, ctx);
    this.bias = new GaussMarkov(this.rng.fork('bias'), this.sim.bias_tau_s ?? 300, this.sim.bias_sigma_m ?? 0.35);
    this.biasNorth = new GaussMarkov(this.rng.fork('biasN'), this.sim.bias_tau_s ?? 300, this.sim.bias_sigma_m ?? 0.35);
  }

  reset() {
    super.reset();
    this.bias.reset();
    this.biasNorth.reset();
  }

  measure(t, dt, truth, faults) {
    const obs = {
      east: truth.east_m,
      north: truth.north_m,
      vNorth: truth.velocity_north_mps,
      vEast: truth.velocity_east_mps,
      timeOffsetS: 0,
      suppressed: false,
      noiseMultiplier: 1,
      jammingSeverity: 0,
      spoofed: false
    };

    applyGnssFaults(obs, faults, this.injector, t, this.interval);
    if (obs.suppressed) return null;

    const severity = obs.jammingSeverity;
    // Interference degrades the signal long before the fix disappears.
    const noiseScale = obs.noiseMultiplier * (1 + severity * 14);
    const sigma = (this.sim.position_sigma_m ?? 0.8) * noiseScale;

    this.bias.step(this.interval);
    this.biasNorth.step(this.interval);

    const east = obs.east + this.bias.value + this.rng.normal(0, sigma);
    const north = obs.north + this.biasNorth.value + this.rng.normal(0, sigma);
    const geo = this.env.frame.toGeodetic(east, north);

    const velSigma = (this.sim.velocity_sigma_mps ?? 0.08) * noiseScale;
    const satellites = Math.max(0, Math.round((this.sim.nominal_satellites ?? 14) * (1 - severity * 0.85) + this.rng.normal(0, 0.4)));
    const cn0 = Math.max(18, (this.sim.nominal_cn0_dbhz ?? 45) - severity * 22 + this.rng.normal(0, 0.6));
    const hdop = (this.sim.nominal_hdop ?? 0.8) * (1 + severity * 9) + Math.abs(this.rng.normal(0, 0.05));

    let fixType = 'RTK_FIXED';
    if (severity > 0.15) fixType = 'DGPS';
    if (severity > 0.45) fixType = 'SPS';
    if (satellites < 4) fixType = 'NO_FIX';

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.GNSS,
      timestampUtc: this.stamp(t, obs.timeOffsetS),
      sequenceNumber: 0,
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 1.6 },
      velocity: {
        north_mps: obs.vNorth + this.rng.normal(0, velSigma),
        east_mps: obs.vEast + this.rng.normal(0, velSigma),
        down_mps: 0
      },
      quality: {
        satellites,
        hdop: Number(hdop.toFixed(2)),
        vdop: Number((hdop * 1.6).toFixed(2)),
        pdop: Number((hdop * 1.9).toFixed(2)),
        cn0_mean_dbhz: Number(cn0.toFixed(1)),
        cn0_min_dbhz: Number(Math.max(15, cn0 - 6 - severity * 4).toFixed(1)),
        fix_type: fixType,
        // A spoofer reports an optimistic accuracy; that inconsistency is one of
        // the things the trust engine looks for.
        reported_accuracy_m: Number((sigma * (obs.spoofed ? 0.35 : 1.6)).toFixed(3)),
        clock_bias_ns: Number((this.rng.normal(0, 12) + (obs.timeOffsetS ? obs.timeOffsetS * 1e9 : 0)).toFixed(1)),
        position_covariance: [sigma * sigma, 0, 0, sigma * sigma],
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        constellation: 'GPS+GAL+BDS',
        // Retained for the audit trail; never used by any engine.
        simulated_truth_offset_m: Number(Math.hypot(east - truth.east_m, north - truth.north_m).toFixed(3))
      },
      valid: fixType !== 'NO_FIX'
    });
  }
}

// ---------------------------------------------------------------------------
// Gyrocompass
// ---------------------------------------------------------------------------

export class GyroSensor extends SimulatedSensor {
  constructor(def, ctx) {
    super(def, ctx);
    this.bias = new GaussMarkov(this.rng.fork('bias'), this.sim.bias_tau_s ?? 900, this.sim.bias_sigma_deg ?? 0.12);
    this.injectedBias = 0;
  }

  reset() {
    super.reset();
    this.bias.reset();
    this.injectedBias = 0;
  }

  measure(t, dt, truth, faults) {
    this.bias.step(this.interval);
    for (const fault of faults) {
      if (fault.type === 'GYRO_BIAS') {
        this.injectedBias = Math.min(
          fault.params.max_bias_deg,
          this.injectedBias + fault.params.rate_deg_per_s * this.interval
        );
      }
    }
    const noise = this.rng.normal(0, this.sim.heading_sigma_deg ?? 0.08);
    const heading = normalizeHeading(truth.heading_deg + this.bias.value + this.injectedBias + noise);
    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.GYRO,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      headingDeg: Number(heading.toFixed(3)),
      quality: {
        heading_sigma_deg: this.sim.heading_sigma_deg ?? 0.08,
        status: 'SETTLED',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        // A gyrocompass is also a rate sensor; the filter uses this to
        // propagate heading through a manoeuvre.
        rate_of_turn_dps: Number((truth.turn_rate_dps + this.rng.normal(0, 0.06)).toFixed(4)),
        rate_of_turn_sigma_dps: 0.06
      },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// Doppler velocity log
// ---------------------------------------------------------------------------

export class DvlSensor extends SimulatedSensor {
  measure(t, dt, truth, faults) {
    let bottomLock = truth.seabed_depth_m <= (this.sim.bottom_lock_max_depth_m ?? 120);
    let scale = 1 + (this.sim.scale_error ?? 0);
    let sigma = this.sim.velocity_sigma_mps ?? 0.012;

    for (const fault of faults) {
      if (fault.type === 'DVL_BOTTOM_LOCK_LOSS') bottomLock = false;
      if (fault.type === 'SPEEDLOG_SCALE_ERROR') scale *= fault.params.scale;
      if (fault.type === 'SENSOR_NOISE') sigma *= fault.params.multiplier;
    }

    // A DVL measures velocity over ground in the *body* frame. The filter is
    // responsible for rotating it using its own heading estimate, which is why
    // the body components are carried in `raw` and used preferentially.
    const forward = truth.speed_mps * scale + this.rng.normal(0, sigma);
    const starboard = this.rng.normal(0, sigma);
    const headingRad = (truth.heading_deg * Math.PI) / 180;

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.DVL,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      velocity: {
        // Convenience projection using true heading; engines use raw body values.
        north_mps: forward * Math.cos(headingRad) - starboard * Math.sin(headingRad),
        east_mps: forward * Math.sin(headingRad) + starboard * Math.cos(headingRad),
        down_mps: 0
      },
      quality: {
        bottom_lock: bottomLock,
        beam_count: bottomLock ? 4 : 0,
        velocity_sigma_mps: Number(sigma.toFixed(5)),
        status: bottomLock ? 'BOTTOM_TRACK' : 'NO_BOTTOM_LOCK',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        forward_mps: Number(forward.toFixed(4)),
        starboard_mps: Number(starboard.toFixed(4)),
        altitude_m: Number(truth.depth_below_transducer_m.toFixed(2))
      },
      valid: bottomLock
    });
  }
}

// ---------------------------------------------------------------------------
// Speed log (through water)
// ---------------------------------------------------------------------------

export class SpeedLogSensor extends SimulatedSensor {
  measure(t, dt, truth, faults) {
    let scale = 1 + (this.sim.scale_error ?? 0);
    let sigma = this.sim.velocity_sigma_mps ?? 0.09;
    for (const fault of faults) {
      if (fault.type === 'SPEEDLOG_SCALE_ERROR') scale *= fault.params.scale;
      if (fault.type === 'SENSOR_NOISE') sigma *= fault.params.multiplier;
    }
    // Speed through water differs from speed over ground by the tidal stream.
    const current = 0.18 * Math.sin(t / 420 + 1.1);
    const forward = (truth.speed_mps + current) * scale + this.rng.normal(0, sigma);
    const headingRad = (truth.heading_deg * Math.PI) / 180;
    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.SPEED_LOG,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      velocity: {
        north_mps: forward * Math.cos(headingRad),
        east_mps: forward * Math.sin(headingRad),
        down_mps: 0
      },
      quality: {
        velocity_sigma_mps: Number(sigma.toFixed(4)),
        status: 'WATER_TRACK',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: { forward_mps: Number(forward.toFixed(4)), reference: 'WATER' },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// Radar and LiDAR localization
// ---------------------------------------------------------------------------

/**
 * Shared behaviour for the two point-cloud localization sensors.
 *
 * Both emit a Mode A fix (position plus covariance) *and* a decimated body
 * frame point cloud so the Mode B scan matcher in the navigation layer can run
 * against the stored reference map (Section 10.1).
 */
class PointCloudLocalizationSensor extends SimulatedSensor {
  constructor(def, ctx, referencePoints) {
    super(def, ctx);
    this.reference = referencePoints;
  }

  /** Features within range of the vessel, with a simple bearing spread metric. */
  visibleFeatures(truth) {
    const maxRange = this.sim.max_range_m ?? 3000;
    const inRange = [];
    let sumSin = 0;
    let sumCos = 0;
    for (const p of this.reference) {
      const de = p.e - truth.east_m;
      const dn = p.n - truth.north_m;
      const range = Math.hypot(de, dn);
      if (range > maxRange || range < 5) continue;
      const bearing = Math.atan2(de, dn);
      // Weight by radar cross-section and inverse range.
      const weight = (p.rcs ?? 0.5) * Math.min(1, (maxRange * 0.35) / range);
      sumSin += Math.sin(2 * bearing) * weight;
      sumCos += Math.cos(2 * bearing) * weight;
      inRange.push({ ...p, range, bearing });
    }
    // Bearing spread: 0 = features clustered in one direction (poor geometry),
    // 1 = features well distributed around the vessel (good geometry).
    const concentration = inRange.length ? Math.hypot(sumSin, sumCos) / inRange.reduce((a, p) => a + (p.rcs ?? 0.5), 0) : 1;
    const spread = 1 - Math.min(1, concentration);
    return { features: inRange, spread };
  }

  /** Decimated body-frame point cloud for the Mode B matcher. */
  buildPointCloud(features, truth, maxPoints, sigma) {
    const step = Math.max(1, Math.ceil(features.length / maxPoints));
    const headingRad = (truth.heading_deg * Math.PI) / 180;
    const cloud = [];
    for (let i = 0; i < features.length; i += step) {
      const f = features[i];
      const de = f.e - truth.east_m + this.rng.normal(0, sigma);
      const dn = f.n - truth.north_m + this.rng.normal(0, sigma);
      // Rotate into the body frame (x forward, y starboard).
      cloud.push([
        Number((dn * Math.cos(headingRad) + de * Math.sin(headingRad)).toFixed(2)),
        Number((de * Math.cos(headingRad) - dn * Math.sin(headingRad)).toFixed(2))
      ]);
    }
    return cloud;
  }
}

export class RadarLocalizationSensor extends PointCloudLocalizationSensor {
  measure(t, dt, truth, faults) {
    let unavailable = false;
    let confidenceScale = 1;
    let sigmaMultiplier = 1;
    for (const fault of faults) {
      if (fault.type === 'RADAR_UNAVAILABLE' || fault.type === 'SENSOR_DROPOUT') unavailable = true;
      if (fault.type === 'RADAR_CONFIDENCE_LOSS') {
        confidenceScale *= fault.params.confidence_scale;
        sigmaMultiplier *= fault.params.sigma_multiplier;
      }
      if (fault.type === 'SENSOR_NOISE') sigmaMultiplier *= fault.params.multiplier;
    }
    if (unavailable) return null;

    const { features, spread } = this.visibleFeatures(truth);
    const minFeatures = this.sim.min_features_for_fix ?? 4;
    const featureRichness = Math.min(1, features.length / 90) * (0.35 + 0.65 * spread);

    // Position sigma interpolates between the feature-rich and feature-poor
    // values according to how much of the map is actually in view.
    const rich = this.sim.feature_rich_position_sigma_m ?? 0.6;
    const poor = this.sim.feature_poor_position_sigma_m ?? 4.5;
    let sigma = (poor + (rich - poor) * featureRichness) * sigmaMultiplier;
    sigma = Math.min(sigma, 250);

    const confidence = Math.max(0, Math.min(1, featureRichness * 1.15)) * confidenceScale;
    const valid = features.length >= minFeatures && confidence > 0.02;
    if (!valid && features.length < minFeatures) return null;

    const east = truth.east_m + this.rng.normal(0, sigma);
    const north = truth.north_m + this.rng.normal(0, sigma);
    const geo = this.env.frame.toGeodetic(east, north);
    const headingSigma = (this.sim.heading_sigma_deg ?? 0.9) * sigmaMultiplier;

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.RADAR,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 0 },
      headingDeg: Number(normalizeHeading(truth.heading_deg + this.rng.normal(0, headingSigma)).toFixed(3)),
      quality: {
        match_score: Number(confidence.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        matched_features: features.length,
        inliers: Math.round(features.length * (0.55 + 0.4 * confidence)),
        residual_m: Number((sigma * 0.75).toFixed(3)),
        map_age_days: this.sim.map_age_days ?? 45,
        feature_score: Number(featureRichness.toFixed(4)),
        heading_sigma_deg: Number(headingSigma.toFixed(3)),
        position_covariance: [sigma * sigma, 0, 0, sigma * sigma],
        status: valid ? 'MATCHED' : 'LOW_CONFIDENCE',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        point_cloud: this.buildPointCloud(features, truth, 140, Math.min(3.0, sigma * 0.5)),
        bearing_spread: Number(spread.toFixed(3)),
        range_max_m: this.sim.max_range_m ?? 3000
      },
      valid
    });
  }
}

export class LidarLocalizationSensor extends PointCloudLocalizationSensor {
  measure(t, dt, truth, faults) {
    let unavailable = false;
    let sigmaMultiplier = 1;
    for (const fault of faults) {
      if (fault.type === 'LIDAR_UNAVAILABLE' || fault.type === 'SENSOR_DROPOUT') unavailable = true;
      if (fault.type === 'SENSOR_NOISE') sigmaMultiplier *= fault.params.multiplier;
    }
    if (unavailable) return null;

    const { features, spread } = this.visibleFeatures(truth);
    const minFeatures = this.sim.min_features_for_fix ?? 12;
    if (features.length < minFeatures) return null;

    const richness = Math.min(1, features.length / 140) * (0.4 + 0.6 * spread);
    const sigma = Math.min(60, ((this.sim.base_position_sigma_m ?? 0.25) / Math.max(0.15, richness)) * sigmaMultiplier);
    const confidence = Math.max(0, Math.min(1, richness * 1.25));

    const east = truth.east_m + this.rng.normal(0, sigma);
    const north = truth.north_m + this.rng.normal(0, sigma);
    const geo = this.env.frame.toGeodetic(east, north);

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.LIDAR,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 0 },
      headingDeg: Number(normalizeHeading(truth.heading_deg + this.rng.normal(0, this.sim.heading_sigma_deg ?? 0.4)).toFixed(3)),
      quality: {
        match_score: Number(confidence.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        matched_features: features.length,
        inliers: Math.round(features.length * 0.8),
        residual_m: Number((sigma * 0.6).toFixed(3)),
        feature_score: Number(richness.toFixed(4)),
        position_covariance: [sigma * sigma, 0, 0, sigma * sigma],
        status: 'MATCHED',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        point_cloud: this.buildPointCloud(features, truth, 200, Math.min(1.0, sigma * 0.5)),
        bearing_spread: Number(spread.toFixed(3))
      },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// Depth sensors
// ---------------------------------------------------------------------------

/**
 * Depth actually observed by the vessel's sounders.
 *
 * A featureless-seabed fault replaces the local relief with a large-radius
 * average of the same surface. That is what "operating over flat seabed"
 * really means for a terrain matcher: the observations remain consistent with
 * the map, but they contain almost no information about position.
 */
export function observedSeabedDepth(env, e, n, flatteningStrength) {
  const trueDepth = trueDepthAt(e, n);
  if (!flatteningStrength) return trueDepth;
  const R = 420;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI * 2 * i) / 8;
    const d = sampleGridDepth(env.bathymetry, e + R * Math.cos(a), n + R * Math.sin(a));
    if (d !== null) {
      sum += d;
      count += 1;
    }
  }
  const smoothed = count ? sum / count : trueDepth;
  return trueDepth * (1 - flatteningStrength) + smoothed * flatteningStrength;
}

/** Strength of any active featureless-seabed condition, 0..1. */
function flatteningStrength(injector, t) {
  const active = injector.activeOfType('BATHY_FLAT_SEABED', t);
  if (active.length === 0) return 0;
  const observability = Math.min(...active.map((f) => f.params.observability));
  return Math.max(0, Math.min(1, 1 - observability));
}

export class EchoSounderSensor extends SimulatedSensor {
  measure(t, dt, truth, faults) {
    let sigma = this.sim.depth_sigma_m ?? 0.05;
    let offset = 0;
    for (const fault of faults) {
      if (fault.type === 'ECHO_DEPTH_OFFSET') offset += fault.params.offset_m;
      if (fault.type === 'SENSOR_NOISE') sigma *= fault.params.multiplier;
    }
    const flat = flatteningStrength(this.injector, t);
    const seabed = observedSeabedDepth(this.env, truth.east_m, truth.north_m, flat);
    const transducerOffset = this.sim.transducer_offset_m ?? 1.8;
    // Depth below the transducer, the raw quantity a sounder actually reports.
    const belowTransducer = seabed + truth.tide_m - transducerOffset - truth.squat_m;
    const depth = belowTransducer + offset + this.rng.normal(0, sigma);

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.ECHO_SOUNDER,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      depthM: Number(Math.max(0.2, depth).toFixed(3)),
      quality: {
        depth_sigma_m: Number(sigma.toFixed(4)),
        sound_velocity_mps: 1530,
        status: 'TRACKING',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        transducer_offset_m: transducerOffset,
        tide_m: Number(truth.tide_m.toFixed(3)),
        squat_m: Number(truth.squat_m.toFixed(4)),
        reference: 'BELOW_TRANSDUCER'
      },
      valid: true
    });
  }
}

export class MultibeamSensor extends SimulatedSensor {
  measure(t, dt, truth, faults) {
    let sigma = this.sim.depth_sigma_m ?? 0.04;
    let offset = 0;
    for (const fault of faults) {
      if (fault.type === 'ECHO_DEPTH_OFFSET') offset += fault.params.offset_m;
      if (fault.type === 'SENSOR_NOISE') sigma *= fault.params.multiplier;
    }
    const flat = flatteningStrength(this.injector, t);
    const beams = this.sim.beam_count ?? 32;
    const swath = ((this.sim.swath_angle_deg ?? 120) * Math.PI) / 180;
    const headingRad = (truth.heading_deg * Math.PI) / 180;
    const nominalDepth = observedSeabedDepth(this.env, truth.east_m, truth.north_m, flat);
    const profile = [];
    for (let i = 0; i < beams; i += 1) {
      const angle = -swath / 2 + (swath * i) / (beams - 1);
      const across = Math.tan(angle) * nominalDepth;
      // Across-track offset in the local frame (starboard of the heading).
      const e = truth.east_m + across * Math.cos(headingRad);
      const n = truth.north_m - across * Math.sin(headingRad);
      const seabed = observedSeabedDepth(this.env, e, n, flat);
      profile.push({
        across_m: Number(across.toFixed(2)),
        east_m: Number(e.toFixed(2)),
        north_m: Number(n.toFixed(2)),
        depth_m: Number((seabed + truth.tide_m + offset + this.rng.normal(0, sigma)).toFixed(3))
      });
    }

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.MULTIBEAM,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      depthM: Number((nominalDepth + truth.tide_m + offset).toFixed(3)),
      quality: {
        beam_count: beams,
        depth_sigma_m: Number(sigma.toFixed(4)),
        sound_velocity_mps: 1530,
        status: 'LOGGING',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: { swath_angle_deg: this.sim.swath_angle_deg ?? 120, profile },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// Inertial navigation system (optional)
// ---------------------------------------------------------------------------

export class InsSensor extends SimulatedSensor {
  constructor(def, ctx) {
    super(def, ctx);
    this.initialiseDrift();
  }

  /**
   * Draw the initial drift direction. Called from both the constructor and
   * reset(), in the same order relative to the RNG reset, so a reset run
   * reproduces the original exactly.
   */
  initialiseDrift() {
    this.driftEast = 0;
    this.driftNorth = 0;
    this.headingDrift = 0;
    this.driftDirection = this.rng.uniform(0, Math.PI * 2);
  }

  reset() {
    super.reset();
    this.initialiseDrift();
  }

  measure(t, dt, truth, faults) {
    let multiplier = 1;
    for (const fault of faults) {
      if (fault.type === 'INS_DRIFT') multiplier *= fault.params.multiplier;
      if (fault.type === 'SENSOR_DROPOUT') return null;
    }
    // Unaided INS position error is modelled as a random walk with a slowly
    // rotating preferred direction. INS is never treated as drift free.
    const rate = (this.sim.position_drift_m_per_s ?? 0.012) * multiplier;
    this.driftDirection += this.rng.normal(0, 0.02);
    this.driftEast += rate * this.interval * Math.cos(this.driftDirection) + this.rng.normal(0, rate * 0.4);
    this.driftNorth += rate * this.interval * Math.sin(this.driftDirection) + this.rng.normal(0, rate * 0.4);
    this.headingDrift += ((this.sim.heading_drift_deg_per_hour ?? 0.8) / 3600) * this.interval * multiplier;

    const east = truth.east_m + this.driftEast;
    const north = truth.north_m + this.driftNorth;
    const geo = this.env.frame.toGeodetic(east, north);
    const drift = Math.hypot(this.driftEast, this.driftNorth);

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.INS,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 0 },
      velocity: {
        north_mps: truth.velocity_north_mps + this.rng.normal(0, this.sim.velocity_sigma_mps ?? 0.015),
        east_mps: truth.velocity_east_mps + this.rng.normal(0, this.sim.velocity_sigma_mps ?? 0.015),
        down_mps: this.rng.normal(0, 0.02)
      },
      headingDeg: Number(normalizeHeading(truth.heading_deg + this.headingDrift + this.rng.normal(0, this.sim.heading_sigma_deg ?? 0.05)).toFixed(3)),
      quality: {
        // The INS reports its own growing uncertainty; the fusion engine uses
        // this rather than assuming the INS is exact.
        position_covariance: [Math.max(0.25, drift ** 2), 0, 0, Math.max(0.25, drift ** 2)],
        velocity_sigma_mps: this.sim.velocity_sigma_mps ?? 0.015,
        heading_sigma_deg: this.sim.heading_sigma_deg ?? 0.05,
        ins_aided: false,
        time_since_aiding_s: Number(t.toFixed(1)),
        status: 'NAV_MODE',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: {
        rate_of_turn_dps: Number((truth.turn_rate_dps + this.rng.normal(0, 0.04)).toFixed(4)),
        heave_m: Number((0.28 * Math.sin(t * 1.35) + 0.12 * Math.sin(t * 0.61)).toFixed(3)),
        roll_deg: Number((2.1 * Math.sin(t * 0.9)).toFixed(3)),
        pitch_deg: Number((1.1 * Math.sin(t * 1.2 + 0.6)).toFixed(3)),
        accumulated_drift_m: Number(drift.toFixed(3))
      },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// Local ranging (UWB / terrestrial / acoustic)
// ---------------------------------------------------------------------------

export class LocalRangingSensor extends SimulatedSensor {
  measure(t, dt, truth, faults) {
    for (const fault of faults) {
      if (fault.type === 'SENSOR_DROPOUT') return null;
    }
    const centreE = this.sim.coverage_centre_offset_east_m ?? 0;
    const centreN = this.sim.coverage_centre_offset_north_m ?? 0;
    const radius = this.sim.coverage_radius_m ?? 1500;
    const range = Math.hypot(truth.east_m - centreE, truth.north_m - centreN);
    if (range > radius) return null;

    // Accuracy degrades towards the edge of the instrumented area.
    const edgeFactor = 1 + 3.5 * (range / radius) ** 2;
    const sigma = (this.sim.position_sigma_m ?? 0.25) * edgeFactor;
    const east = truth.east_m + this.rng.normal(0, sigma);
    const north = truth.north_m + this.rng.normal(0, sigma);
    const geo = this.env.frame.toGeodetic(east, north);

    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.LOCAL_RANGING,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      position: { latitude: geo.latitude, longitude: geo.longitude, altitude_m: 0 },
      quality: {
        beacon_count: this.sim.beacon_count ?? 5,
        gdop: Number(edgeFactor.toFixed(2)),
        technology: this.sim.technology ?? 'TERRESTRIAL_RANGING',
        confidence: Number(Math.max(0.2, 1 - range / radius).toFixed(3)),
        position_covariance: [sigma * sigma, 0, 0, sigma * sigma],
        status: 'FIX',
        latency_ms: this.sim.latency_ms ?? 0
      },
      raw: { range_to_centre_m: Number(range.toFixed(1)), coverage_radius_m: radius },
      valid: true
    });
  }
}

// ---------------------------------------------------------------------------
// AIS (advisory only) and ground truth
// ---------------------------------------------------------------------------

export class AisSensor extends SimulatedSensor {
  constructor(def, ctx) {
    super(def, ctx);
    this.buildContacts();
  }

  /** Contacts consume RNG draws, so they are rebuilt on reset. */
  buildContacts() {
    this.contacts = Array.from({ length: this.sim.contact_count ?? 6 }, (_, i) => ({
      mmsi: `47010${1000 + i}`,
      name: ['AL DHAFRA', 'MARAWAH', 'GHANTOOT', 'SIR BANI', 'ZAYED PILOT', 'DELMA STAR'][i % 6],
      e: this.rng.uniform(-2500, 2500),
      n: this.rng.uniform(-1500, 2200),
      course: this.rng.uniform(0, 360),
      speed: this.rng.uniform(1.5, 6.5)
    }));
  }

  reset() {
    super.reset();
    this.buildContacts();
  }

  measure(t) {
    for (const c of this.contacts) {
      const cr = (c.course * Math.PI) / 180;
      c.e += c.speed * Math.sin(cr) * this.interval;
      c.n += c.speed * Math.cos(cr) * this.interval;
      if (Math.abs(c.e) > 3200 || Math.abs(c.n) > 2400) c.course = (c.course + 180) % 360;
    }
    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.AIS,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      quality: { status: 'ADVISORY_ONLY', latency_ms: 0 },
      raw: {
        contacts: this.contacts.map((c) => {
          const g = this.env.frame.toGeodetic(c.e, c.n);
          return {
            mmsi: c.mmsi,
            name: c.name,
            latitude: Number(g.latitude.toFixed(6)),
            longitude: Number(g.longitude.toFixed(6)),
            course_deg: Number(c.course.toFixed(1)),
            speed_mps: Number(c.speed.toFixed(2))
          };
        })
      },
      valid: true
    });
  }
}

export class GroundTruthSensor extends SimulatedSensor {
  measure(t, dt, truth) {
    const { courseDeg } = neToCourseSpeed(truth.velocity_north_mps, truth.velocity_east_mps);
    return buildSensorMessage({
      sensorId: this.id,
      sensorType: SensorType.GROUND_TRUTH,
      timestampUtc: this.stamp(t),
      sequenceNumber: 0,
      position: { latitude: truth.latitude, longitude: truth.longitude, altitude_m: 0 },
      velocity: {
        north_mps: truth.velocity_north_mps,
        east_mps: truth.velocity_east_mps,
        down_mps: 0
      },
      headingDeg: truth.heading_deg,
      depthM: truth.seabed_depth_m,
      quality: { status: 'SIMULATED_REFERENCE' },
      raw: {
        zone: truth.zone,
        course_deg: Number(courseDeg.toFixed(3)),
        turn_rate_dps: Number(truth.turn_rate_dps.toFixed(4)),
        east_m: Number(truth.east_m.toFixed(3)),
        north_m: Number(truth.north_m.toFixed(3))
      },
      valid: true
    });
  }
}

/** Factory mapping a sensor definition to its simulated implementation. */
export function createSimulatedSensor(definition, ctx) {
  switch (definition.sensor_type) {
    case SensorType.GNSS:
      return new GnssSensor(definition, ctx);
    case SensorType.GYRO:
      return new GyroSensor(definition, ctx);
    case SensorType.DVL:
      return new DvlSensor(definition, ctx);
    case SensorType.SPEED_LOG:
      return new SpeedLogSensor(definition, ctx);
    case SensorType.RADAR:
      return new RadarLocalizationSensor(definition, ctx, ctx.environment.radarPoints);
    case SensorType.LIDAR:
      return new LidarLocalizationSensor(definition, ctx, ctx.environment.lidarPoints);
    case SensorType.ECHO_SOUNDER:
      return new EchoSounderSensor(definition, ctx);
    case SensorType.MULTIBEAM:
      return new MultibeamSensor(definition, ctx);
    case SensorType.INS:
      return new InsSensor(definition, ctx);
    case SensorType.LOCAL_RANGING:
      return new LocalRangingSensor(definition, ctx);
    case SensorType.AIS:
      return new AisSensor(definition, ctx);
    case SensorType.GROUND_TRUTH:
      return new GroundTruthSensor(definition, ctx);
    // BATHYMETRIC_MATCH is produced by the navigation layer, not the simulator.
    default:
      return null;
  }
}
