/**
 * Runtime configuration service (Section 20).
 *
 * Thresholds are data, not code. An engineer can change the 2 m limit, the
 * GNSS trust bands, the fusion covariances or the mode dwell time at runtime;
 * the change is validated, persisted, applied to the live engines and written
 * to the audit log with both the old and the new value.
 *
 * Guard rails: only paths that exist in the shipped defaults may be set, the
 * new value must have the same type as the default, and a small allow-list of
 * safety-critical paths carries explicit bounds so the requirement limit cannot
 * be quietly moved to 200 m to make the dashboard turn green.
 */

import { getConfig, getDefaults, getPath, applyOverrides, setOverrides, getOverrides } from '../config/index.js';
import { query, rows } from '../db/pool.js';
import { writeAudit } from './authService.js';
import { resetEnvironment } from '../geospatial/environment.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('config');

/**
 * Bounds for safety-critical values. A threshold outside these ranges would
 * make the displayed status meaningless rather than merely different.
 */
const BOUNDS = {
  'requirements.horizontal_error_limit_m': { min: 0.1, max: 50 },
  'requirements.at_risk_lower_bound_m': { min: 0.05, max: 50 },
  'requirements.confidence_level': { min: 0.5, max: 0.9999 },
  'requirements.secondary_confidence_level': { min: 0.5, max: 0.99999 },
  'requirements.alarm_time_s': { min: 0.1, max: 60 },
  'requirements.min_independent_absolute_sources': { min: 0, max: 5 },
  'gnss_integrity.reject_score_below': { min: 0, max: 100 },
  'gnss_integrity.degraded_score_below': { min: 0, max: 100 },
  'gnss_integrity.recovery_validation_s': { min: 1, max: 600 },
  'dead_reckoning.maximum_unassisted_duration_s': { min: 5, max: 3600 },
  'integrity.assured_max_hpl_m': { min: 0.1, max: 100 },
  'integrity.degraded_max_hpl_m': { min: 0.1, max: 200 },
  'mode_manager.min_dwell_s': { min: 0, max: 120 },
  'alarms.debounce_s': { min: 0, max: 600 },
  'simulation.tick_hz': { min: 1, max: 100 },
  'simulation.publish_hz': { min: 1, max: 50 }
};

/** Paths that may never be changed through the API. */
const IMMUTABLE_PREFIXES = ['platform.', 'security.'];

/** Changing these requires the synthetic environment to be rebuilt. */
const ENVIRONMENT_PREFIXES = ['geospatial.', 'simulation.environment.'];

export class ConfigService {
  /** Load persisted overrides at boot and apply them. */
  async load() {
    const result = await rows('SELECT path, value FROM config_overrides');
    const overrides = {};
    for (const row of result) {
      const keys = row.path.split('.');
      let cursor = overrides;
      for (let i = 0; i < keys.length - 1; i += 1) {
        cursor[keys[i]] = cursor[keys[i]] ?? {};
        cursor = cursor[keys[i]];
      }
      cursor[keys[keys.length - 1]] = row.value;
    }
    setOverrides(overrides);
    if (result.length) log.info('runtime configuration overrides applied', { count: result.length });
    return getConfig();
  }

  /** The effective configuration, plus which values differ from the defaults. */
  describe() {
    const effective = getConfig();
    const defaults = getDefaults();
    const overrides = getOverrides();
    const changed = [];
    const walk = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
        else changed.push({ path, value: v, default_value: getPath(defaults, path) });
      }
    };
    walk(overrides);
    return {
      effective,
      defaults,
      overrides: changed,
      editable_bounds: BOUNDS,
      immutable_prefixes: IMMUTABLE_PREFIXES
    };
  }

  /**
   * Validate a single dotted-path update against the defaults and the bounds.
   * @throws error with `status` 400 on rejection
   */
  validate(path, value) {
    if (IMMUTABLE_PREFIXES.some((p) => path.startsWith(p))) {
      throw Object.assign(new Error(`${path} cannot be changed at runtime.`), { status: 400 });
    }
    const current = getPath(getDefaults(), path);
    if (current === undefined) {
      throw Object.assign(new Error(`Unknown configuration path: ${path}`), { status: 400 });
    }
    const expected = Array.isArray(current) ? 'array' : typeof current;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected !== actual) {
      throw Object.assign(
        new Error(`${path} expects a ${expected} but received a ${actual}.`),
        { status: 400 }
      );
    }
    if (expected === 'object') {
      throw Object.assign(
        new Error(`${path} is a group. Set its individual values instead.`),
        { status: 400 }
      );
    }
    const bound = BOUNDS[path];
    if (bound && typeof value === 'number') {
      if (value < bound.min || value > bound.max) {
        throw Object.assign(
          new Error(`${path} must be between ${bound.min} and ${bound.max}.`),
          { status: 400 }
        );
      }
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw Object.assign(new Error(`${path} must be a finite number.`), { status: 400 });
    }
    return true;
  }

  /**
   * Apply and persist a set of dotted-path updates.
   * @param {Record<string, unknown>} updates
   * @param {object} actor
   * @param {string} [note]
   */
  async update(updates, actor, note = null) {
    const entries = Object.entries(updates ?? {});
    if (entries.length === 0) throw Object.assign(new Error('No changes supplied.'), { status: 400 });
    if (entries.length > 200) throw Object.assign(new Error('Too many changes in one request.'), { status: 400 });

    // Validate everything before applying anything: a partially applied
    // configuration change is worse than a rejected one.
    const changes = [];
    for (const [path, value] of entries) {
      this.validate(path, value);
      changes.push({ path, value, previous: getPath(getConfig(), path) });
    }

    // Cross-field consistency.
    const next = { ...Object.fromEntries(changes.map((c) => [c.path, c.value])) };
    const limit = next['requirements.horizontal_error_limit_m'] ?? getConfig().requirements.horizontal_error_limit_m;
    const atRisk = next['requirements.at_risk_lower_bound_m'] ?? getConfig().requirements.at_risk_lower_bound_m;
    if (atRisk >= limit) {
      throw Object.assign(
        new Error('The at-risk lower bound must be below the horizontal error limit.'),
        { status: 400 }
      );
    }

    for (const change of changes) {
      await query(
        `INSERT INTO config_overrides (path, value, updated_by, note)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (path) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
               updated_at = now(), note = EXCLUDED.note`,
        [change.path, JSON.stringify(change.value), actor?.id ?? null, note]
      );
    }

    applyOverrides(Object.fromEntries(changes.map((c) => [c.path, c.value])));
    if (changes.some((c) => ENVIRONMENT_PREFIXES.some((p) => c.path.startsWith(p)))) {
      resetEnvironment();
      log.warn('geospatial configuration changed - environment rebuilt on next use');
    }

    await writeAudit({
      actorId: actor?.id,
      actorName: actor?.username,
      actorRole: actor?.role,
      action: 'CONFIG_UPDATED',
      entityType: 'config',
      entityId: changes.map((c) => c.path).join(','),
      detail: { changes, note }
    });
    log.info('configuration updated', { paths: changes.map((c) => c.path) });
    return this.describe();
  }

  /** Remove overrides and return to the shipped defaults. */
  async reset(paths, actor) {
    if (Array.isArray(paths) && paths.length > 0) {
      await query('DELETE FROM config_overrides WHERE path = ANY($1)', [paths]);
    } else {
      await query('DELETE FROM config_overrides');
    }
    await this.load();
    resetEnvironment();
    await writeAudit({
      actorId: actor?.id,
      actorName: actor?.username,
      actorRole: actor?.role,
      action: 'CONFIG_RESET',
      entityType: 'config',
      entityId: Array.isArray(paths) && paths.length ? paths.join(',') : 'ALL',
      detail: { paths: paths ?? 'ALL' }
    });
    return this.describe();
  }

  /** Change history for the configuration screen. */
  async history(limit = 100) {
    return rows(
      `SELECT c.path, c.value, c.updated_at, c.note, u.username AS updated_by_username
       FROM config_overrides c LEFT JOIN users u ON u.id = c.updated_by
       ORDER BY c.updated_at DESC LIMIT $1`,
      [Math.min(500, Math.max(1, limit))]
    );
  }
}

export const configService = new ConfigService();
export default configService;
