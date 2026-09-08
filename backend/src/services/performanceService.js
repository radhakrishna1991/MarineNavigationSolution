/**
 * Performance analytics and scenario reporting (Sections 15.7 and 26).
 *
 * The report keeps three quantities strictly separate, because conflating them
 * is the single most common way a navigation claim becomes dishonest:
 *
 *   actual error       measured against simulated ground truth. Only exists
 *                      because this is a simulation. In a real deployment it
 *                      requires an independent reference such as RTK.
 *   estimated error    the filter's own expectation, from its covariance.
 *   protection level   a *bound* the system undertakes to respect, with a
 *                      stated confidence.
 *
 * The most important derived number in the whole report is the misleading
 * information rate: the fraction of epochs where the actual error exceeded the
 * protection level while the system was claiming the requirement was met. A
 * system with small average error and a high MI rate is worse than useless,
 * because it is confidently wrong.
 */

import { rows, one } from '../db/pool.js';
import { getConfig } from '../config/index.js';
import { mean, median, rms, percentile, max as maxOf, stdDev, round } from '../utils/stats.js';
import { RequirementStatus, IntegrityStatus } from '../models/enums.js';

export class PerformanceService {
  /** List recorded runs. */
  async listRuns({ scenarioId = null, limit = 50, offset = 0 } = {}) {
    const items = await rows(
      `SELECT r.id AS run_id, r.scenario_id, s.name AS scenario_name, s.category, r.state,
              r.started_at, r.ended_at, r.duration_s, r.seed, r.speed_multiplier, r.ins_enabled,
              u.username AS started_by_username,
              (SELECT count(*)::int FROM navigation_solutions n WHERE n.run_id = r.id) AS solution_count,
              (SELECT count(*)::int FROM alarms a WHERE a.run_id = r.id) AS alarm_count,
              (SELECT count(*)::int FROM mode_transitions m WHERE m.run_id = r.id) AS mode_transition_count
       FROM scenario_runs r
       JOIN scenarios s ON s.id = r.scenario_id
       LEFT JOIN users u ON u.id = r.started_by
       WHERE ($1::text IS NULL OR r.scenario_id = $1)
       ORDER BY r.started_at DESC
       LIMIT $2 OFFSET $3`,
      [scenarioId, Math.min(200, limit), Math.max(0, offset)]
    );
    const total = await one(
      'SELECT count(*)::int AS total FROM scenario_runs WHERE ($1::text IS NULL OR scenario_id = $1)',
      [scenarioId]
    );
    return { items, total: total?.total ?? items.length, limit, offset };
  }

  /**
   * Down-sampled time series for the analytics charts.
   * @param {string} runId
   * @param {number} maxPoints
   */
  async timeseries(runId, { maxPoints = 1200, from = null, to = null } = {}) {
    const countRow = await one(
      `SELECT count(*)::int AS n FROM navigation_solutions
       WHERE run_id = $1 AND ($2::float8 IS NULL OR sim_time_s >= $2) AND ($3::float8 IS NULL OR sim_time_s <= $3)`,
      [runId, from, to]
    );
    const n = countRow?.n ?? 0;
    // Decimate in SQL rather than fetching everything and thinning in JS: a
    // ten-minute run at 5 Hz is 3000 rows, an hour-long replay is 18000.
    const stride = Math.max(1, Math.ceil(n / Math.max(50, maxPoints)));
    const items = await rows(
      `SELECT * FROM (
         SELECT n.*, row_number() OVER (ORDER BY sim_time_s) AS rn
         FROM navigation_solutions n
         WHERE run_id = $1 AND ($2::float8 IS NULL OR sim_time_s >= $2) AND ($3::float8 IS NULL OR sim_time_s <= $3)
       ) t
       WHERE (rn - 1) % $4 = 0
       ORDER BY sim_time_s`,
      [runId, from, to, stride]
    );
    return {
      run_id: runId,
      point_count: items.length,
      total_points: n,
      stride,
      series: items.map((r) => ({
        t: r.sim_time_s,
        actual_error_m: r.truth_error_m,
        gnss_error_m: r.gnss_truth_error_m,
        estimated_error_m: r.estimated_horizontal_error_m,
        hpl_m: r.horizontal_protection_level_m,
        radius_95_m: r.radius_95_m,
        radius_99_m: r.radius_99_m,
        gnss_trust: r.gnss_trust_score,
        mode: r.navigation_mode,
        integrity: r.integrity_status,
        requirement: r.requirement_status,
        absolute_sources: r.independent_absolute_sources,
        diversity: r.sensor_diversity_score,
        dr_duration_s: r.dead_reckoning_duration_s,
        speed_mps: r.speed_mps,
        heading_deg: r.heading_deg,
        latitude: r.latitude,
        longitude: r.longitude,
        contributing: r.contributing_sensors,
        excluded: r.excluded_sensors
      }))
    };
  }

  /** Track geometry for the map: fused, GNSS and ground truth. */
  async tracks(runId, { maxPoints = 2000 } = {}) {
    const countRow = await one('SELECT count(*)::int AS n FROM navigation_solutions WHERE run_id = $1', [runId]);
    const stride = Math.max(1, Math.ceil((countRow?.n ?? 0) / maxPoints));
    const fused = await rows(
      `SELECT * FROM (SELECT sim_time_s, latitude, longitude, navigation_mode, requirement_status,
                             row_number() OVER (ORDER BY sim_time_s) AS rn
                      FROM navigation_solutions WHERE run_id = $1) t
       WHERE (rn - 1) % $2 = 0 AND latitude IS NOT NULL ORDER BY sim_time_s`,
      [runId, stride]
    );
    const truth = await rows(
      `SELECT * FROM (SELECT sim_time_s, latitude, longitude, zone,
                             row_number() OVER (ORDER BY sim_time_s) AS rn
                      FROM ground_truth WHERE run_id = $1) t
       WHERE (rn - 1) % $2 = 0 ORDER BY sim_time_s`,
      [runId, stride]
    );
    const gnss = await rows(
      `SELECT * FROM (SELECT sim_time_s, latitude, longitude,
                             row_number() OVER (ORDER BY sim_time_s) AS rn
                      FROM sensor_messages WHERE run_id = $1 AND sensor_type = 'GNSS' AND latitude IS NOT NULL) t
       WHERE (rn - 1) % $2 = 0 ORDER BY sim_time_s`,
      [runId, Math.max(1, stride * 2)]
    );
    return { run_id: runId, fused, truth, gnss };
  }

  /**
   * Build the full scenario performance report (Section 26).
   */
  async buildReport(runId) {
    const run = await one(
      `SELECT r.*, s.name AS scenario_name, s.category, s.summary, s.expected_outcome
       FROM scenario_runs r JOIN scenarios s ON s.id = r.scenario_id WHERE r.id = $1`,
      [runId]
    );
    if (!run) throw Object.assign(new Error('Run not found.'), { status: 404 });

    const solutions = await rows(
      `SELECT sim_time_s, truth_error_m, gnss_truth_error_m, estimated_horizontal_error_m,
              horizontal_protection_level_m, integrity_status, requirement_status, navigation_mode,
              independent_absolute_sources, gnss_trust_score, solution_available, contributing_sensors,
              excluded_sensors, dead_reckoning_duration_s
       FROM navigation_solutions WHERE run_id = $1 ORDER BY sim_time_s`,
      [runId]
    );
    if (solutions.length === 0) {
      throw Object.assign(new Error('This run has no recorded navigation solutions.'), { status: 400 });
    }

    const limit = getConfig().requirements.horizontal_error_limit_m;
    const dt = solutions.length > 1 ? solutions[1].sim_time_s - solutions[0].sim_time_s : 0.2;
    const totalDuration = solutions[solutions.length - 1].sim_time_s - solutions[0].sim_time_s + dt;

    const actual = solutions.map((s) => s.truth_error_m).filter((v) => v !== null);
    const estimated = solutions.map((s) => s.estimated_horizontal_error_m).filter((v) => v !== null);
    const hpl = solutions.map((s) => s.horizontal_protection_level_m).filter((v) => v !== null);
    const gnssErr = solutions.map((s) => s.gnss_truth_error_m).filter((v) => v !== null);

    // --- Requirement compliance ------------------------------------------
    const fraction = (predicate) => solutions.filter(predicate).length / solutions.length;
    const belowLimit = fraction((s) => s.truth_error_m !== null && s.truth_error_m <= limit);
    const requirementMet = fraction((s) => s.requirement_status === RequirementStatus.REQUIREMENT_MET);
    const integrityAssured = fraction((s) => s.integrity_status === IntegrityStatus.ASSURED);
    const solutionAvailable = fraction((s) => s.solution_available);

    // --- Integrity failures ------------------------------------------------
    const overbound = solutions.filter(
      (s) =>
        s.truth_error_m !== null &&
        s.horizontal_protection_level_m !== null &&
        s.truth_error_m > s.horizontal_protection_level_m
    );
    const misleading = overbound.filter((s) => s.requirement_status === RequirementStatus.REQUIREMENT_MET);

    // --- Mode durations ----------------------------------------------------
    const modeDurations = {};
    for (const s of solutions) {
      modeDurations[s.navigation_mode] = (modeDurations[s.navigation_mode] ?? 0) + dt;
    }

    // --- Sensor availability ------------------------------------------------
    const sensorCounts = new Map();
    for (const s of solutions) {
      for (const id of s.contributing_sensors ?? []) {
        sensorCounts.set(id, (sensorCounts.get(id) ?? 0) + 1);
      }
    }
    const sensorAvailability = Object.fromEntries(
      [...sensorCounts.entries()].map(([id, n]) => [
        id,
        { epochs: n, availability_pct: round((100 * n) / solutions.length, 2) }
      ])
    );

    // --- GNSS outage / rejection --------------------------------------------
    const gnssExcluded = solutions.filter((s) => (s.excluded_sensors ?? []).includes('GNSS_01'));
    const gnssOutageDuration = gnssExcluded.length * dt;

    // --- Event timing -------------------------------------------------------
    const alarms = await rows(
      'SELECT code, severity, sim_time_s, message, reason, raised_at FROM alarms WHERE run_id = $1 ORDER BY sim_time_s',
      [runId]
    );
    const firstAlarm = (code) => alarms.find((a) => a.code === code)?.sim_time_s ?? null;
    const spoofDetect = firstAlarm('GNSS_SPOOFING_DETECTED');
    const jamDetect = firstAlarm('GNSS_JAMMING_DETECTED');
    const gnssRejectTime =
      gnssExcluded.length > 0 ? gnssExcluded[0].sim_time_s : null;
    const reintegrate = firstAlarm('GNSS_REINTEGRATED');

    // Fault-injection start times, so detection latency is measurable.
    const events = await rows(
      'SELECT event_type, label, sim_time_s, detail FROM scenario_events WHERE run_id = $1 ORDER BY sim_time_s',
      [runId]
    );
    const definition = run.config_snapshot ?? {};
    const scenarioDef = await one('SELECT definition FROM scenarios WHERE id = $1', [run.scenario_id]);
    const scriptedFaults = scenarioDef?.definition?.faults ?? [];
    const firstGnssFault = scriptedFaults
      .filter((f) => f.sensor_id === 'GNSS_01')
      .reduce((min, f) => (min === null || f.start_s < min ? f.start_s : min), null);

    const modeTransitions = await rows(
      'SELECT sim_time_s, from_mode, to_mode, reason FROM mode_transitions WHERE run_id = $1 ORDER BY sim_time_s',
      [runId]
    );

    // --- False alarms --------------------------------------------------------
    // A GNSS attack alarm raised while no GNSS fault was scripted is a false
    // alarm. This is reported plainly rather than hidden.
    const gnssFaultWindows = scriptedFaults
      .filter((f) => f.sensor_id === 'GNSS_01')
      .map((f) => [f.start_s, f.end_s ?? Number.POSITIVE_INFINITY]);
    const attackAlarms = alarms.filter((a) =>
      ['GNSS_SPOOFING_DETECTED', 'GNSS_JAMMING_DETECTED'].includes(a.code)
    );
    const falseAlarms = attackAlarms.filter(
      (a) => !gnssFaultWindows.some(([s, e]) => a.sim_time_s >= s - 2 && a.sim_time_s <= e + 30)
    );

    const summary = {
      scenario_id: run.scenario_id,
      scenario_name: run.scenario_name,
      run_id: runId,
      run_state: run.state,
      start_time: run.started_at,
      end_time: run.ended_at,
      total_duration_s: round(totalDuration, 2),
      epochs: solutions.length,
      epoch_interval_s: round(dt, 4),
      seed: run.seed,
      ins_enabled: run.ins_enabled,

      // ACTUAL error, measured against simulated ground truth.
      actual_error: {
        source: 'Measured against simulated ground truth. Not available outside simulation.',
        mean_m: round(mean(actual), 4),
        median_m: round(median(actual), 4),
        rms_m: round(rms(actual), 4),
        std_dev_m: round(stdDev(actual), 4),
        p95_m: round(percentile(actual, 95), 4),
        p99_m: round(percentile(actual, 99), 4),
        max_m: round(maxOf(actual), 4),
        samples: actual.length
      },
      // ESTIMATED error, from the filter covariance.
      estimated_error: {
        source: "The filter's own expectation from its covariance. An estimate, not a measurement.",
        mean_m: round(mean(estimated), 4),
        p95_m: round(percentile(estimated, 95), 4),
        max_m: round(maxOf(estimated), 4)
      },
      // PROTECTION LEVEL: the bound, with its confidence.
      protection_level: {
        source: `A bound the system undertakes to respect at ${(getConfig().requirements.confidence_level * 100).toFixed(0)}% confidence.`,
        mean_m: round(mean(hpl), 4),
        p95_m: round(percentile(hpl, 95), 4),
        max_m: round(maxOf(hpl), 4)
      },
      gnss_error: {
        source: 'Raw GNSS position against ground truth, including any injected spoofing.',
        mean_m: round(mean(gnssErr), 4),
        max_m: round(maxOf(gnssErr), 4),
        samples: gnssErr.length
      },

      // Compliance
      requirement_limit_m: limit,
      time_below_limit_pct: round(100 * belowLimit, 2),
      time_above_limit_pct: round(100 * (1 - belowLimit), 2),
      requirement_met_pct: round(100 * requirementMet, 2),
      requirement_at_risk_pct: round(
        100 * fraction((s) => s.requirement_status === RequirementStatus.REQUIREMENT_AT_RISK),
        2
      ),
      requirement_not_met_pct: round(
        100 * fraction((s) => s.requirement_status === RequirementStatus.REQUIREMENT_NOT_MET),
        2
      ),
      insufficient_information_pct: round(
        100 * fraction((s) => s.requirement_status === RequirementStatus.INSUFFICIENT_INFORMATION),
        2
      ),
      integrity_assured_pct: round(100 * integrityAssured, 2),
      solution_availability_pct: round(100 * solutionAvailable, 2),

      // Integrity performance - the number that matters most.
      protection_level_exceeded_count: overbound.length,
      protection_level_exceeded_pct: round((100 * overbound.length) / solutions.length, 3),
      misleading_information_count: misleading.length,
      misleading_information_pct: round((100 * misleading.length) / solutions.length, 3),
      misleading_information_note:
        'Epochs where the actual error exceeded the protection level while the system reported the requirement as met. This is the strictest measure of whether the platform can be believed.',

      // Timing
      gnss_outage_duration_s: round(gnssOutageDuration, 2),
      gnss_outage_pct: round((100 * gnssExcluded.length) / solutions.length, 2),
      first_gnss_fault_at_s: firstGnssFault,
      spoofing_detection_time_s: spoofDetect,
      spoofing_detection_latency_s:
        spoofDetect !== null && firstGnssFault !== null ? round(spoofDetect - firstGnssFault, 2) : null,
      jamming_detection_time_s: jamDetect,
      jamming_detection_latency_s:
        jamDetect !== null && firstGnssFault !== null ? round(jamDetect - firstGnssFault, 2) : null,
      gnss_rejection_time_s: gnssRejectTime,
      gnss_rejection_latency_s:
        gnssRejectTime !== null && firstGnssFault !== null ? round(gnssRejectTime - firstGnssFault, 2) : null,
      gnss_recovery_time_s: reintegrate,
      false_alarm_count: falseAlarms.length,
      false_alarms: falseAlarms.map((a) => ({ code: a.code, sim_time_s: a.sim_time_s, message: a.message })),

      // Counts
      alarm_count: alarms.length,
      alarm_counts_by_severity: alarms.reduce((acc, a) => {
        acc[a.severity] = (acc[a.severity] ?? 0) + 1;
        return acc;
      }, {}),
      mode_transition_count: modeTransitions.length,
      scenario_event_count: events.length,

      compliance_result:
        requirementMet >= 0.999
          ? 'REQUIREMENT MET THROUGHOUT'
          : misleading.length > 0
            ? 'REQUIREMENT NOT ASSURED - MISLEADING INFORMATION DETECTED'
            : requirementMet > 0
              ? 'REQUIREMENT MET FOR PART OF THE RUN - SEE BREAKDOWN'
              : 'REQUIREMENT NOT MET',
      disclaimer: getConfig().platform.disclaimer
    };

    return {
      summary,
      mode_durations: Object.fromEntries(
        Object.entries(modeDurations).map(([k, v]) => [
          k,
          { seconds: round(v, 2), pct: round((100 * v) / totalDuration, 2) }
        ])
      ),
      sensor_availability: sensorAvailability,
      mode_timeline: modeTransitions,
      alarms,
      events,
      config_snapshot: definition
    };
  }

  /** Build and persist a report. */
  async generateAndStore(runId, userId = null) {
    const report = await this.buildReport(runId);
    const stored = await one(
      `INSERT INTO performance_reports (run_id, scenario_id, generated_by, summary, mode_durations,
                                        sensor_availability, compliance_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, generated_at`,
      [
        runId,
        report.summary.scenario_id,
        userId,
        JSON.stringify(report.summary),
        JSON.stringify(report.mode_durations),
        JSON.stringify(report.sensor_availability),
        report.summary.compliance_result
      ]
    );
    return { ...report, report_id: stored.id, generated_at: stored.generated_at };
  }

  /** Previously generated reports. */
  async listReports(runId = null) {
    return rows(
      `SELECT p.id, p.run_id, p.scenario_id, p.generated_at, p.compliance_result,
              p.summary, u.username AS generated_by_username
       FROM performance_reports p LEFT JOIN users u ON u.id = p.generated_by
       WHERE ($1::uuid IS NULL OR p.run_id = $1)
       ORDER BY p.generated_at DESC LIMIT 100`,
      [runId]
    );
  }

  /**
   * Fleet-level summary across every recorded run, for the analytics landing
   * page. Deliberately reports the worst case as well as the average.
   */
  async overallSummary() {
    const result = await one(
      `SELECT count(DISTINCT run_id)::int                          AS runs,
              count(*)::int                                        AS epochs,
              avg(truth_error_m)                                   AS mean_error_m,
              max(truth_error_m)                                   AS max_error_m,
              avg(horizontal_protection_level_m)                   AS mean_hpl_m,
              max(horizontal_protection_level_m)                   AS max_hpl_m,
              count(*) FILTER (WHERE requirement_status = 'REQUIREMENT_MET')::int   AS met,
              count(*) FILTER (WHERE integrity_status = 'ASSURED')::int             AS assured,
              count(*) FILTER (WHERE truth_error_m > horizontal_protection_level_m)::int AS overbound
       FROM navigation_solutions`
    );
    const epochs = result?.epochs ?? 0;
    return {
      runs: result?.runs ?? 0,
      epochs,
      mean_error_m: round(result?.mean_error_m, 4),
      max_error_m: round(result?.max_error_m, 4),
      mean_hpl_m: round(result?.mean_hpl_m, 4),
      max_hpl_m: round(result?.max_hpl_m, 4),
      requirement_met_pct: epochs ? round((100 * result.met) / epochs, 2) : null,
      integrity_assured_pct: epochs ? round((100 * result.assured) / epochs, 2) : null,
      protection_level_exceeded_pct: epochs ? round((100 * result.overbound) / epochs, 3) : null
    };
  }
}

export const performanceService = new PerformanceService();
export default performanceService;
