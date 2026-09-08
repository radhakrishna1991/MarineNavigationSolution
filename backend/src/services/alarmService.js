/**
 * Alarm management (Section 15.5).
 *
 * Alarms are persisted, acknowledgeable, filterable and exportable. Two
 * behaviours matter operationally and are implemented deliberately:
 *
 *  - Debouncing. The engines evaluate at 5 Hz; a condition that persists would
 *    otherwise produce 300 identical alarms a minute and the panel would be
 *    useless. An identical code from the same source inside the debounce window
 *    updates the existing alarm's occurrence count rather than creating a new
 *    one.
 *  - Acknowledgement does not clear. An acknowledged alarm whose condition is
 *    still present stays active and stays visible. Only the condition clearing
 *    clears the alarm. This is the standard bridge-alarm convention and it is
 *    what stops a critical warning being dismissed while it is still true.
 */

import { EventEmitter } from 'node:events';
import { query, rows, one } from '../db/pool.js';
import { getConfig } from '../config/index.js';
import { AlarmSeverity, ALARM_SEVERITY_ORDER } from '../models/enums.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('alarms');

export class AlarmService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} active alarms keyed by `code:source` */
    this.active = new Map();
    this.runId = null;
    this.recent = [];
  }

  /** Begin a new run: clear in-memory state (history stays in the database). */
  startRun(runId) {
    this.runId = runId;
    this.active.clear();
    this.recent = [];
  }

  /**
   * Raise an alarm.
   * @param {object} request from the navigation pipeline
   * @returns {Promise<object|null>} the alarm row, or null if debounced
   */
  async raise(request) {
    const cfg = getConfig().alarms;
    const key = `${request.code}:${request.source}`;
    const now = Date.now();
    const existing = this.active.get(key);

    if (existing && now - existing.lastSeenMs < cfg.debounce_s * 1000) {
      existing.lastSeenMs = now;
      existing.occurrences += 1;
      existing.sim_time_s = request.sim_time_s ?? existing.sim_time_s;
      return null;
    }

    const severity = request.severity || cfg.severity_for?.[request.code] || AlarmSeverity.ADVISORY;
    let row = null;
    try {
      row = await one(
        `INSERT INTO alarms (run_id, code, severity, source, message, reason, recommended_action,
                             sim_time_s, latitude, longitude, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          this.runId,
          request.code,
          severity,
          request.source,
          request.message,
          request.reason ?? null,
          request.recommended_action ?? null,
          request.sim_time_s ?? null,
          request.latitude ?? null,
          request.longitude ?? null,
          JSON.stringify(request.detail ?? {})
        ]
      );
    } catch (err) {
      log.error('failed to persist alarm', { code: request.code, message: err.message });
      // Persisting failed, but the operator must still see the alarm.
      row = {
        id: `transient-${now}-${Math.random().toString(36).slice(2, 8)}`,
        run_id: this.runId,
        code: request.code,
        severity,
        source: request.source,
        message: request.message,
        reason: request.reason ?? null,
        recommended_action: request.recommended_action ?? null,
        sim_time_s: request.sim_time_s ?? null,
        raised_at: new Date().toISOString(),
        active: true,
        detail: request.detail ?? {},
        persisted: false
      };
    }

    const entry = { ...row, lastSeenMs: now, occurrences: 1 };
    this.active.set(key, entry);
    this.recent.unshift(entry);
    if (this.recent.length > 500) this.recent.pop();

    // Bound the in-memory active set.
    if (this.active.size > cfg.max_active) {
      const oldest = [...this.active.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)[0];
      if (oldest) this.active.delete(oldest[0]);
    }

    this.emit('alarm', entry);
    return entry;
  }

  /** Raise a batch of alarms from the pipeline. */
  async raiseAll(requests) {
    const raised = [];
    for (const request of requests) {
      const alarm = await this.raise(request);
      if (alarm) raised.push(alarm);
    }
    return raised;
  }

  /**
   * Clear alarms whose condition has not recurred within the auto-clear window.
   * Called from the runtime loop.
   */
  async autoClear() {
    const cfg = getConfig().alarms;
    const now = Date.now();
    const stale = [...this.active.entries()].filter(
      ([, a]) => now - a.lastSeenMs > cfg.auto_clear_s * 1000
    );
    for (const [key, alarm] of stale) {
      this.active.delete(key);
      if (alarm.persisted === false) continue;
      try {
        await query('UPDATE alarms SET active = FALSE, cleared_at = now() WHERE id = $1', [alarm.id]);
        this.emit('alarm_cleared', alarm);
      } catch (err) {
        log.error('failed to clear alarm', { id: alarm.id, message: err.message });
      }
    }
  }

  /** Acknowledge an alarm. Does NOT clear it. */
  async acknowledge(alarmId, userId) {
    const row = await one(
      `UPDATE alarms SET acknowledged_at = now(), acknowledged_by = $2
       WHERE id = $1 RETURNING *`,
      [alarmId, userId]
    );
    if (!row) return null;
    for (const alarm of this.active.values()) {
      if (alarm.id === alarmId) {
        alarm.acknowledged_at = row.acknowledged_at;
        alarm.acknowledged_by = userId;
      }
    }
    this.emit('alarm_acknowledged', row);
    return row;
  }

  /** Acknowledge every currently active alarm. */
  async acknowledgeAll(userId) {
    const result = await query(
      `UPDATE alarms SET acknowledged_at = now(), acknowledged_by = $1
       WHERE active = TRUE AND acknowledged_at IS NULL
       RETURNING id`,
      [userId]
    );
    for (const alarm of this.active.values()) {
      if (!alarm.acknowledged_at) {
        alarm.acknowledged_at = new Date().toISOString();
        alarm.acknowledged_by = userId;
      }
    }
    return result.rowCount;
  }

  /** In-memory snapshot of active alarms for the live stream. */
  snapshot() {
    return [...this.active.values()]
      .map((a) => ({
        id: a.id,
        code: a.code,
        severity: a.severity,
        source: a.source,
        message: a.message,
        reason: a.reason,
        recommended_action: a.recommended_action,
        sim_time_s: a.sim_time_s,
        raised_at: a.raised_at,
        acknowledged_at: a.acknowledged_at ?? null,
        occurrences: a.occurrences,
        detail: a.detail
      }))
      .sort(
        (a, b) =>
          ALARM_SEVERITY_ORDER.indexOf(b.severity) - ALARM_SEVERITY_ORDER.indexOf(a.severity) ||
          new Date(b.raised_at) - new Date(a.raised_at)
      );
  }

  /** Highest active severity, for the status banner. */
  highestSeverity() {
    let best = null;
    for (const a of this.active.values()) {
      if (!best || ALARM_SEVERITY_ORDER.indexOf(a.severity) > ALARM_SEVERITY_ORDER.indexOf(best)) {
        best = a.severity;
      }
    }
    return best;
  }

  /**
   * Query the alarm history with filters, search and pagination.
   */
  async list({
    runId = null,
    severity = null,
    code = null,
    source = null,
    active = null,
    acknowledged = null,
    search = null,
    from = null,
    to = null,
    limit = 100,
    offset = 0
  } = {}) {
    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (runId) add('a.run_id = ?', runId);
    if (severity) {
      const list = Array.isArray(severity) ? severity : [severity];
      add('a.severity = ANY(?)', list);
    }
    if (code) add('a.code = ?', code);
    if (source) add('a.source = ?', source);
    if (active !== null && active !== undefined) add('a.active = ?', active);
    if (acknowledged === true) where.push('a.acknowledged_at IS NOT NULL');
    if (acknowledged === false) where.push('a.acknowledged_at IS NULL');
    if (from) add('a.raised_at >= ?', from);
    if (to) add('a.raised_at <= ?', to);
    if (search) {
      // One bind parameter matched against three columns.
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(a.message ILIKE ${p} OR a.reason ILIKE ${p} OR a.code ILIKE ${p} OR a.source ILIKE ${p})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(1000, Math.max(1, limit)));
    params.push(Math.max(0, offset));

    const items = await rows(
      `SELECT a.*, u.username AS acknowledged_by_username
       FROM alarms a
       LEFT JOIN users u ON u.id = a.acknowledged_by
       ${whereSql}
       ORDER BY a.raised_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countRow = await one(
      `SELECT count(*)::int AS total FROM alarms a ${whereSql}`,
      params.slice(0, params.length - 2)
    );
    return { items, total: countRow?.total ?? items.length, limit, offset };
  }

  /** Counts by severity, for the dashboard summary tiles. */
  async summary(runId = null) {
    const result = await rows(
      `SELECT severity, count(*)::int AS count,
              count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged
       FROM alarms
       WHERE ($1::uuid IS NULL OR run_id = $1)
       GROUP BY severity`,
      [runId]
    );
    const bySeverity = Object.fromEntries(
      ALARM_SEVERITY_ORDER.map((s) => [s, { count: 0, unacknowledged: 0 }])
    );
    for (const r of result) bySeverity[r.severity] = { count: r.count, unacknowledged: r.unacknowledged };
    return {
      by_severity: bySeverity,
      total: result.reduce((a, r) => a + r.count, 0),
      unacknowledged: result.reduce((a, r) => a + r.unacknowledged, 0),
      active_now: this.active.size,
      highest_active_severity: this.highestSeverity()
    };
  }
}

export const alarmService = new AlarmService();
export default alarmService;
