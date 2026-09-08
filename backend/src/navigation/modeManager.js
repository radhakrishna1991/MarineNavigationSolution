/**
 * Navigation mode state machine (Section 5).
 *
 * The transition rules are data (`config/modes.yaml`), evaluated by a small
 * declarative predicate interpreter. There is no expression parsing and no
 * dynamic code evaluation, which keeps the "no arbitrary code execution"
 * requirement of Section 22 satisfiable by inspection.
 *
 * Evaluation order:
 *   1. Build a context object from the current engine outputs.
 *   2. Walk the modes in ascending priority.
 *   3. The first mode whose `entry` predicate is satisfied AND which is a legal
 *      successor of the current mode becomes the candidate.
 *   4. A minimum dwell time damps flapping between marginal modes.
 *   5. Latching modes (MANUAL_FALLBACK) are only left on explicit operator action.
 */

import { modeConfig, getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mode-manager');

const OPERATORS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  nin: (a, b) => Array.isArray(b) && !b.includes(a),
  contains: (a, b) => Array.isArray(a) && a.includes(b),
  not_contains: (a, b) => Array.isArray(a) && !a.includes(b),
  truthy: (a) => Boolean(a),
  falsy: (a) => !a
};

/**
 * Evaluate a declarative condition against a context.
 * Throws on an unknown operator so a configuration mistake fails loudly at
 * startup rather than silently allowing an unintended transition.
 */
export function evaluateCondition(condition, context) {
  if (!condition) return true;
  if (condition.all) return condition.all.every((c) => evaluateCondition(c, context));
  if (condition.any) return condition.any.some((c) => evaluateCondition(c, context));
  if (condition.not) return !evaluateCondition(condition.not, context);
  const { field, op, value } = condition;
  const fn = OPERATORS[op];
  if (!fn) throw new Error(`Unsupported mode condition operator: ${op}`);
  if (!(field in context)) {
    // A missing context field is treated as unsatisfiable rather than
    // accidentally truthy.
    return false;
  }
  return fn(context[field], value);
}

export class ModeManager {
  constructor() {
    this.modes = modeConfig.modes.slice().sort((a, b) => a.priority - b.priority);
    this.byId = new Map(this.modes.map((m) => [m.id, m]));
    this.validate();
    this.reset();
  }

  /** Startup validation of the state machine definition. */
  validate() {
    for (const mode of this.modes) {
      for (const next of mode.next_modes || []) {
        if (!this.byId.has(next)) {
          throw new Error(`Mode ${mode.id} declares unknown successor ${next}`);
        }
      }
      // Force a dry-run of the predicate so unsupported operators are caught now.
      try {
        evaluateCondition(mode.entry, {});
      } catch (err) {
        throw new Error(`Mode ${mode.id} has an invalid entry condition: ${err.message}`);
      }
    }
    if (!this.byId.has(modeConfig.initial_mode)) {
      throw new Error(`initial_mode ${modeConfig.initial_mode} is not defined`);
    }
  }

  reset() {
    this.currentMode = modeConfig.initial_mode;
    this.enteredAt = 0;
    this.manualFallback = false;
    this.transitions = [];
    this.lastContext = null;
  }

  /** Current mode definition. */
  get definition() {
    return this.byId.get(this.currentMode);
  }

  /**
   * Evaluate the state machine.
   *
   * @param {object} context flat context object (see modes.yaml context_fields)
   * @param {number} time simulation time
   * @returns {{ mode: string, changed: boolean, transition: object|null }}
   */
  evaluate(context, time) {
    const cfg = getConfig().mode_manager;
    this.lastContext = context;

    const current = this.byId.get(this.currentMode);
    const latching = (cfg.latching_modes || []).includes(this.currentMode);

    // A latching mode is only left when its own entry condition stops holding.
    if (latching && evaluateCondition(current.entry, context)) {
      return { mode: this.currentMode, changed: false, transition: null };
    }

    let candidate = null;
    for (const mode of this.modes) {
      let satisfied;
      try {
        satisfied = evaluateCondition(mode.entry, context);
      } catch (err) {
        log.error('mode condition evaluation failed', { mode: mode.id, message: err.message });
        continue;
      }
      if (!satisfied) continue;
      if (mode.id === this.currentMode) {
        // The current mode still holds; nothing more privileged matched first.
        return { mode: this.currentMode, changed: false, transition: null };
      }
      const allowed = (current.next_modes || []).includes(mode.id);
      if (!allowed) {
        // A higher-priority mode matched but is not a declared successor. The
        // state machine is explicit about this rather than jumping anyway.
        log.debug('mode transition blocked by state machine', { from: this.currentMode, to: mode.id });
        continue;
      }
      candidate = mode;
      break;
    }

    if (!candidate) return { mode: this.currentMode, changed: false, transition: null };

    const dwell = time - this.enteredAt;
    if (dwell < (cfg.min_dwell_s ?? 0)) {
      return { mode: this.currentMode, changed: false, transition: null, suppressed_candidate: candidate.id };
    }

    const transition = {
      from_mode: this.currentMode,
      to_mode: candidate.id,
      time_s: time,
      dwell_s: Number(dwell.toFixed(2)),
      reason: this.describeTransition(candidate, context),
      context: sanitizeContext(context)
    };
    this.currentMode = candidate.id;
    this.enteredAt = time;
    this.transitions.push(transition);
    if (this.transitions.length > 1000) this.transitions.shift();
    return { mode: this.currentMode, changed: true, transition };
  }

  /** Explain in one sentence why the mode changed. */
  describeTransition(mode, context) {
    const bits = [];
    if (context.spoofing_suspected) bits.push('GNSS spoofing indications are present');
    if (context.jamming_suspected) bits.push('GNSS interference indications are present');
    if (context.gnss_recovery_active) bits.push('GNSS is under recovery validation');
    if (!context.gnss_used_in_fusion && context.gnss_present) bits.push('GNSS is excluded from the solution');
    if (context.radar_valid && mode.id === 'RADAR_AIDED_NAVIGATION') bits.push('radar map matching is providing the absolute fix');
    if (context.bathy_ambiguous) bits.push('bathymetric matching is ambiguous');
    if (context.independent_absolute_sources <= 0) bits.push('no independent absolute position source is valid');
    if (Number.isFinite(context.horizontal_protection_level_m)) {
      bits.push(`the protection level is ${context.horizontal_protection_level_m.toFixed(2)} m`);
    }
    const detail = bits.length ? ` because ${bits.join(', ')}` : '';
    return `Entered ${mode.label}${detail}.`;
  }

  /** Operator action: latch into manual fallback. */
  setManualFallback(enabled) {
    this.manualFallback = Boolean(enabled);
    return this.manualFallback;
  }

  /** Full mode catalogue for the UI. */
  catalogue() {
    return this.modes.map((m) => ({
      id: m.id,
      label: m.label,
      priority: m.priority,
      description: m.description,
      active_sensors: m.active_sensors,
      rejected_sensors: m.rejected_sensors,
      expected_accuracy: m.expected_accuracy,
      uncertainty_behaviour: m.uncertainty_behaviour,
      operator_alarm: m.operator_alarm,
      operator_guidance: m.operator_guidance,
      exit: m.exit,
      next_modes: m.next_modes
    }));
  }

  /** Description of the currently active mode, for the status banner. */
  describeCurrent(time) {
    const def = this.definition;
    return {
      mode: this.currentMode,
      label: def.label,
      description: def.description,
      entered_at_s: this.enteredAt,
      duration_s: Number((time - this.enteredAt).toFixed(2)),
      active_sensors: def.active_sensors,
      rejected_sensors: def.rejected_sensors,
      expected_accuracy: def.expected_accuracy,
      uncertainty_behaviour: def.uncertainty_behaviour,
      operator_alarm: def.operator_alarm,
      operator_guidance: def.operator_guidance,
      exit_conditions: def.exit,
      next_modes: def.next_modes
    };
  }
}

/** Trim the context to primitives suitable for the audit trail. */
function sanitizeContext(context) {
  const out = {};
  for (const [k, v] of Object.entries(context)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20);
  }
  return out;
}

export default ModeManager;
