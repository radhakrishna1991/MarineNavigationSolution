/**
 * Scenario engine (Section 16).
 *
 * Drives the ground-truth vessel, the simulated sensors, the fault injector and
 * the navigation pipeline in lockstep at a fixed internal tick rate. The engine
 * is a pure state machine over simulation time: it has no timers of its own, so
 * the same code runs a live demonstration, a headless batch run and a unit
 * test, and produces identical results in all three.
 *
 * Determinism guarantees
 *   - one seeded RNG tree, forked per sensor by name
 *   - a fixed tick, independent of wall-clock speed multiplier
 *   - no Date.now() anywhere in the data path (the epoch is fixed per run)
 */

import { VesselModel } from './vessel.js';
import { FaultInjector } from './faults.js';
import { createSimulatedSensor } from './sensors.js';
import { NavigationPipeline } from '../navigation/pipeline.js';
import { buildEnvironment } from '../geospatial/environment.js';
import { getConfig, sensorCatalog } from '../config/index.js';
import { Rng } from '../utils/random.js';
import { ScenarioState } from '../models/enums.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scenario-engine');

export class ScenarioEngine {
  /**
   * @param {object} options
   * @param {object} options.scenario scenario definition
   * @param {number} [options.epochMs] wall-clock time mapped to simulation t=0
   */
  /**
   * @param {object} options
   * @param {object} options.scenario
   * @param {number} [options.epochMs]
   * @param {{east_m?: number, north_m?: number}} [options.stationOffset]
   *   Translates this vessel's route within the operating area. A fleet whose
   *   vessels all follow the identical track is not a fleet - they stack on
   *   one another and the display shows one dot. The offset moves where the
   *   vessel actually works; the seabed, the shoreline and every sensor still
   *   see the real environment at that position, so the simulation stays
   *   self-consistent.
   */
  constructor({ scenario, epochMs = Date.UTC(2024, 10, 18, 6, 0, 0), stationOffset = null } = {}) {
    this.scenario = scenario;
    this.epochMs = epochMs;
    this.environment = buildEnvironment();
    if (stationOffset && (stationOffset.east_m || stationOffset.north_m)) {
      const east = Number(stationOffset.east_m) || 0;
      const north = Number(stationOffset.north_m) || 0;
      this.environment = {
        ...this.environment,
        routeWaypoints: this.environment.routeWaypoints.map((w) => ({ ...w, e: w.e + east, n: w.n + north }))
      };
    }
    this.build();
  }

  build() {
    const cfg = getConfig();
    this.tickDt = 1 / (cfg.simulation.tick_hz || 20);
    this.publishInterval = 1 / (cfg.simulation.publish_hz || 5);
    this.rng = new Rng(this.scenario.seed ?? cfg.simulation.seed);
    this.injector = new FaultInjector(this.scenario.faults ?? []);
    this.vessel = new VesselModel({ environment: this.environment });

    const insEnabled = this.scenario.ins_enabled !== false;
    const localEnabled = Boolean(this.scenario.local_ranging_enabled);

    this.sensors = [];
    for (const def of sensorCatalog) {
      if (def.sensor_type === 'INS' && !insEnabled) continue;
      if (def.sensor_type === 'LOCAL_RANGING' && !localEnabled) continue;
      if (def.sensor_type === 'BATHYMETRIC_MATCH') continue; // produced by the navigation layer
      const sensor = createSimulatedSensor(def, {
        rng: this.rng,
        environment: this.environment,
        injector: this.injector
      });
      if (!sensor) continue;
      sensor.setEpoch(this.epochMs);
      this.sensors.push(sensor);
    }

    this.pipeline = new NavigationPipeline({
      environment: this.environment,
      insEnabled,
      localRangingEnabled: localEnabled,
      epochMs: this.epochMs
    });

    this.reset();
  }

  reset() {
    this.time = 0;
    // Time is tracked as an integer tick count, never as an accumulated float.
    // Accumulating `time += dt` makes the result depend on how the caller
    // chunks its calls to advance(), which breaks the determinism the replay
    // tests and the audit trail depend on.
    this.tickIndex = 0;
    this.pendingTime = 0;
    this.publishEveryTicks = Math.max(1, Math.round(this.publishInterval / this.tickDt));
    this.state = ScenarioState.IDLE;
    this.vessel.reset();
    this.injector.reset();
    this.rng.reset();
    for (const s of this.sensors) s.reset();
    this.pipeline.reset();
    this.tickCount = 0;
    this.messagesGenerated = 0;
    this.lastOutput = null;
    this.lastTruth = this.vessel.state();
    this.events = [];
  }

  get durationS() {
    return this.scenario.duration_s ?? 600;
  }

  get progress() {
    return Math.min(1, this.time / this.durationS);
  }

  get complete() {
    return this.time >= this.durationS;
  }

  /** Record a scenario-level event (fault injection, stage marker, control). */
  recordEvent(eventType, label, detail = {}) {
    const event = { event_type: eventType, label, sim_time_s: this.time, detail };
    this.events.push(event);
    return event;
  }

  /** Drain accumulated scenario events. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * Advance simulation time by `deltaS` seconds.
   *
   * @param {number} deltaS simulated seconds to advance
   * @returns {{ outputs: object[], truths: object[], messages: object[] }}
   */
  advance(deltaS) {
    const outputs = [];
    const truths = [];
    const messages = [];
    this.pendingTime += Math.max(0, deltaS);
    // Bound the work per call so a long pause cannot block the event loop.
    const maxTicks = Math.ceil(120 / this.tickDt);
    let ticks = 0;
    const dt = this.tickDt;

    // Whole ticks only. Any remainder is carried to the next call, so
    // advance(5) twice and advance(10) once produce identical output.
    while (this.pendingTime >= dt - 1e-12 && ticks < maxTicks) {
      this.pendingTime -= dt;
      ticks += 1;
      this.tickIndex += 1;
      this.tickCount += 1;
      this.time = this.tickIndex * dt;

      const truth = this.vessel.step(dt);
      this.lastTruth = truth;

      for (const sensor of this.sensors) {
        const emitted = sensor.tick(this.time, dt, truth);
        for (const item of emitted) {
          this.pipeline.ingest(item.message, item.deliverAtS);
          this.messagesGenerated += 1;
          messages.push({ message: item.message, sim_time_s: this.time, deliver_at_s: item.deliverAtS });
        }
      }

      if (this.tickIndex % this.publishEveryTicks === 0) {
        const output = this.pipeline.attachGroundTruth(this.pipeline.step(this.time), truth);
        output.scenario_id = this.scenario.id;
        output.scenario_progress = Number(this.progress.toFixed(5));
        output.active_faults = this.injector.activeAt(this.time).map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          sensor_id: f.sensor_id,
          category: f.category
        }));
        outputs.push(output);
        this.lastOutput = output;
        truths.push({ ...truth });
      }

      if (this.complete) break;
    }

    return { outputs, truths, messages };
  }

  /** Inject a fault at runtime (operator action). */
  injectFault(raw) {
    const fault = this.injector.add({
      ...raw,
      start_s: Number.isFinite(raw.start_s) ? raw.start_s : this.time,
      end_s: Number.isFinite(raw.end_s) ? raw.end_s : Number.POSITIVE_INFINITY,
      manual: true
    });
    this.recordEvent('FAULT_INJECTED', `${fault.label} on ${fault.sensor_id}`, { fault_id: fault.id, type: fault.type });
    log.info('fault injected', { fault_id: fault.id, type: fault.type, sensor_id: fault.sensor_id, at_s: this.time });
    return fault;
  }

  /** Remove a fault at runtime. */
  removeFault(faultId) {
    const removed = this.injector.remove(faultId);
    if (removed) {
      this.recordEvent('FAULT_REMOVED', `${removed.label} removed`, { fault_id: removed.id, type: removed.type });
      log.info('fault removed', { fault_id: removed.id, at_s: this.time });
    }
    return removed;
  }

  /** Snapshot of the engine state for the scenario panel. */
  snapshot() {
    return {
      scenario_id: this.scenario.id,
      scenario_name: this.scenario.name,
      state: this.state,
      sim_time_s: Number(this.time.toFixed(3)),
      duration_s: this.durationS,
      progress: Number(this.progress.toFixed(5)),
      tick_count: this.tickCount,
      messages_generated: this.messagesGenerated,
      ins_enabled: this.scenario.ins_enabled !== false,
      local_ranging_enabled: Boolean(this.scenario.local_ranging_enabled),
      faults: this.injector.list(),
      active_faults: this.injector.activeAt(this.time).map((f) => f.id),
      demo_steps: this.scenario.demo_steps ?? null,
      ground_truth: this.lastTruth
        ? {
            latitude: this.lastTruth.latitude,
            longitude: this.lastTruth.longitude,
            heading_deg: Number(this.lastTruth.heading_deg.toFixed(2)),
            speed_mps: Number(this.lastTruth.speed_mps.toFixed(3)),
            zone: this.lastTruth.zone,
            depth_m: Number(this.lastTruth.seabed_depth_m.toFixed(2))
          }
        : null
    };
  }
}

/**
 * Run a scenario to completion headless. Used by the data generator, the
 * export scripts and the deterministic replay tests.
 *
 * @param {object} scenario
 * @param {object} [options]
 * @returns {{ engine: ScenarioEngine, outputs: object[], truths: object[] }}
 */
export function runScenarioHeadless(scenario, { onEpoch = null, epochMs } = {}) {
  const engine = new ScenarioEngine({ scenario, epochMs });
  engine.state = ScenarioState.RUNNING;
  const outputs = [];
  const truths = [];
  const chunk = 5; // simulate in 5 s chunks
  while (!engine.complete) {
    const result = engine.advance(chunk);
    for (let i = 0; i < result.outputs.length; i += 1) {
      outputs.push(result.outputs[i]);
      truths.push(result.truths[i]);
      if (onEpoch) onEpoch(result.outputs[i], result.truths[i]);
    }
  }
  engine.state = ScenarioState.COMPLETED;
  return { engine, outputs, truths };
}

export default ScenarioEngine;
