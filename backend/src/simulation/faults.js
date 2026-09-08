/**
 * Fault injection catalogue (Sections 4.7 and 16).
 *
 * A fault is a pure, time-windowed transformation applied to the *simulated*
 * sensor stream. Nothing here touches the navigation pipeline - the pipeline
 * must discover the fault from the data alone, which is the entire point of
 * the exercise.
 *
 * Adding a fault type means adding an entry to FAULT_TYPES. There is no
 * scripting hook and no dynamic evaluation (Section 22).
 */

import { normalizeHeading } from '../utils/geo.js';

/**
 * Every supported fault type, its target sensor kinds, and the parameters it
 * accepts. This catalogue is exposed over the API so the UI can build the
 * fault-injection form without hard-coding anything.
 */
export const FAULT_TYPES = Object.freeze({
  GNSS_POSITION_JUMP: {
    label: 'GNSS sudden position jump',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Offsets the reported GNSS position by a fixed vector.',
    params: {
      east_m: { type: 'number', default: 50, min: -500, max: 500, unit: 'm' },
      north_m: { type: 'number', default: 0, min: -500, max: 500, unit: 'm' }
    }
  },
  GNSS_GRADUAL_DRAG: {
    label: 'GNSS gradual spoofing drag',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Walks the reported position away at a constant rate on a fixed bearing.',
    params: {
      rate_m_per_s: { type: 'number', default: 0.1, min: 0.005, max: 5, unit: 'm/s' },
      bearing_deg: { type: 'number', default: 90, min: 0, max: 360, unit: 'deg' },
      max_offset_m: { type: 'number', default: 40, min: 1, max: 1000, unit: 'm' }
    }
  },
  GNSS_FALSE_VELOCITY: {
    label: 'GNSS false velocity',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Replaces the reported velocity vector while position continues normally.',
    params: {
      north_mps: { type: 'number', default: 0, min: -20, max: 20, unit: 'm/s' },
      east_mps: { type: 'number', default: 4, min: -20, max: 20, unit: 'm/s' }
    }
  },
  GNSS_FALSE_COURSE: {
    label: 'GNSS false course over ground',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Rotates the reported velocity vector by a fixed angle.',
    params: { course_offset_deg: { type: 'number', default: 45, min: -180, max: 180, unit: 'deg' } }
  },
  GNSS_FALSE_TIME: {
    label: 'GNSS false time',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Offsets the GNSS message timestamp from true UTC.',
    params: { offset_s: { type: 'number', default: 4, min: -60, max: 60, unit: 's' } }
  },
  GNSS_FREEZE: {
    label: 'GNSS frozen position',
    applies_to: ['GNSS'],
    category: 'SPOOFING',
    description: 'Holds the reported position at the value it had when the fault started.',
    params: {}
  },
  GNSS_JAMMING: {
    label: 'GNSS jamming / interference',
    applies_to: ['GNSS'],
    category: 'JAMMING',
    description: 'Ramps down C/N0 and satellite count while inflating DOP and position noise.',
    params: {
      ramp_s: { type: 'number', default: 60, min: 1, max: 600, unit: 's' },
      max_severity: { type: 'number', default: 1, min: 0.1, max: 1, unit: '0-1' }
    }
  },
  GNSS_OUTAGE: {
    label: 'GNSS complete outage',
    applies_to: ['GNSS'],
    category: 'OUTAGE',
    description: 'Suppresses GNSS messages entirely.',
    params: {}
  },
  RADAR_CONFIDENCE_LOSS: {
    label: 'Radar match confidence loss',
    applies_to: ['RADAR'],
    category: 'LOCALIZATION',
    description: 'Scales down radar match confidence and inflates its covariance.',
    params: {
      confidence_scale: { type: 'number', default: 0.1, min: 0, max: 1, unit: 'x' },
      sigma_multiplier: { type: 'number', default: 8, min: 1, max: 50, unit: 'x' }
    }
  },
  RADAR_UNAVAILABLE: {
    label: 'Radar localization unavailable',
    applies_to: ['RADAR'],
    category: 'LOCALIZATION',
    description: 'Suppresses radar localization messages entirely.',
    params: {}
  },
  LIDAR_UNAVAILABLE: {
    label: 'LiDAR localization unavailable',
    applies_to: ['LIDAR'],
    category: 'LOCALIZATION',
    description: 'Suppresses LiDAR localization messages entirely.',
    params: {}
  },
  BATHY_FLAT_SEABED: {
    label: 'Featureless seabed',
    applies_to: ['BATHYMETRIC_MATCH'],
    category: 'LOCALIZATION',
    description: 'Forces terrain observability to a very low value, producing genuine ambiguity.',
    params: { observability: { type: 'number', default: 0.05, min: 0, max: 1, unit: '0-1' } }
  },
  DVL_BOTTOM_LOCK_LOSS: {
    label: 'DVL bottom-lock loss',
    applies_to: ['DVL'],
    category: 'SENSOR_FAILURE',
    description: 'Marks DVL velocity invalid and clears the bottom-lock flag.',
    params: {}
  },
  GYRO_BIAS: {
    label: 'Gyro heading bias',
    applies_to: ['GYRO'],
    category: 'SENSOR_FAILURE',
    description: 'Ramps a heading bias into the gyro output.',
    params: {
      rate_deg_per_s: { type: 'number', default: 0.02, min: 0.0001, max: 1, unit: 'deg/s' },
      max_bias_deg: { type: 'number', default: 6, min: 0.1, max: 90, unit: 'deg' }
    }
  },
  SPEEDLOG_SCALE_ERROR: {
    label: 'Speed log scale error',
    applies_to: ['SPEED_LOG', 'DVL'],
    category: 'SENSOR_FAILURE',
    description: 'Multiplies the reported speed by a constant factor.',
    params: { scale: { type: 'number', default: 1.15, min: 0.2, max: 3, unit: 'x' } }
  },
  ECHO_DEPTH_OFFSET: {
    label: 'Echo sounder depth offset',
    applies_to: ['ECHO_SOUNDER', 'MULTIBEAM'],
    category: 'SENSOR_FAILURE',
    description: 'Adds a constant offset to the reported depth.',
    params: { offset_m: { type: 'number', default: 1.5, min: -20, max: 20, unit: 'm' } }
  },
  SENSOR_FREEZE: {
    label: 'Frozen sensor value',
    applies_to: ['ANY'],
    category: 'SENSOR_FAILURE',
    description: 'Repeats the last measurement values while sequence numbers keep advancing.',
    params: {}
  },
  SENSOR_DROPOUT: {
    label: 'Sensor dropout',
    applies_to: ['ANY'],
    category: 'SENSOR_FAILURE',
    description: 'Suppresses messages from the sensor.',
    params: {}
  },
  SENSOR_NOISE: {
    label: 'Excessive sensor noise',
    applies_to: ['ANY'],
    category: 'SENSOR_FAILURE',
    description: 'Multiplies the sensor noise standard deviation.',
    params: { multiplier: { type: 'number', default: 8, min: 1, max: 100, unit: 'x' } }
  },
  SENSOR_LATENCY: {
    label: 'Message latency',
    applies_to: ['ANY'],
    category: 'MESSAGE_INTEGRITY',
    description: 'Delays message delivery, making the data stale on arrival.',
    params: { extra_latency_ms: { type: 'number', default: 2000, min: 1, max: 30000, unit: 'ms' } }
  },
  SENSOR_DUPLICATE: {
    label: 'Duplicate messages',
    applies_to: ['ANY'],
    category: 'MESSAGE_INTEGRITY',
    description: 'Re-sends messages with an already-used sequence number.',
    params: { probability: { type: 'number', default: 0.25, min: 0, max: 1, unit: '0-1' } }
  },
  SENSOR_OUT_OF_ORDER: {
    label: 'Out-of-order timestamps',
    applies_to: ['ANY'],
    category: 'MESSAGE_INTEGRITY',
    description: 'Shifts message timestamps backwards so they arrive out of order.',
    params: {
      probability: { type: 'number', default: 0.2, min: 0, max: 1, unit: '0-1' },
      max_shift_s: { type: 'number', default: 1.5, min: 0.05, max: 30, unit: 's' }
    }
  },
  INS_DRIFT: {
    label: 'Accelerated INS drift',
    applies_to: ['INS'],
    category: 'SENSOR_FAILURE',
    description: 'Multiplies the INS position drift rate.',
    params: { multiplier: { type: 'number', default: 10, min: 1, max: 200, unit: 'x' } }
  }
});

/** Sensor types a fault type may target. */
export function faultAppliesTo(type, sensorType) {
  const def = FAULT_TYPES[type];
  if (!def) return false;
  return def.applies_to.includes('ANY') || def.applies_to.includes(sensorType);
}

let manualFaultCounter = 0;

/**
 * Normalise a fault definition, filling parameter defaults and validating
 * that the type exists. Throws on an unknown type or an out-of-range value.
 */
export function normalizeFault(raw) {
  // These are user-input validation failures, not internal errors, so they
  // carry a 400 for the API layer rather than surfacing as a server fault.
  const reject = (message) => {
    throw Object.assign(new Error(message), { status: 400, code: 'INVALID_FAULT' });
  };

  const def = FAULT_TYPES[raw.type];
  if (!def) {
    reject(`Unknown fault type: ${raw.type}`);
  }
  const params = {};
  for (const [key, spec] of Object.entries(def.params)) {
    const provided = raw.params?.[key];
    const value = provided === undefined || provided === null ? spec.default : Number(provided);
    if (!Number.isFinite(value)) reject(`Fault ${raw.type}: parameter ${key} must be a number`);
    if (spec.min !== undefined && value < spec.min) {
      reject(`Fault ${raw.type}: ${key} must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      reject(`Fault ${raw.type}: ${key} must be <= ${spec.max}`);
    }
    params[key] = value;
  }
  manualFaultCounter += 1;
  return {
    id: raw.id || `MANUAL_${manualFaultCounter}_${raw.type}`,
    label: raw.label || def.label,
    sensor_id: raw.sensor_id,
    type: raw.type,
    start_s: Number.isFinite(raw.start_s) ? raw.start_s : 0,
    end_s: Number.isFinite(raw.end_s) ? raw.end_s : Number.POSITIVE_INFINITY,
    params,
    manual: Boolean(raw.manual),
    category: def.category
  };
}

/**
 * Holds the active fault set for a run and answers "what faults apply to this
 * sensor right now".
 */
export class FaultInjector {
  constructor(faults = []) {
    this.faults = faults.map((f) => normalizeFault(f));
    /** Per-fault mutable state (frozen values, accumulated drag, ...). */
    this.state = new Map();
  }

  reset() {
    this.state.clear();
  }

  /** All configured faults, including inactive ones. */
  list() {
    return this.faults.map((f) => ({
      ...f,
      end_s: Number.isFinite(f.end_s) ? f.end_s : null
    }));
  }

  add(raw) {
    const fault = normalizeFault(raw);
    this.faults.push(fault);
    return fault;
  }

  remove(id) {
    const index = this.faults.findIndex((f) => f.id === id);
    if (index === -1) return null;
    const [removed] = this.faults.splice(index, 1);
    this.state.delete(id);
    return removed;
  }

  /** Faults active for a sensor at simulation time `t`. */
  activeFor(sensorId, t) {
    return this.faults.filter((f) => f.sensor_id === sensorId && t >= f.start_s && t < f.end_s);
  }

  /** All faults active at time `t`, regardless of sensor. */
  activeAt(t) {
    return this.faults.filter((f) => t >= f.start_s && t < f.end_s);
  }

  /**
   * Active faults of a given type regardless of which sensor they name.
   * Used by faults that describe an environmental condition rather than a
   * single instrument - a featureless seabed affects every depth sensor.
   */
  activeOfType(type, t) {
    return this.faults.filter((f) => f.type === type && t >= f.start_s && t < f.end_s);
  }

  /** Mutable per-fault scratch space. */
  stateFor(fault) {
    if (!this.state.has(fault.id)) this.state.set(fault.id, {});
    return this.state.get(fault.id);
  }
}

/**
 * Apply GNSS-specific faults to a candidate GNSS observation.
 *
 * @param {object} obs mutable observation { east, north, vNorth, vEast, timeOffsetS,
 *                     quality, suppressed, noiseMultiplier }
 * @param {object[]} faults active faults
 * @param {FaultInjector} injector
 * @param {number} t simulation time
 * @param {number} dt step
 */
export function applyGnssFaults(obs, faults, injector, t, dt) {
  for (const fault of faults) {
    const state = injector.stateFor(fault);
    switch (fault.type) {
      case 'GNSS_POSITION_JUMP':
        obs.east += fault.params.east_m;
        obs.north += fault.params.north_m;
        obs.spoofed = true;
        break;

      case 'GNSS_GRADUAL_DRAG': {
        state.offset = Math.min(
          fault.params.max_offset_m,
          (state.offset ?? 0) + fault.params.rate_m_per_s * dt
        );
        const br = (fault.params.bearing_deg * Math.PI) / 180;
        obs.east += state.offset * Math.sin(br);
        obs.north += state.offset * Math.cos(br);
        obs.dragOffset = state.offset;
        obs.spoofed = true;
        break;
      }

      case 'GNSS_FALSE_VELOCITY':
        obs.vNorth = fault.params.north_mps;
        obs.vEast = fault.params.east_mps;
        obs.spoofed = true;
        break;

      case 'GNSS_FALSE_COURSE': {
        const speed = Math.hypot(obs.vNorth, obs.vEast);
        const course = normalizeHeading(
          (Math.atan2(obs.vEast, obs.vNorth) * 180) / Math.PI + fault.params.course_offset_deg
        );
        const cr = (course * Math.PI) / 180;
        obs.vNorth = speed * Math.cos(cr);
        obs.vEast = speed * Math.sin(cr);
        obs.spoofed = true;
        break;
      }

      case 'GNSS_FALSE_TIME':
        obs.timeOffsetS = (obs.timeOffsetS ?? 0) + fault.params.offset_s;
        obs.spoofed = true;
        break;

      case 'GNSS_FREEZE':
        if (state.frozenEast === undefined) {
          state.frozenEast = obs.east;
          state.frozenNorth = obs.north;
        }
        obs.east = state.frozenEast;
        obs.north = state.frozenNorth;
        obs.spoofed = true;
        break;

      case 'GNSS_JAMMING': {
        const elapsed = t - fault.start_s;
        const severity = Math.min(fault.params.max_severity, elapsed / Math.max(0.001, fault.params.ramp_s));
        obs.jammingSeverity = Math.max(obs.jammingSeverity ?? 0, severity);
        break;
      }

      case 'GNSS_OUTAGE':
        obs.suppressed = true;
        break;

      case 'SENSOR_NOISE':
        obs.noiseMultiplier = (obs.noiseMultiplier ?? 1) * fault.params.multiplier;
        break;

      case 'SENSOR_DROPOUT':
        obs.suppressed = true;
        break;

      default:
        break;
    }
  }
  return obs;
}

/**
 * Generic message-level faults applied after a message has been built:
 * latency, duplication, out-of-order timestamps, freezing and dropout.
 *
 * @returns {{ deliver: object[], suppressed: boolean }} zero or more messages
 *          to deliver, each with a `deliverAtS` field.
 */
export function applyMessageFaults(message, faults, injector, t, rng) {
  let suppressed = false;
  let deliverAtS = t;
  const extra = [];

  for (const fault of faults) {
    const state = injector.stateFor(fault);
    switch (fault.type) {
      case 'SENSOR_DROPOUT':
        suppressed = true;
        break;

      case 'SENSOR_LATENCY':
        deliverAtS += fault.params.extra_latency_ms / 1000;
        message.quality = { ...message.quality, latency_ms: fault.params.extra_latency_ms };
        break;

      case 'SENSOR_DUPLICATE':
        if (rng.bool(fault.params.probability)) {
          extra.push({ ...structuredClone(message), __duplicate: true });
        }
        break;

      case 'SENSOR_OUT_OF_ORDER':
        if (rng.bool(fault.params.probability)) {
          const shift = rng.uniform(0.05, fault.params.max_shift_s);
          const shifted = new Date(new Date(message.timestamp_utc).getTime() - shift * 1000);
          message.timestamp_utc = shifted.toISOString();
          message.__outOfOrder = true;
        }
        break;

      case 'SENSOR_FREEZE':
        if (!state.frozen) {
          state.frozen = {
            position: message.position ? { ...message.position } : null,
            velocity: message.velocity ? { ...message.velocity } : null,
            heading_deg: message.heading_deg,
            depth_m: message.depth_m
          };
        }
        message.position = state.frozen.position ? { ...state.frozen.position } : null;
        message.velocity = state.frozen.velocity ? { ...state.frozen.velocity } : null;
        message.heading_deg = state.frozen.heading_deg;
        message.depth_m = state.frozen.depth_m;
        message.quality = { ...message.quality, status: 'FROZEN_SOURCE_VALUE' };
        break;

      default:
        break;
    }
  }

  if (suppressed) return { deliver: [], suppressed: true };
  const primary = { message, deliverAtS };
  const duplicates = extra.map((m) => ({ message: m, deliverAtS: deliverAtS + 0.02 }));
  return { deliver: [primary, ...duplicates], suppressed: false };
}

export default FaultInjector;
