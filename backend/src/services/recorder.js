/**
 * Buffered recorder for the audit trail (Section 21).
 *
 * The simulation produces thousands of rows per second at full rate (INS alone
 * is 50 Hz). Writing each row individually would make the database the
 * bottleneck and would couple navigation timing to disk latency, so rows are
 * batched in memory and flushed on a timer or when a buffer fills.
 *
 * Recording is best-effort by design: a database problem degrades the audit
 * trail, it must never stall or corrupt the navigation solution. Every dropped
 * batch is counted and surfaced through /api/system/status so the loss is
 * visible rather than silent.
 */

import { query } from '../db/pool.js';
import { env, getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('recorder');

/** Build a multi-row INSERT with numbered placeholders. */
function buildInsert(table, columns, rows) {
  const values = [];
  const tuples = rows.map((row, r) => {
    const placeholders = columns.map((_, c) => `$${r * columns.length + c + 1}`);
    for (const col of columns) values.push(row[col] ?? null);
    return `(${placeholders.join(',')})`;
  });
  return {
    text: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
    values
  };
}

export class Recorder {
  constructor() {
    this.buffers = new Map();
    this.timer = null;
    this.runId = null;
    // Flushes are serialised through this chain. Awaiting the promise returned
    // by flush() therefore also waits for every flush queued before it, which
    // is what lets stop() guarantee that the run is durable before a caller
    // reads it back. Without that guarantee a report generated immediately
    // after a run can be computed from a partially written table.
    this.flushChain = Promise.resolve();
    this.stats = {
      rows_written: 0,
      rows_dropped: 0,
      batches_written: 0,
      batches_failed: 0,
      last_error: null,
      last_flush_at: null
    };
    this.sensorDecimationCounters = new Map();
  }

  /** Begin recording for a scenario run. */
  start(runId) {
    this.runId = runId;
    this.buffers.clear();
    this.sensorDecimationCounters.clear();
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.flush().catch((err) => log.error('scheduled flush failed', err));
      }, env.recording.flushMs);
      this.timer.unref?.();
    }
  }

  /**
   * Stop recording and flush whatever remains.
   *
   * When this resolves the run is durable: a caller may read the recorded rows
   * back — to generate a performance report, for instance — and see all of
   * them.
   */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.runId = null;
  }

  buffer(table) {
    let list = this.buffers.get(table);
    if (!list) {
      list = [];
      this.buffers.set(table, list);
    }
    return list;
  }

  push(table, columns, row) {
    if (!this.runId) return;
    const list = this.buffer(table);
    list.push({ columns, row });
    if (list.length >= env.recording.maxBuffer) {
      this.flush().catch((err) => log.error('overflow flush failed', err));
    }
  }

  /** Record a normalized sensor message, honouring the decimation setting. */
  recordSensorMessage(message, { simTimeS, decision, reason }) {
    const cfg = getConfig().recording;
    if (!cfg.record_sensor_messages || !env.recording.enabled) return;
    const decim = Math.max(1, cfg.sensor_message_decimation, env.recording.decimation);
    const n = (this.sensorDecimationCounters.get(message.sensor_id) ?? 0) + 1;
    this.sensorDecimationCounters.set(message.sensor_id, n);
    if (n % decim !== 0) return;

    this.push(
      'sensor_messages',
      [
        'run_id',
        'sensor_id',
        'sensor_type',
        'sim_time_s',
        'timestamp_utc',
        'received_at',
        'sequence_number',
        'latitude',
        'longitude',
        'altitude_m',
        'velocity_north_mps',
        'velocity_east_mps',
        'velocity_down_mps',
        'heading_deg',
        'depth_m',
        'quality',
        'raw',
        'valid',
        'decision',
        'decision_reason'
      ],
      {
        run_id: this.runId,
        sensor_id: message.sensor_id,
        sensor_type: message.sensor_type,
        sim_time_s: simTimeS,
        timestamp_utc: message.timestamp_utc,
        received_at: new Date().toISOString(),
        sequence_number: message.sequence_number,
        latitude: message.position?.latitude ?? null,
        longitude: message.position?.longitude ?? null,
        altitude_m: message.position?.altitude_m ?? null,
        velocity_north_mps: message.velocity?.north_mps ?? null,
        velocity_east_mps: message.velocity?.east_mps ?? null,
        velocity_down_mps: message.velocity?.down_mps ?? null,
        heading_deg: message.heading_deg ?? null,
        depth_m: message.depth_m ?? null,
        quality: JSON.stringify(message.quality ?? {}),
        // Point clouds and multibeam profiles are large and are not part of the
        // decision record; a summary is kept instead of the full payload.
        raw: JSON.stringify(summariseRaw(message.raw)),
        valid: message.valid !== false,
        decision: decision ?? null,
        decision_reason: reason ?? null
      }
    );
  }

  /** Record the ground-truth reference track. */
  recordGroundTruth(truth) {
    this.push(
      'ground_truth',
      [
        'run_id',
        'sim_time_s',
        'timestamp_utc',
        'latitude',
        'longitude',
        'speed_mps',
        'course_deg',
        'heading_deg',
        'turn_rate_dps',
        'depth_m',
        'zone'
      ],
      {
        run_id: this.runId,
        sim_time_s: truth.time_s,
        timestamp_utc: new Date().toISOString(),
        latitude: truth.latitude,
        longitude: truth.longitude,
        speed_mps: truth.speed_mps,
        course_deg: truth.course_deg,
        heading_deg: truth.heading_deg,
        turn_rate_dps: truth.turn_rate_dps,
        depth_m: truth.seabed_depth_m,
        zone: truth.zone
      }
    );
  }

  /** Record a published navigation solution. */
  recordNavigationSolution(output) {
    const integrity = output.integrity ?? {};
    this.push(
      'navigation_solutions',
      [
        'run_id',
        'sim_time_s',
        'timestamp_utc',
        'latitude',
        'longitude',
        'velocity_north_mps',
        'velocity_east_mps',
        'speed_mps',
        'course_deg',
        'heading_deg',
        'gyro_bias_deg',
        'speed_scale_factor',
        'sigma_east_m',
        'sigma_north_m',
        'ellipse_major_m',
        'ellipse_minor_m',
        'ellipse_orientation_deg',
        'estimated_horizontal_error_m',
        'horizontal_protection_level_m',
        'vertical_protection_level_m',
        'radius_95_m',
        'radius_99_m',
        'integrity_status',
        'requirement_status',
        'navigation_mode',
        'solution_available',
        'contributing_sensors',
        'excluded_sensors',
        'independent_absolute_sources',
        'sensor_diversity_score',
        'dead_reckoning_duration_s',
        'absolute_fix_age_s',
        'gnss_trust_score',
        'truth_error_m',
        'gnss_truth_error_m',
        'detail'
      ],
      {
        run_id: this.runId,
        sim_time_s: output.time_s,
        timestamp_utc: output.timestamp_utc,
        latitude: output.trusted_position?.latitude ?? null,
        longitude: output.trusted_position?.longitude ?? null,
        velocity_north_mps: output.velocity?.north_mps ?? null,
        velocity_east_mps: output.velocity?.east_mps ?? null,
        speed_mps: output.velocity?.speed_mps ?? null,
        course_deg: output.course_deg,
        heading_deg: output.heading_deg,
        gyro_bias_deg: output.gyro_bias_deg,
        speed_scale_factor: output.speed_scale_factor,
        sigma_east_m: integrity.sigma_east_m ?? null,
        sigma_north_m: integrity.sigma_north_m ?? null,
        ellipse_major_m: integrity.confidence_ellipse?.semi_major_m ?? null,
        ellipse_minor_m: integrity.confidence_ellipse?.semi_minor_m ?? null,
        ellipse_orientation_deg: integrity.confidence_ellipse?.orientation_deg ?? null,
        estimated_horizontal_error_m: integrity.estimated_horizontal_error_m ?? null,
        horizontal_protection_level_m: integrity.horizontal_protection_level_m ?? null,
        vertical_protection_level_m: integrity.vertical_protection_level_m ?? null,
        radius_95_m: integrity.radius_95_m ?? null,
        radius_99_m: integrity.radius_99_m ?? null,
        integrity_status: integrity.integrity_status ?? 'UNKNOWN',
        requirement_status: integrity.requirement_status ?? 'INSUFFICIENT_INFORMATION',
        navigation_mode: output.navigation_mode,
        solution_available: output.solution_available !== false,
        contributing_sensors: output.contributing_sensors ?? [],
        excluded_sensors: output.excluded_sensors ?? [],
        independent_absolute_sources: integrity.independent_absolute_sources ?? 0,
        sensor_diversity_score: integrity.sensor_diversity_score ?? null,
        dead_reckoning_duration_s: integrity.dead_reckoning_duration_s ?? null,
        absolute_fix_age_s: integrity.time_since_last_absolute_fix_s ?? null,
        gnss_trust_score: output.gnss?.trust_score ?? null,
        truth_error_m: output.actual_error_vs_truth_m ?? null,
        gnss_truth_error_m: output.gnss?.error_vs_truth_m ?? null,
        detail: JSON.stringify({
          integrity_reasons: integrity.integrity_reasons ?? [],
          requirement_reasons: integrity.requirement_reasons ?? [],
          protection_level_inflation: integrity.protection_level_inflation ?? null,
          bias_margin_m: integrity.bias_margin_m ?? null,
          correlated_sigma_m: integrity.correlated_sigma_m ?? null,
          measurement_principles: integrity.measurement_principles ?? [],
          localization: {
            radar_valid: output.localization?.radar?.valid ?? false,
            radar_confidence: output.localization?.radar?.confidence ?? null,
            lidar_valid: output.localization?.lidar?.valid ?? false,
            bathy_valid: output.localization?.bathymetric?.valid ?? false,
            bathy_ambiguity: output.localization?.bathymetric?.ambiguity_score ?? null,
            local_valid: output.localization?.local_ranging?.valid ?? false
          },
          solution_confidence: output.solution_confidence ?? null,
          heading_error_deg: output.heading_error_deg ?? null,
          speed_error_mps: output.speed_error_mps ?? null
        })
      }
    );
  }

  /** Record the GNSS trust assessment. */
  recordGnssTrust(output) {
    const g = output.gnss;
    if (!g) return;
    const d = g.diagnostics ?? {};
    this.push(
      'gnss_trust_records',
      [
        'run_id',
        'sim_time_s',
        'timestamp_utc',
        'trust_score',
        'status',
        'recommended_action',
        'detected_conditions',
        'satellites',
        'hdop',
        'pdop',
        'cn0_mean_dbhz',
        'fix_type',
        'reported_accuracy_m',
        'diff_from_fused_m',
        'diff_from_radar_m',
        'diff_from_lidar_m',
        'diff_from_bathy_m',
        'diff_from_dr_m',
        'time_offset_s',
        'drag_rate_m_per_s',
        'detail'
      ],
      {
        run_id: this.runId,
        sim_time_s: output.time_s,
        timestamp_utc: output.timestamp_utc,
        trust_score: g.trust_score,
        status: g.status,
        recommended_action: g.recommended_action,
        detected_conditions: g.detected_conditions ?? [],
        satellites: g.quality?.satellites ?? null,
        hdop: g.quality?.hdop ?? null,
        pdop: g.quality?.pdop ?? null,
        cn0_mean_dbhz: g.quality?.cn0_mean_dbhz ?? null,
        fix_type: g.quality?.fix_type ?? null,
        reported_accuracy_m: g.quality?.reported_accuracy_m ?? null,
        diff_from_fused_m: d.diff_from_fused_m ?? null,
        diff_from_radar_m: d.diff_from_radar_m ?? null,
        diff_from_lidar_m: d.diff_from_lidar_m ?? null,
        diff_from_bathy_m: d.diff_from_bathy_m ?? null,
        diff_from_dr_m: d.diff_from_dr_m ?? null,
        time_offset_s: d.time_offset_s ?? null,
        drag_rate_m_per_s: d.drag_rate_m_per_s ?? null,
        detail: JSON.stringify({
          explanation: g.explanation,
          spoofing_suspected: g.spoofing_suspected,
          jamming_suspected: g.jamming_suspected,
          recovery: g.recovery,
          pending_conditions: g.pending_conditions ?? [],
          error_vs_truth_m: g.error_vs_truth_m ?? null,
          diagnostics: d
        })
      }
    );
  }

  /** Record filter residuals, honouring the decimation setting. */
  recordResiduals(output) {
    const cfg = getConfig().recording;
    if (!cfg.record_residuals) return;
    this.residualCounter = (this.residualCounter ?? 0) + 1;
    if (this.residualCounter % Math.max(1, cfg.residual_decimation) !== 0) return;
    for (const r of output.fusion_debug?.residuals ?? []) {
      this.push(
        'sensor_residuals',
        [
          'run_id',
          'sim_time_s',
          'timestamp_utc',
          'sensor_id',
          'sensor_type',
          'measurement_kind',
          'residual',
          'normalized_residual',
          'innovation_covariance',
          'chi_square',
          'gate_passed',
          'decision',
          'reason'
        ],
        {
          run_id: this.runId,
          sim_time_s: output.time_s,
          timestamp_utc: output.timestamp_utc,
          sensor_id: r.sensor_id,
          sensor_type: r.sensor_type,
          measurement_kind: r.kind,
          residual: r.residual,
          normalized_residual: r.normalized_residual,
          innovation_covariance: r.measurement_sigma,
          chi_square: r.nis,
          gate_passed: r.gate_passed !== false,
          decision: r.decision,
          reason: r.reason
        }
      );
    }
  }

  /** Record a per-sensor health snapshot. */
  recordSensorHealth(output) {
    for (const s of output.sensor_health ?? []) {
      this.push(
        'sensor_health_snapshots',
        [
          'run_id',
          'sim_time_s',
          'timestamp_utc',
          'sensor_id',
          'online',
          'trust_score',
          'update_rate_hz',
          'data_age_s',
          'accepted',
          'reason',
          'quality'
        ],
        {
          run_id: this.runId,
          sim_time_s: output.time_s,
          timestamp_utc: output.timestamp_utc,
          sensor_id: s.sensor_id,
          online: s.online,
          trust_score: s.sensor_id === 'GNSS_01' ? (output.gnss?.trust_score ?? null) : null,
          update_rate_hz: s.update_rate_hz,
          data_age_s: s.data_age_s,
          accepted: !s.excluded,
          reason: s.exclusion_reason ?? s.reason ?? null,
          quality: JSON.stringify({
            residual_rms: s.residual_rms,
            normalized_residual_rms: s.normalized_residual_rms,
            faults: s.faults,
            message_count: s.message_count,
            rejected_count: s.rejected_count,
            duplicate_count: s.duplicate_count,
            out_of_order_count: s.out_of_order_count
          })
        }
      );
    }
  }

  /** Record a mode transition. */
  recordModeTransition(transition) {
    this.push(
      'mode_transitions',
      ['run_id', 'sim_time_s', 'from_mode', 'to_mode', 'reason', 'trigger_context'],
      {
        run_id: this.runId,
        sim_time_s: transition.time_s,
        from_mode: transition.from_mode,
        to_mode: transition.to_mode,
        reason: transition.reason,
        trigger_context: JSON.stringify(transition.context ?? {})
      }
    );
  }

  /** Record a scenario event (fault injection, control action, stage marker). */
  recordScenarioEvent(event, userId = null) {
    this.push('scenario_events', ['run_id', 'sim_time_s', 'event_type', 'label', 'detail', 'created_by'], {
      run_id: this.runId,
      sim_time_s: event.sim_time_s,
      event_type: event.event_type,
      label: event.label,
      detail: JSON.stringify(event.detail ?? {}),
      created_by: userId
    });
  }

  /**
   * Flush every buffered table.
   *
   * Returns a promise that resolves once this flush *and every flush already
   * queued* has finished, so `await flush()` means "everything buffered up to
   * now is committed". The scheduled flush and an explicit one can otherwise
   * overlap, and the awaited one would return while the other was still
   * inserting.
   */
  flush() {
    this.flushChain = this.flushChain.then(
      () => this.flushOnce(),
      () => this.flushOnce()
    );
    return this.flushChain;
  }

  /** One flush pass. Never called concurrently with itself — see flush(). */
  async flushOnce() {
    if (this.buffers.size === 0) return;
    const snapshot = [...this.buffers.entries()];
    this.buffers.clear();

    for (const [table, entries] of snapshot) {
      if (entries.length === 0) continue;
      const columns = entries[0].columns;
      // Postgres allows at most 65535 bind parameters per statement.
      const chunkSize = Math.max(1, Math.floor(60000 / columns.length));
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        const { text, values } = buildInsert(
          table,
          columns,
          chunk.map((e) => e.row)
        );
        try {
          await query(text, values);
          this.stats.rows_written += chunk.length;
          this.stats.batches_written += 1;
        } catch (err) {
          // Recording must never take the navigation output down with it.
          this.stats.rows_dropped += chunk.length;
          this.stats.batches_failed += 1;
          this.stats.last_error = { table, message: err.message, at: new Date().toISOString() };
          log.error('batch insert failed - rows dropped', { table, rows: chunk.length, message: err.message });
        }
      }
    }
    this.stats.last_flush_at = new Date().toISOString();
  }

  status() {
    const pending = [...this.buffers.values()].reduce((acc, list) => acc + list.length, 0);
    return { ...this.stats, pending_rows: pending, run_id: this.runId, enabled: env.recording.enabled };
  }
}

/**
 * Large raw payloads (point clouds, multibeam swaths) are summarised rather
 * than stored verbatim: they are hundreds of times larger than everything else
 * in the row and are not part of the decision record.
 */
function summariseRaw(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.length > 12) {
      out[k] = { summarised: true, length: v.length, sample: v.slice(0, 3) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const recorder = new Recorder();
export default recorder;
