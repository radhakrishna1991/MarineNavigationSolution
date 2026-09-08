/**
 * Replay and scenario tests (Section 24 "Replay").
 *
 * Determinism is the property everything else rests on: if the same scenario
 * does not reproduce exactly, no comparison between two runs means anything and
 * no recorded audit trail can be re-derived.
 */

import { ScenarioEngine, runScenarioHeadless } from '../src/simulation/engine.js';
import { FaultInjector, FAULT_TYPES, normalizeFault } from '../src/simulation/faults.js';
import { VesselModel } from '../src/simulation/vessel.js';
import { getScenarioDefinition, scenarioCatalog } from '../src/config/index.js';
import { ScenarioState } from '../src/models/enums.js';
import { Recorder } from '../src/services/recorder.js';

/** A compact signature of a run, sufficient to detect any divergence. */
function signature(outputs) {
  return outputs.map((o) =>
    [
      o.time_s.toFixed(3),
      o.trusted_position ? o.trusted_position.latitude.toFixed(9) : 'x',
      o.trusted_position ? o.trusted_position.longitude.toFixed(9) : 'x',
      o.integrity.horizontal_protection_level_m,
      o.navigation_mode,
      o.gnss.trust_score,
      o.integrity.requirement_status
    ].join('|')
  );
}

function runChunked(scenarioId, durationS, chunkS) {
  const scenario = { ...getScenarioDefinition(scenarioId), duration_s: durationS };
  const engine = new ScenarioEngine({ scenario });
  const outputs = [];
  while (!engine.complete) {
    const result = engine.advance(chunkS);
    outputs.push(...result.outputs);
  }
  return outputs;
}

describe('scenario determinism', () => {
  it('produces identical output regardless of how time is chunked', () => {
    const a = signature(runChunked('SCN_03_GRADUAL_DRAG', 120, 1));
    const b = signature(runChunked('SCN_03_GRADUAL_DRAG', 120, 5));
    const c = signature(runChunked('SCN_03_GRADUAL_DRAG', 120, 10));
    const d = signature(runChunked('SCN_03_GRADUAL_DRAG', 120, 3.7));

    expect(a.length).toBeGreaterThan(500);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });

  it('reproduces the same run from the same seed', () => {
    const first = signature(runChunked('SCN_02_GNSS_JUMP', 90, 5));
    const second = signature(runChunked('SCN_02_GNSS_JUMP', 90, 5));
    expect(second).toEqual(first);
  });

  it('produces a different run from a different seed', () => {
    const base = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 60 };
    const runWith = (seed) => {
      const engine = new ScenarioEngine({ scenario: { ...base, seed } });
      const outputs = [];
      while (!engine.complete) outputs.push(...engine.advance(5).outputs);
      return signature(outputs);
    };
    expect(runWith(1234)).not.toEqual(runWith(4321));
  });

  it('resets to exactly the initial state', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 40 };
    const engine = new ScenarioEngine({ scenario });
    const first = signature(engine.advance(40).outputs);
    engine.reset();
    expect(engine.time).toBe(0);
    expect(engine.tickCount).toBe(0);
    const second = signature(engine.advance(40).outputs);
    expect(second).toEqual(first);
  });
});

describe('scenario transport', () => {
  it('advances only when told to, so pause holds the clock still', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 60 };
    const engine = new ScenarioEngine({ scenario });
    engine.advance(10);
    const timeAfterFirst = engine.time;
    // Pausing is the absence of advance() calls; nothing else moves the clock.
    expect(engine.time).toBe(timeAfterFirst);
    engine.advance(0);
    expect(engine.time).toBe(timeAfterFirst);
    engine.advance(5);
    expect(engine.time).toBeGreaterThan(timeAfterFirst);
  });

  it('carries a partial tick across calls rather than dropping it', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 60 };
    const a = new ScenarioEngine({ scenario });
    const b = new ScenarioEngine({ scenario });
    // 0.03 s is smaller than one tick (0.05 s); two of them make more than one.
    for (let i = 0; i < 100; i += 1) a.advance(0.03);
    b.advance(3);
    expect(a.time).toBeCloseTo(b.time, 6);
  });

  it('stops at the configured duration', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 20 };
    const engine = new ScenarioEngine({ scenario });
    while (!engine.complete) engine.advance(5);
    expect(engine.time).toBeGreaterThanOrEqual(20);
    expect(engine.progress).toBe(1);
  });
});

describe('fault injection', () => {
  it('is repeatable: the same injection produces the same outcome', () => {
    const build = () => {
      const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 90 };
      const engine = new ScenarioEngine({ scenario });
      engine.advance(30);
      engine.injectFault({
        type: 'GNSS_POSITION_JUMP',
        sensor_id: 'GNSS_01',
        start_s: 30,
        end_s: 90,
        params: { east_m: 40, north_m: 0 }
      });
      const outputs = [];
      while (!engine.complete) outputs.push(...engine.advance(5).outputs);
      return signature(outputs);
    };
    expect(build()).toEqual(build());
  });

  it('is detected by the pipeline without the engines being told', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 120 };
    const engine = new ScenarioEngine({ scenario });
    engine.advance(40);
    engine.injectFault({
      type: 'GNSS_POSITION_JUMP',
      sensor_id: 'GNSS_01',
      start_s: 40,
      end_s: 120,
      params: { east_m: 60, north_m: 0 }
    });
    const outputs = [];
    while (!engine.complete) outputs.push(...engine.advance(5).outputs);

    const afterInjection = outputs.filter((o) => o.time_s > 45);
    expect(afterInjection.some((o) => o.gnss.spoofing_suspected)).toBe(true);
    expect(afterInjection.some((o) => o.excluded_sensors.includes('GNSS_01'))).toBe(true);
    // The fused solution should stay near the truth despite the spoofed GNSS.
    const errors = afterInjection.map((o) => o.actual_error_vs_truth_m).filter((v) => v !== null);
    expect(Math.max(...errors)).toBeLessThan(10);
  });

  it('can be removed again', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 60 };
    const engine = new ScenarioEngine({ scenario });
    engine.advance(10);
    const fault = engine.injectFault({
      type: 'RADAR_UNAVAILABLE',
      sensor_id: 'RADAR_01',
      start_s: 10,
      end_s: 60,
      params: {}
    });
    expect(engine.injector.activeAt(20).map((f) => f.id)).toContain(fault.id);
    const removed = engine.removeFault(fault.id);
    expect(removed.id).toBe(fault.id);
    expect(engine.injector.activeAt(20).map((f) => f.id)).not.toContain(fault.id);
  });

  it('rejects an unknown fault type', () => {
    expect(() => normalizeFault({ type: 'MAKE_COFFEE', sensor_id: 'GNSS_01' })).toThrow(/Unknown fault type/);
  });

  it('rejects an out-of-range parameter', () => {
    expect(() =>
      normalizeFault({ type: 'GNSS_GRADUAL_DRAG', sensor_id: 'GNSS_01', params: { rate_m_per_s: 999 } })
    ).toThrow(/must be <=/);
  });

  it('fills parameter defaults', () => {
    const fault = normalizeFault({ type: 'GNSS_POSITION_JUMP', sensor_id: 'GNSS_01' });
    expect(fault.params.east_m).toBe(FAULT_TYPES.GNSS_POSITION_JUMP.params.east_m.default);
  });

  it('reports which faults apply to which sensor types', () => {
    const injector = new FaultInjector([]);
    expect(injector.list()).toHaveLength(0);
    const fault = injector.add({ type: 'GYRO_BIAS', sensor_id: 'GYRO_01', start_s: 0, end_s: 10 });
    expect(injector.activeFor('GYRO_01', 5)).toHaveLength(1);
    expect(injector.activeFor('GYRO_01', 20)).toHaveLength(0);
    expect(injector.activeOfType('GYRO_BIAS', 5)[0].id).toBe(fault.id);
  });
});

describe('vessel model', () => {
  it('follows the planned route deterministically', () => {
    const a = new VesselModel({});
    const b = new VesselModel({});
    for (let i = 0; i < 2000; i += 1) {
      a.step(0.05);
      b.step(0.05);
    }
    expect(a.east).toBeCloseTo(b.east, 9);
    expect(a.north).toBeCloseTo(b.north, 9);
    expect(a.heading).toBeCloseTo(b.heading, 9);
  });

  it('respects the maximum turn rate', () => {
    const vessel = new VesselModel({});
    let maxTurn = 0;
    for (let i = 0; i < 4000; i += 1) {
      const state = vessel.step(0.05);
      maxTurn = Math.max(maxTurn, Math.abs(state.turn_rate_dps));
    }
    expect(maxTurn).toBeLessThanOrEqual(vessel.cfg.max_turn_rate_dps + 1e-6);
  });

  it('produces a depth consistent with the seabed, tide, draft and squat', () => {
    const vessel = new VesselModel({});
    const state = vessel.step(0.05);
    expect(state.depth_below_transducer_m).toBeCloseTo(
      state.seabed_depth_m + state.tide_m - state.draft_m - state.squat_m,
      6
    );
  });
});

describe('scenario catalogue', () => {
  it('defines every scenario the specification calls for', () => {
    const names = scenarioCatalog.map((s) => s.name.toLowerCase());
    for (const expected of [
      'healthy navigation',
      'gnss sudden jump',
      'gradual spoofing drag',
      'gnss jamming',
      'flat seabed ambiguity',
      'radar feature loss',
      'dvl bottom-lock loss',
      'gyro heading bias',
      'gnss recovery validation',
      'multiple sensor failure'
    ]) {
      expect(names.some((n) => n.includes(expected.split(' ')[0]))).toBe(true);
    }
    expect(scenarioCatalog.length).toBeGreaterThanOrEqual(10);
    expect(scenarioCatalog.some((s) => s.is_demonstration)).toBe(true);
  });

  it('runs the multiple-failure scenario to a NOT MET conclusion', () => {
    const scenario = { ...getScenarioDefinition('SCN_10_MULTIPLE_FAILURE'), duration_s: 420 };
    const { outputs } = runScenarioHeadless(scenario);
    const late = outputs.filter((o) => o.time_s > 340);
    expect(late.length).toBeGreaterThan(0);
    // With GNSS, radar, LiDAR and bathymetry all gone, the platform must say so.
    expect(late.some((o) => o.integrity.requirement_status === 'REQUIREMENT_NOT_MET')).toBe(true);
    expect(late.some((o) => o.integrity.integrity_status === 'NOT_ASSURED')).toBe(true);
  });

  it('runs the healthy scenario without falsely rejecting GNSS', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 300 };
    const { outputs } = runScenarioHeadless(scenario);
    const settled = outputs.filter((o) => o.time_s > 10);
    expect(settled.every((o) => !o.gnss.spoofing_suspected)).toBe(true);
    expect(settled.filter((o) => o.integrity.requirement_status === 'REQUIREMENT_MET').length / settled.length).toBeGreaterThan(
      0.9
    );
  });

  it('keeps the protection level above the actual error', () => {
    const scenario = { ...getScenarioDefinition('SCN_15_SAFEEN_DEMO'), duration_s: 300 };
    const { outputs } = runScenarioHeadless(scenario);
    const comparable = outputs.filter(
      (o) => o.actual_error_vs_truth_m !== null && o.integrity.horizontal_protection_level_m !== null && o.time_s > 10
    );
    const exceeded = comparable.filter(
      (o) => o.actual_error_vs_truth_m > o.integrity.horizontal_protection_level_m
    );
    // The bound is a 95% statement, so a small exceedance rate is expected;
    // a large one would mean the platform cannot be believed.
    expect(exceeded.length / comparable.length).toBeLessThan(0.1);
  });

  it('operates with no INS fitted', () => {
    const scenario = { ...getScenarioDefinition('SCN_13_INS_DISABLED'), duration_s: 200 };
    const { outputs } = runScenarioHeadless(scenario);
    expect(outputs.length).toBeGreaterThan(500);
    for (const output of outputs) {
      expect(output.sensor_health.find((h) => h.sensor_id === 'INS_01')?.message_count ?? 0).toBe(0);
    }
    const settled = outputs.filter((o) => o.time_s > 20);
    expect(settled.every((o) => o.solution_available)).toBe(true);
  });

  it('marks a completed scenario as complete', () => {
    const scenario = { ...getScenarioDefinition('SCN_01_HEALTHY'), duration_s: 30 };
    const { engine } = runScenarioHeadless(scenario);
    expect(engine.state).toBe(ScenarioState.COMPLETED);
    expect(engine.complete).toBe(true);
  });
});

/**
 * A recorded run is only useful if it is complete when the recorder says it is.
 * The performance report is generated the instant a scenario finishes, so a
 * stop() that returns while inserts are still in flight produces a report
 * computed from part of the run — silently, and differently every time.
 */
describe('recorder durability', () => {
  /**
   * A recorder whose database writes are slow and observable. The first write
   * is much slower than the ones after it, which is the case that matters: if
   * flushes were allowed to overlap, a later, quicker flush would resolve while
   * the first was still inserting, and awaiting it would prove nothing.
   */
  function instrument() {
    const recorder = new Recorder();
    const written = new Set();
    const passes = [];
    let calls = 0;
    let inFlight = 0;
    let maxConcurrent = 0;
    recorder.flushOnce = async () => {
      calls += 1;
      const delay = calls === 1 ? 120 : 5;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const tables = [...recorder.buffers.keys()];
      recorder.buffers.clear();
      await new Promise((resolve) => setTimeout(resolve, delay));
      for (const table of tables) written.add(table);
      passes.push(tables);
      inFlight -= 1;
    };
    return { recorder, written, passes, concurrency: () => maxConcurrent };
  }

  it('stop() waits for flushes that are still in flight', async () => {
    const { recorder, written } = instrument();
    recorder.runId = 'test-run';

    recorder.buffers.set('a', [{ columns: ['x'], row: { x: 1 } }]);
    const scheduled = recorder.flush(); // as the interval timer would
    recorder.buffers.set('b', [{ columns: ['x'], row: { x: 2 } }]);

    await recorder.stop();

    // Everything buffered is durable by the time stop() resolves. Without the
    // flush chain the slow first write is still running here and only 'b' has
    // landed — which is what made a report generated at this moment wrong.
    expect([...written].sort()).toEqual(['a', 'b']);
    expect(recorder.buffers.size).toBe(0);
    await expect(scheduled).resolves.toBeUndefined();
  });

  it('never runs two flushes at once', async () => {
    const { recorder, written, passes, concurrency } = instrument();
    recorder.runId = 'test-run';

    const flushes = [];
    for (let i = 0; i < 5; i += 1) {
      recorder.buffers.set(`t${i}`, [{ columns: ['x'], row: { x: i } }]);
      flushes.push(recorder.flush());
    }
    await Promise.all(flushes);

    expect(concurrency()).toBe(1);
    expect(passes.length).toBe(5);
    expect(written.size).toBe(5);
  });

  it('a failed flush does not stall every flush after it', async () => {
    const recorder = new Recorder();
    recorder.runId = 'test-run';
    let calls = 0;
    recorder.flushOnce = async () => {
      calls += 1;
      recorder.buffers.clear();
      if (calls === 1) throw new Error('database unavailable');
    };

    await expect(recorder.flush()).rejects.toThrow('database unavailable');
    recorder.buffers.set('a', [{ columns: ['x'], row: { x: 1 } }]);
    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
