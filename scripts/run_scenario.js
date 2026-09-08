#!/usr/bin/env node
/**
 * Run one scenario headless and print its performance report.
 *
 * Useful for regression checking a configuration change without starting the
 * server: it produces exactly the numbers the dashboard would show.
 *
 * Usage:
 *   node scripts/run_scenario.js SCN_03_GRADUAL_DRAG
 *   node scripts/run_scenario.js SCN_15 --duration 300 --json
 *   node scripts/run_scenario.js --all                    # every scenario, one line each
 */

// `--json` writes a machine-readable report to stdout, so the engine's own
// informational log lines have to get out of the way or the output cannot be
// piped into jq. The logger fixes its threshold when it is first imported, which
// is why the level is set here and the modules are imported dynamically below.
if (process.argv.includes('--json') && !process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

const { runScenarioHeadless } = await import('../backend/src/simulation/engine.js');
const { getScenarioDefinition, scenarioCatalog } = await import('../backend/src/config/index.js');
const { mean, median, percentile, rms, max: maxOf } = await import('../backend/src/utils/stats.js');

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { json: args.includes('--json'), all: args.includes('--all'), quiet: args.includes('--quiet') };
  const durationIndex = args.indexOf('--duration');
  flags.duration = durationIndex !== -1 ? Number(args[durationIndex + 1]) : null;
  flags.scenarios = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--duration');
  return flags;
}

function resolve(input) {
  const exact = getScenarioDefinition(input);
  if (exact) return exact;
  const partial = scenarioCatalog.filter((s) => s.id.toUpperCase().includes(input.toUpperCase()));
  if (partial.length === 1) return partial[0];
  throw new Error(`Unknown or ambiguous scenario "${input}".`);
}

/** Summarise a headless run without touching the database. */
function summarise(scenario, outputs) {
  const errors = outputs.map((o) => o.actual_error_vs_truth_m).filter((v) => v !== null);
  const hpl = outputs.map((o) => o.integrity.horizontal_protection_level_m).filter((v) => v !== null);
  const gnssErrors = outputs.map((o) => o.gnss.error_vs_truth_m).filter((v) => v !== null);

  const comparable = outputs.filter(
    (o) => o.actual_error_vs_truth_m !== null && o.integrity.horizontal_protection_level_m !== null
  );
  const exceeded = comparable.filter(
    (o) => o.actual_error_vs_truth_m > o.integrity.horizontal_protection_level_m
  );
  const misleading = exceeded.filter((o) => o.integrity.requirement_status === 'REQUIREMENT_MET');

  const share = (predicate) => (100 * outputs.filter(predicate).length) / outputs.length;
  const modes = {};
  for (const o of outputs) modes[o.navigation_mode] = (modes[o.navigation_mode] ?? 0) + 1;

  const limit = outputs[0]?.integrity.requirement_limit_m ?? 2;

  return {
    scenario_id: scenario.id,
    scenario_name: scenario.name,
    duration_s: scenario.duration_s,
    epochs: outputs.length,
    seed: scenario.seed,
    actual_error: {
      mean_m: round(mean(errors)),
      median_m: round(median(errors)),
      rms_m: round(rms(errors)),
      p95_m: round(percentile(errors, 95)),
      p99_m: round(percentile(errors, 99)),
      max_m: round(maxOf(errors))
    },
    protection_level: { mean_m: round(mean(hpl)), max_m: round(maxOf(hpl)) },
    raw_gnss_error: { mean_m: round(mean(gnssErrors)), max_m: round(maxOf(gnssErrors)) },
    requirement_limit_m: limit,
    time_below_limit_pct: round(share((o) => (o.actual_error_vs_truth_m ?? 0) <= limit), 1),
    requirement_met_pct: round(share((o) => o.integrity.requirement_status === 'REQUIREMENT_MET'), 1),
    requirement_at_risk_pct: round(share((o) => o.integrity.requirement_status === 'REQUIREMENT_AT_RISK'), 1),
    requirement_not_met_pct: round(share((o) => o.integrity.requirement_status === 'REQUIREMENT_NOT_MET'), 1),
    integrity_assured_pct: round(share((o) => o.integrity.integrity_status === 'ASSURED'), 1),
    protection_level_exceeded_pct: round((100 * exceeded.length) / Math.max(1, comparable.length), 2),
    misleading_information_pct: round((100 * misleading.length) / Math.max(1, comparable.length), 2),
    spoofing_detected_at_s: firstWhen(outputs, (o) => o.gnss.spoofing_suspected),
    jamming_detected_at_s: firstWhen(outputs, (o) => o.gnss.jamming_suspected),
    gnss_excluded_at_s: firstWhen(outputs, (o) => o.excluded_sensors.includes('GNSS_01')),
    integrity_lost_at_s: firstWhen(outputs, (o) => o.integrity.integrity_status === 'NOT_ASSURED'),
    mode_share: Object.fromEntries(
      Object.entries(modes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, round((100 * v) / outputs.length, 1)])
    )
  };
}

const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const firstWhen = (outputs, predicate) => {
  const found = outputs.find(predicate);
  return found ? round(found.time_s, 1) : null;
};

function printReport(summary) {
  const s = summary;
  process.stdout.write(`\n${s.scenario_name}  (${s.scenario_id}, seed ${s.seed})\n`);
  process.stdout.write(`${'='.repeat(70)}\n`);
  const row = (label, value) => process.stdout.write(`  ${label.padEnd(42)}${value}\n`);

  row('Epochs analysed', `${s.epochs} over ${s.duration_s} s`);
  process.stdout.write('\n  ACTUAL error (against simulated ground truth)\n');
  row('mean / median / RMS', `${s.actual_error.mean_m} / ${s.actual_error.median_m} / ${s.actual_error.rms_m} m`);
  row('95th / 99th percentile', `${s.actual_error.p95_m} / ${s.actual_error.p99_m} m`);
  row('maximum', `${s.actual_error.max_m} m`);

  process.stdout.write('\n  PROTECTION LEVEL (the published bound)\n');
  row('mean / maximum', `${s.protection_level.mean_m} / ${s.protection_level.max_m} m`);
  row('epochs where the bound was exceeded', `${s.protection_level_exceeded_pct} %`);
  row('MISLEADING INFORMATION', `${s.misleading_information_pct} %`);

  process.stdout.write('\n  RAW GNSS (for comparison)\n');
  row('mean / maximum error', `${s.raw_gnss_error.mean_m} / ${s.raw_gnss_error.max_m} m`);

  process.stdout.write(`\n  REQUIREMENT (<${s.requirement_limit_m} m)\n`);
  row('time actually within the limit', `${s.time_below_limit_pct} %`);
  row('reported met / at risk / not met', `${s.requirement_met_pct} / ${s.requirement_at_risk_pct} / ${s.requirement_not_met_pct} %`);
  row('integrity assured', `${s.integrity_assured_pct} %`);

  process.stdout.write('\n  DETECTION\n');
  row('spoofing detected at', s.spoofing_detected_at_s === null ? 'not detected' : `${s.spoofing_detected_at_s} s`);
  row('jamming detected at', s.jamming_detected_at_s === null ? 'not detected' : `${s.jamming_detected_at_s} s`);
  row('GNSS excluded at', s.gnss_excluded_at_s === null ? 'not excluded' : `${s.gnss_excluded_at_s} s`);
  row('integrity lost at', s.integrity_lost_at_s === null ? 'never' : `${s.integrity_lost_at_s} s`);

  process.stdout.write('\n  MODE SHARE\n');
  for (const [mode, pct] of Object.entries(s.mode_share)) row(mode.replace(/_/g, ' '), `${pct} %`);
  process.stdout.write('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const scenarios = args.all
    ? scenarioCatalog
    : args.scenarios.length > 0
      ? args.scenarios.map(resolve)
      : [resolve('SCN_15_SAFEEN_DEMO')];

  const summaries = [];
  for (const definition of scenarios) {
    const scenario = args.duration ? { ...definition, duration_s: args.duration } : definition;
    const { outputs } = runScenarioHeadless(scenario);
    const summary = summarise(scenario, outputs);
    summaries.push(summary);
    if (!args.json && !args.all) printReport(summary);
    if (args.all && !args.json) {
      process.stdout.write(
        `${summary.scenario_id.padEnd(24)} mean ${String(summary.actual_error.mean_m).padStart(6)} m · ` +
          `p95 ${String(summary.actual_error.p95_m).padStart(6)} m · ` +
          `HPL ${String(summary.protection_level.mean_m).padStart(6)} m · ` +
          `met ${String(summary.requirement_met_pct).padStart(5)} % · ` +
          `misleading ${String(summary.misleading_information_pct).padStart(5)} %\n`
      );
    }
  }

  if (args.json) process.stdout.write(`${JSON.stringify(summaries.length === 1 ? summaries[0] : summaries, null, 2)}\n`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
