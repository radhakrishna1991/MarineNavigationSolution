/**
 * Scenario runtime (Sections 15.6 and 16).
 *
 * Owns the single live scenario: its wall-clock loop, its speed multiplier, its
 * database run record, and the fan-out of every published epoch to the
 * WebSocket hub and the recorder.
 *
 * Only one scenario runs at a time, by design. This is a decision-support
 * display: two concurrent "trusted positions" would be meaningless, and the
 * single-runtime constraint makes the audit trail unambiguous about which run
 * produced which record.
 */

import { EventEmitter } from 'node:events';
import { ScenarioEngine } from '../simulation/engine.js';
import { getScenarioDefinition, getConfig, scenarioCatalog } from '../config/index.js';
import { ScenarioState } from '../models/enums.js';
import { FAULT_TYPES } from '../simulation/faults.js';
import { one, query, rows } from '../db/pool.js';
import { recorder } from './recorder.js';
import { alarmService } from './alarmService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scenario');

/** Wall-clock interval of the runtime loop. */
const LOOP_INTERVAL_MS = 100;

export class ScenarioService extends EventEmitter {
  constructor() {
    super();
    this.engine = null;
    this.runId = null;
    this.state = ScenarioState.IDLE;
    this.speedMultiplier = 1;
    this.timer = null;
    this.lastTickWallMs = null;
    this.startedBy = null;
    this.lastOutput = null;
    this.stepsPending = 0;
    this.error = null;
  }

  /** Scenario catalogue with database metadata merged in. */
  async listScenarios() {
    const dbRows = await rows(
      `SELECT id, name, category, display_order, duration_s, seed, ins_enabled,
              local_ranging_enabled, is_demonstration, summary, expected_outcome, definition
       FROM scenarios ORDER BY display_order, id`
    );
    const source = dbRows.length ? dbRows : scenarioCatalog.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      display_order: s.order,
      duration_s: s.duration_s,
      seed: s.seed,
      ins_enabled: s.ins_enabled !== false,
      local_ranging_enabled: Boolean(s.local_ranging_enabled),
      is_demonstration: Boolean(s.is_demonstration),
      summary: s.summary,
      expected_outcome: s.expected_outcome,
      definition: s
    }));
    return source.map((r) => ({
      ...r,
      fault_count: (r.definition?.faults ?? []).length,
      faults: r.definition?.faults ?? [],
      demo_steps: r.definition?.demo_steps ?? null
    }));
  }

  /** The runtime status block used by the UI and /api/system/status. */
  status() {
    if (!this.engine) {
      return {
        state: this.state,
        scenario_id: null,
        run_id: null,
        speed_multiplier: this.speedMultiplier,
        sim_time_s: 0,
        duration_s: 0,
        progress: 0,
        error: this.error
      };
    }
    return {
      ...this.engine.snapshot(),
      state: this.state,
      run_id: this.runId,
      speed_multiplier: this.speedMultiplier,
      started_by: this.startedBy,
      error: this.error,
      recorder: recorder.status()
    };
  }

  /**
   * Start a scenario. Any running scenario is stopped first.
   * @param {string} scenarioId
   * @param {object} options
   */
  async start(scenarioId, { userId = null, speedMultiplier = 1, insEnabled = null, seed = null, label = null } = {}) {
    const definition = getScenarioDefinition(scenarioId);
    if (!definition) throw Object.assign(new Error(`Unknown scenario ${scenarioId}`), { status: 404 });

    if (this.state === ScenarioState.RUNNING || this.state === ScenarioState.PAUSED) {
      await this.stop({ userId });
    }

    const scenario = {
      ...definition,
      seed: seed ?? definition.seed,
      ins_enabled: insEnabled === null ? definition.ins_enabled !== false : Boolean(insEnabled)
    };

    this.error = null;
    this.engine = new ScenarioEngine({ scenario });
    this.speedMultiplier = this.validateSpeed(speedMultiplier);
    this.startedBy = userId;

    const run = await one(
      `INSERT INTO scenario_runs (scenario_id, run_label, state, seed, speed_multiplier, ins_enabled,
                                  started_by, config_snapshot)
       VALUES ($1,$2,'RUNNING',$3,$4,$5,$6,$7) RETURNING id, started_at`,
      [
        scenario.id,
        label,
        scenario.seed,
        this.speedMultiplier,
        scenario.ins_enabled,
        userId,
        JSON.stringify({
          requirements: getConfig().requirements,
          gnss_integrity: getConfig().gnss_integrity,
          integrity: getConfig().integrity,
          fusion: getConfig().fusion,
          dead_reckoning: getConfig().dead_reckoning
        })
      ]
    );
    this.runId = run.id;

    recorder.start(this.runId);
    alarmService.startRun(this.runId);
    this.recordedTransitions = 0;
    this.engine.state = ScenarioState.RUNNING;
    this.state = ScenarioState.RUNNING;
    this.lastTickWallMs = Date.now();
    this.startLoop();

    log.info('scenario started', { scenario_id: scenario.id, run_id: this.runId, speed: this.speedMultiplier });
    this.emit('state', this.status());
    return this.status();
  }

  validateSpeed(value) {
    const allowed = getConfig().simulation.allowed_speed_multipliers;
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    // Snap to the nearest allowed multiplier so the UI and the engine agree.
    return allowed.reduce((best, m) => (Math.abs(m - n) < Math.abs(best - n) ? m : best), allowed[0]);
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.error = err.message;
        log.error('runtime tick failed', err);
      });
    }, LOOP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One wall-clock tick: advance simulated time and publish. */
  async tick() {
    if (!this.engine || this.state !== ScenarioState.RUNNING) return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const wallDelta = (now - (this.lastTickWallMs ?? now)) / 1000;
      this.lastTickWallMs = now;
      // Bound the catch-up after a stall so the loop cannot spiral.
      const simDelta = Math.min(5, wallDelta * this.speedMultiplier);

      const { outputs, truths, messages } = this.engine.advance(simDelta);
      this.recordMessages(messages);
      for (let i = 0; i < outputs.length; i += 1) {
        await this.publish(outputs[i], truths[i]);
      }

      if (this.engine.complete) {
        await this.complete();
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Record the raw sensor stream.
   *
   * The ingestion decision (accepted / rejected and why) is attached to each
   * message so the audit trail answers "what did the system receive, and what
   * did it do with it?" - which is the whole point of keeping the raw stream.
   */
  recordMessages(messages) {
    if (!messages?.length) return;
    const decisions = new Map();
    for (const d of this.engine.pipeline.drainMessageDecisions()) {
      decisions.set(`${d.sensor_id}:${d.sequence_number}`, d);
    }
    for (const item of messages) {
      const d = decisions.get(`${item.message.sensor_id}:${item.message.sequence_number}`);
      recorder.recordSensorMessage(item.message, {
        simTimeS: item.sim_time_s,
        decision: d?.decision ?? null,
        reason: d?.reason ?? null
      });
    }
  }

  /** Record and broadcast one published epoch. */
  async publish(output, truth) {
    this.lastOutput = output;

    recorder.recordNavigationSolution(output);
    recorder.recordGnssTrust(output);
    recorder.recordResiduals(output);
    recorder.recordSensorHealth(output);
    if (truth) recorder.recordGroundTruth(truth);

    // Mode transitions accumulate in the manager; record only new ones.
    const transitions = this.engine.pipeline.modeManager.transitions;
    this.recordedTransitions = this.recordedTransitions ?? 0;
    for (let i = this.recordedTransitions; i < transitions.length; i += 1) {
      recorder.recordModeTransition(transitions[i]);
      this.emit('mode_transition', transitions[i]);
    }
    this.recordedTransitions = transitions.length;

    const alarmRequests = this.engine.pipeline.drainAlarms();
    const raised = await alarmService.raiseAll(alarmRequests);
    for (const event of this.engine.drainEvents()) recorder.recordScenarioEvent(event, this.startedBy);
    await alarmService.autoClear();

    this.emit('epoch', {
      output,
      alarms: raised,
      active_alarms: alarmService.snapshot(),
      scenario: this.engine.snapshot()
    });
  }

  /** Scenario reached its configured duration. */
  async complete() {
    this.state = ScenarioState.COMPLETED;
    this.engine.state = ScenarioState.COMPLETED;
    this.stopLoop();
    await recorder.flush();
    await query(
      `UPDATE scenario_runs SET state='COMPLETED', ended_at=now(), duration_s=$2 WHERE id=$1`,
      [this.runId, this.engine.time]
    );
    log.info('scenario complete', { run_id: this.runId, sim_time_s: this.engine.time });
    this.emit('state', this.status());
    this.emit('completed', { run_id: this.runId, scenario_id: this.engine.scenario.id });
  }

  async pause() {
    if (this.state !== ScenarioState.RUNNING) return this.status();
    this.state = ScenarioState.PAUSED;
    if (this.engine) this.engine.state = ScenarioState.PAUSED;
    this.stopLoop();
    await recorder.flush();
    this.engine?.recordEvent('CONTROL', 'Paused');
    this.emit('state', this.status());
    return this.status();
  }

  async resume() {
    if (this.state !== ScenarioState.PAUSED) return this.status();
    this.state = ScenarioState.RUNNING;
    if (this.engine) this.engine.state = ScenarioState.RUNNING;
    this.lastTickWallMs = Date.now();
    this.startLoop();
    this.engine?.recordEvent('CONTROL', 'Resumed');
    this.emit('state', this.status());
    return this.status();
  }

  async stop({ userId = null } = {}) {
    this.stopLoop();
    if (this.engine) this.engine.state = ScenarioState.STOPPED;
    this.state = ScenarioState.STOPPED;
    if (this.runId) {
      this.engine?.recordEvent('CONTROL', 'Stopped');
      for (const event of this.engine?.drainEvents() ?? []) recorder.recordScenarioEvent(event, userId);
      await recorder.stop();
      await query(
        `UPDATE scenario_runs SET state='STOPPED', ended_at=now(), duration_s=$2 WHERE id=$1 AND ended_at IS NULL`,
        [this.runId, this.engine?.time ?? 0]
      );
    }
    this.emit('state', this.status());
    return this.status();
  }

  /** Reset to the beginning of the same scenario, in a fresh run record. */
  async reset({ userId = null } = {}) {
    if (!this.engine) return this.status();
    const scenarioId = this.engine.scenario.id;
    const speed = this.speedMultiplier;
    const insEnabled = this.engine.scenario.ins_enabled !== false;
    await this.stop({ userId });
    return this.start(scenarioId, { userId, speedMultiplier: speed, insEnabled });
  }

  /** Advance a fixed amount of simulated time while paused. */
  async step(seconds = 1) {
    if (!this.engine) throw Object.assign(new Error('No scenario is loaded'), { status: 409 });
    if (this.state === ScenarioState.RUNNING) {
      throw Object.assign(new Error('Pause the scenario before stepping'), { status: 409 });
    }
    const { outputs, truths, messages } = this.engine.advance(Math.max(0.1, Math.min(60, seconds)));
    this.recordMessages(messages);
    for (let i = 0; i < outputs.length; i += 1) await this.publish(outputs[i], truths[i]);
    this.engine.recordEvent('CONTROL', `Stepped ${seconds} s`);
    return this.status();
  }

  setSpeed(multiplier) {
    this.speedMultiplier = this.validateSpeed(multiplier);
    this.engine?.recordEvent('CONTROL', `Speed set to ${this.speedMultiplier}x`);
    this.emit('state', this.status());
    return this.status();
  }

  /** Jump forward to a scenario time. Simulated time cannot run backwards. */
  async jumpTo(targetTimeS) {
    if (!this.engine) throw Object.assign(new Error('No scenario is loaded'), { status: 409 });
    const target = Math.max(0, Math.min(this.engine.durationS, Number(targetTimeS)));
    if (target < this.engine.time) {
      throw Object.assign(
        new Error(
          'Simulated time cannot run backwards. Reset the scenario and run forward to reach an earlier time.'
        ),
        { status: 400 }
      );
    }
    const wasRunning = this.state === ScenarioState.RUNNING;
    this.stopLoop();
    // Advance in bounded chunks so the event loop is not blocked.
    while (this.engine.time < target && !this.engine.complete) {
      const { outputs, truths, messages } = this.engine.advance(Math.min(10, target - this.engine.time));
      this.recordMessages(messages);
      for (let i = 0; i < outputs.length; i += 1) await this.publish(outputs[i], truths[i]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.engine.recordEvent('CONTROL', `Jumped to ${target.toFixed(1)} s`);
    if (wasRunning) {
      this.lastTickWallMs = Date.now();
      this.startLoop();
    }
    return this.status();
  }

  /** Inject a fault at runtime. */
  injectFault(spec, userId = null) {
    if (!this.engine) throw Object.assign(new Error('No scenario is loaded'), { status: 409 });
    const fault = this.engine.injectFault(spec);
    for (const event of this.engine.drainEvents()) recorder.recordScenarioEvent(event, userId);
    this.emit('state', this.status());
    return fault;
  }

  /** Remove an injected fault. */
  removeFault(faultId, userId = null) {
    if (!this.engine) throw Object.assign(new Error('No scenario is loaded'), { status: 409 });
    const removed = this.engine.removeFault(faultId);
    if (!removed) throw Object.assign(new Error(`Unknown fault ${faultId}`), { status: 404 });
    for (const event of this.engine.drainEvents()) recorder.recordScenarioEvent(event, userId);
    this.emit('state', this.status());
    return removed;
  }

  /** The fault catalogue, for the injection form. */
  faultCatalogue() {
    return Object.entries(FAULT_TYPES).map(([type, def]) => ({ type, ...def }));
  }

  /** Latest published navigation output. */
  current() {
    return this.lastOutput;
  }

  /** Operator action: latch manual fallback. */
  setManualFallback(enabled) {
    if (!this.engine) throw Object.assign(new Error('No scenario is loaded'), { status: 409 });
    const value = this.engine.pipeline.modeManager.setManualFallback(enabled);
    this.engine.recordEvent('CONTROL', `Manual fallback ${value ? 'engaged' : 'cleared'}`);
    return value;
  }

  /** Graceful shutdown. */
  async shutdown() {
    this.stopLoop();
    await recorder.stop();
  }
}

export const scenarioService = new ScenarioService();
export default scenarioService;
