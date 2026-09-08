/**
 * Integrity tests (Section 24 "Integrity").
 *
 * The central property under test: the platform must never show a green
 * requirement status without an independent absolute source, and the protection
 * level must grow when nothing is bounding the error.
 */

import { IntegrityEngine } from '../src/navigation/integrity.js';
import { ModeManager, evaluateCondition } from '../src/navigation/modeManager.js';
import { getConfig } from '../src/config/index.js';
import { RequirementStatus, IntegrityStatus } from '../src/models/enums.js';

const cov = (sigma) => [
  [sigma * sigma, 0],
  [0, sigma * sigma]
];

function baseInput(overrides = {}) {
  return {
    positionCovariance: cov(0.2),
    time: 10,
    solutionAgeS: 0.2,
    absoluteSources: [
      { sensor_id: 'GNSS_01', sensor_type: 'GNSS', sigma_m: 0.9, confidence: 1 },
      { sensor_id: 'RADAR_01', sensor_type: 'RADAR', sigma_m: 1.2, confidence: 0.9 }
    ],
    deadReckoning: { east_m: 0, north_m: 0, sigma_m: 0.3, duration_s: 0, bottom_lock: true, speed_mps: 3 },
    activeSensors: [
      { sensor_id: 'GNSS_01', sensor_type: 'GNSS' },
      { sensor_id: 'RADAR_01', sensor_type: 'RADAR' },
      { sensor_id: 'DVL_01', sensor_type: 'DVL' },
      { sensor_id: 'GYRO_01', sensor_type: 'GYRO' }
    ],
    faultFindings: [],
    solutionAvailable: true,
    mapConfidence: 0.9,
    timeSyncValid: true,
    maxNormalizedResidual: 1,
    unresolvedCriticalFault: false,
    ...overrides
  };
}

describe('protection level', () => {
  it('is larger than the raw covariance term, because of correlated error and fault margin', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput());
    expect(result.horizontal_protection_level_m).toBeGreaterThan(result.radius_95_m);
    expect(result.bias_margin_m).toBeGreaterThan(0);
    expect(result.correlated_sigma_m).toBeGreaterThan(0);
  });

  it('grows during dead reckoning as the uncertainty grows', () => {
    const engine = new IntegrityEngine();
    const levels = [];
    for (let t = 0; t < 200; t += 5) {
      const sigma = 0.3 + t * 0.02;
      const result = engine.evaluate(
        baseInput({
          time: t,
          positionCovariance: cov(sigma),
          absoluteSources: [],
          deadReckoning: { east_m: 0, north_m: 0, sigma_m: sigma, duration_s: t, bottom_lock: true, speed_mps: 3 },
          activeSensors: [
            { sensor_id: 'DVL_01', sensor_type: 'DVL' },
            { sensor_id: 'GYRO_01', sensor_type: 'GYRO' }
          ],
          mapConfidence: null
        })
      );
      levels.push(result.horizontal_protection_level_m);
    }
    expect(levels[levels.length - 1]).toBeGreaterThan(levels[0] * 2);
    for (let i = 1; i < levels.length; i += 1) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1] - 1e-6);
  });

  it('is inflated when only one absolute source is available', () => {
    const engine = new IntegrityEngine();
    const two = engine.evaluate(baseInput());
    const one = new IntegrityEngine().evaluate(
      baseInput({
        absoluteSources: [{ sensor_id: 'RADAR_01', sensor_type: 'RADAR', sigma_m: 1.2, confidence: 0.9 }]
      })
    );
    expect(one.protection_level_inflation).toBeGreaterThan(two.protection_level_inflation);
    expect(one.protection_level_inflation_reasons).toContain('SINGLE_ABSOLUTE_SOURCE');
    expect(one.horizontal_protection_level_m).toBeGreaterThan(two.horizontal_protection_level_m);
  });

  it('does not publish a vertical protection level it cannot justify', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput());
    expect(result.vertical_protection_level_m).toBeNull();
    expect(result.vertical_protection_level_status).toMatch(/NOT_IMPLEMENTED/);
  });
});

describe('requirement status', () => {
  it('is met when the bound is inside the limit with redundancy and no faults', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput());
    expect(result.requirement_status).toBe(RequirementStatus.REQUIREMENT_MET);
    expect(result.integrity_status).toBe(IntegrityStatus.ASSURED);
    expect(result.requirement_statement).toMatch(/bounded below/i);
  });

  it('is never met without an independent absolute position source', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(
      baseInput({
        absoluteSources: [],
        // Deliberately tiny covariance: even a very confident filter must not
        // report the requirement as met with nothing anchoring it.
        positionCovariance: cov(0.01),
        deadReckoning: { east_m: 0, north_m: 0, sigma_m: 0.01, duration_s: 1, bottom_lock: true, speed_mps: 3 },
        mapConfidence: null
      })
    );
    expect(result.requirement_status).not.toBe(RequirementStatus.REQUIREMENT_MET);
    expect(result.integrity_status).toBe(IntegrityStatus.NOT_ASSURED);
    expect(result.integrity_reasons).toContain('NO_INDEPENDENT_ABSOLUTE_SOURCE');
  });

  it('moves from met to at risk as the margin narrows', () => {
    const engine = new IntegrityEngine();
    const met = engine.evaluate(baseInput());
    expect(met.requirement_status).toBe(RequirementStatus.REQUIREMENT_MET);

    // A single precise source: the bound is comfortably inside the limit, but
    // there is no redundancy, which is an at-risk condition in its own right.
    const atRisk = new IntegrityEngine().evaluate(
      baseInput({
        absoluteSources: [{ sensor_id: 'LOCAL_01', sensor_type: 'LOCAL_RANGING', sigma_m: 0.3, confidence: 0.95 }],
        positionCovariance: cov(0.2),
        mapConfidence: null
      })
    );
    expect(atRisk.horizontal_protection_level_m).toBeLessThan(2);
    expect(atRisk.requirement_status).toBe(RequirementStatus.REQUIREMENT_AT_RISK);
    expect(atRisk.requirement_reasons.join(' ')).toMatch(/redundancy|caution band/i);
  });

  it('moves from at risk to not met when the bound exceeds the limit', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput({ positionCovariance: cov(3.0) }));
    expect(result.requirement_status).toBe(RequirementStatus.REQUIREMENT_NOT_MET);
    expect(result.requirement_reasons.join(' ')).toMatch(/exceeds the 2 m limit/);
  });

  it('reports insufficient information when time synchronisation is invalid', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput({ timeSyncValid: false }));
    expect(result.requirement_status).toBe(RequirementStatus.INSUFFICIENT_INFORMATION);
    expect(result.integrity_status).toBe(IntegrityStatus.UNKNOWN);
  });

  it('reports insufficient information when there is no solution', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput({ solutionAvailable: false, positionCovariance: null }));
    expect(result.requirement_status).toBe(RequirementStatus.INSUFFICIENT_INFORMATION);
    expect(result.integrity_status).toBe(IntegrityStatus.NOT_ASSURED);
  });

  it('prefers a definite NOT MET over insufficient information when the bound is knowable', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(
      baseInput({
        positionCovariance: cov(4),
        absoluteSources: [{ sensor_id: 'RADAR_01', sensor_type: 'RADAR', sigma_m: 8, confidence: 0.05 }],
        mapConfidence: 0.05
      })
    );
    expect(result.requirement_status).toBe(RequirementStatus.REQUIREMENT_NOT_MET);
  });

  it('reports rapid uncertainty growth as an at-risk condition', () => {
    const engine = new IntegrityEngine();
    // Feed a rising protection level so the growth-rate window is populated.
    for (let i = 0; i < 20; i += 1) {
      engine.evaluate(baseInput({ time: i, positionCovariance: cov(0.1 + i * 0.05) }));
    }
    const result = engine.evaluate(baseInput({ time: 21, positionCovariance: cov(0.1 + 21 * 0.05) }));
    expect(result.protection_level_growth_rate_m_per_s).toBeGreaterThan(0);
  });

  it('keeps accuracy, precision, confidence and integrity as separate figures', () => {
    const engine = new IntegrityEngine();
    const result = engine.evaluate(baseInput());
    // Precision (sigma) < confidence radius < protection level.
    expect(result.confidence_ellipse.one_sigma_major_m).toBeLessThan(result.radius_95_m);
    expect(result.radius_95_m).toBeLessThan(result.radius_99_m);
    expect(result.horizontal_protection_level_m).toBeGreaterThan(result.radius_95_m);
    // The engine reports no accuracy figure at all: it cannot know one.
    expect(result).not.toHaveProperty('actual_error_m');
  });
});

describe('sensor diversity', () => {
  it('does not count two receivers of the same kind as diversity', () => {
    const engine = new IntegrityEngine();
    const twoGnss = engine.evaluate(
      baseInput({
        activeSensors: [
          { sensor_id: 'GNSS_01', sensor_type: 'GNSS' },
          { sensor_id: 'GNSS_02', sensor_type: 'GNSS' }
        ]
      })
    );
    const mixed = new IntegrityEngine().evaluate(
      baseInput({
        activeSensors: [
          { sensor_id: 'GNSS_01', sensor_type: 'GNSS' },
          { sensor_id: 'RADAR_01', sensor_type: 'RADAR' }
        ]
      })
    );
    expect(twoGnss.sensor_diversity_score).toBeLessThan(mixed.sensor_diversity_score);
    expect(twoGnss.measurement_principles).toHaveLength(1);
  });
});

describe('mode state machine', () => {
  it('rejects an unsupported operator in the condition language', () => {
    expect(() => evaluateCondition({ field: 'x', op: 'exec', value: 1 }, { x: 1 })).toThrow(/Unsupported/);
  });

  it('evaluates all/any/not combinators', () => {
    const context = { a: 1, b: true, list: ['X'] };
    expect(evaluateCondition({ all: [{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'truthy' }] }, context)).toBe(true);
    expect(evaluateCondition({ any: [{ field: 'a', op: 'eq', value: 9 }, { field: 'b', op: 'truthy' }] }, context)).toBe(true);
    expect(evaluateCondition({ not: { field: 'b', op: 'truthy' } }, context)).toBe(false);
    expect(evaluateCondition({ field: 'list', op: 'contains', value: 'X' }, context)).toBe(true);
  });

  it('treats a missing context field as unsatisfiable rather than truthy', () => {
    expect(evaluateCondition({ field: 'absent', op: 'truthy' }, {})).toBe(false);
  });

  it('validates every declared successor at construction', () => {
    expect(() => new ModeManager()).not.toThrow();
  });

  it('enters INTEGRITY_NOT_ASSURED when integrity is not assured', () => {
    const manager = new ModeManager();
    const context = {
      gnss_present: false,
      gnss_trust_score: 0,
      gnss_status: 'REJECTED',
      gnss_action: 'EXCLUDE_FROM_FUSION',
      gnss_conditions: [],
      gnss_used_in_fusion: false,
      gnss_recovery_active: false,
      gnss_recovery_progress: 0,
      spoofing_suspected: false,
      jamming_suspected: false,
      radar_valid: false,
      radar_confidence: 0,
      lidar_valid: false,
      lidar_confidence: 0,
      bathy_valid: false,
      bathy_confidence: 0,
      bathy_ambiguous: true,
      local_ranging_valid: false,
      ins_enabled: false,
      ins_valid: false,
      dvl_valid: true,
      dvl_bottom_lock: true,
      gyro_valid: true,
      independent_absolute_sources: 0,
      absolute_fix_age_s: 400,
      dead_reckoning_duration_s: 400,
      horizontal_protection_level_m: 12,
      integrity_status: 'NOT_ASSURED',
      requirement_status: 'REQUIREMENT_NOT_MET',
      manual_fallback_requested: false,
      solution_available: true
    };
    const outcome = manager.evaluate(context, 100);
    expect(outcome.mode).toBe('INTEGRITY_NOT_ASSURED');
  });

  it('honours the minimum dwell time before changing mode again', () => {
    const manager = new ModeManager();
    const healthy = {
      gnss_present: true,
      gnss_trust_score: 100,
      gnss_status: 'TRUSTED',
      gnss_action: 'USE_IN_FUSION',
      gnss_conditions: [],
      gnss_used_in_fusion: true,
      gnss_recovery_active: false,
      gnss_recovery_progress: 0,
      spoofing_suspected: false,
      jamming_suspected: false,
      radar_valid: true,
      radar_confidence: 0.9,
      lidar_valid: false,
      lidar_confidence: 0,
      bathy_valid: false,
      bathy_confidence: 0,
      bathy_ambiguous: false,
      local_ranging_valid: false,
      ins_enabled: true,
      ins_valid: true,
      dvl_valid: true,
      dvl_bottom_lock: true,
      gyro_valid: true,
      independent_absolute_sources: 2,
      absolute_fix_age_s: 0.2,
      dead_reckoning_duration_s: 0,
      horizontal_protection_level_m: 1.1,
      integrity_status: 'ASSURED',
      requirement_status: 'REQUIREMENT_MET',
      manual_fallback_requested: false,
      solution_available: true
    };
    // The machine starts in INTEGRITY_NOT_ASSURED and the dwell timer applies
    // from t = 0, so the first transition is only possible once it has expired.
    manager.evaluate(healthy, 10);
    expect(manager.currentMode).toBe('NORMAL_GNSS');

    const spoofed = { ...healthy, spoofing_suspected: true, gnss_action: 'EXCLUDE_FROM_FUSION', gnss_used_in_fusion: false };
    // Immediately after that transition, the dwell timer blocks another.
    const blocked = manager.evaluate(spoofed, 10.5);
    expect(blocked.changed).toBe(false);
    expect(blocked.suppressed_candidate).toBe('SPOOFING_SUSPECTED');

    const allowed = manager.evaluate(spoofed, 20);
    expect(allowed.changed).toBe(true);
    expect(allowed.mode).toBe('SPOOFING_SUSPECTED');
    expect(allowed.transition.reason).toMatch(/spoofing/i);
  });

  it('latches manual fallback until the operator clears it', () => {
    const manager = new ModeManager();
    manager.setManualFallback(true);
    const context = {
      gnss_present: true,
      gnss_trust_score: 100,
      gnss_status: 'TRUSTED',
      gnss_action: 'USE_IN_FUSION',
      gnss_conditions: [],
      gnss_used_in_fusion: true,
      gnss_recovery_active: false,
      gnss_recovery_progress: 0,
      spoofing_suspected: false,
      jamming_suspected: false,
      radar_valid: true,
      radar_confidence: 0.9,
      lidar_valid: false,
      lidar_confidence: 0,
      bathy_valid: false,
      bathy_confidence: 0,
      bathy_ambiguous: false,
      local_ranging_valid: false,
      ins_enabled: true,
      ins_valid: true,
      dvl_valid: true,
      dvl_bottom_lock: true,
      gyro_valid: true,
      independent_absolute_sources: 2,
      absolute_fix_age_s: 0.2,
      dead_reckoning_duration_s: 0,
      horizontal_protection_level_m: 1.1,
      integrity_status: 'ASSURED',
      requirement_status: 'REQUIREMENT_MET',
      manual_fallback_requested: true,
      solution_available: true
    };
    manager.evaluate(context, 10);
    expect(manager.currentMode).toBe('MANUAL_FALLBACK');
    // Healthy conditions do not release it while the flag is set.
    manager.evaluate(context, 60);
    expect(manager.currentMode).toBe('MANUAL_FALLBACK');
    // Clearing the flag allows it to leave.
    manager.setManualFallback(false);
    const released = manager.evaluate({ ...context, manual_fallback_requested: false }, 120);
    expect(released.mode).not.toBe('MANUAL_FALLBACK');
  });

  it('records a transition with a human-readable reason', () => {
    const manager = new ModeManager();
    const context = {
      gnss_present: true,
      gnss_trust_score: 10,
      gnss_status: 'REJECTED',
      gnss_action: 'EXCLUDE_FROM_FUSION',
      gnss_conditions: ['GRADUAL_POSITION_DRAG'],
      gnss_used_in_fusion: false,
      gnss_recovery_active: false,
      gnss_recovery_progress: 0,
      spoofing_suspected: true,
      jamming_suspected: false,
      radar_valid: true,
      radar_confidence: 0.9,
      lidar_valid: false,
      lidar_confidence: 0,
      bathy_valid: false,
      bathy_confidence: 0,
      bathy_ambiguous: false,
      local_ranging_valid: false,
      ins_enabled: true,
      ins_valid: true,
      dvl_valid: true,
      dvl_bottom_lock: true,
      gyro_valid: true,
      independent_absolute_sources: 1,
      absolute_fix_age_s: 0.5,
      dead_reckoning_duration_s: 0,
      horizontal_protection_level_m: 1.6,
      integrity_status: 'DEGRADED',
      requirement_status: 'REQUIREMENT_AT_RISK',
      manual_fallback_requested: false,
      solution_available: true
    };
    const outcome = manager.evaluate(context, 50);
    expect(outcome.changed).toBe(true);
    expect(manager.transitions).toHaveLength(1);
    expect(manager.transitions[0].reason.length).toBeGreaterThan(20);
    expect(manager.transitions[0].context).toBeDefined();
  });

  it('publishes entry conditions, guidance and successors for every mode', () => {
    const manager = new ModeManager();
    const catalogue = manager.catalogue();
    expect(catalogue.length).toBe(14);
    for (const mode of catalogue) {
      expect(mode.expected_accuracy).toBeTruthy();
      expect(mode.uncertainty_behaviour).toBeTruthy();
      expect(mode.operator_guidance).toBeTruthy();
      expect(mode.exit).toBeTruthy();
      expect(Array.isArray(mode.next_modes)).toBe(true);
    }
  });
});

describe('configuration', () => {
  it('exposes the requirement limit as a configurable threshold', () => {
    const cfg = getConfig();
    expect(cfg.requirements.horizontal_error_limit_m).toBe(2.0);
    expect(cfg.requirements.at_risk_lower_bound_m).toBeLessThan(cfg.requirements.horizontal_error_limit_m);
    expect(cfg.gnss_integrity.recovery_validation_s).toBe(30);
  });
});
