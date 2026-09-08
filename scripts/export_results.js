#!/usr/bin/env node
/**
 * Export recorded results to files.
 *
 * Usage:
 *   node scripts/export_results.js --list
 *   node scripts/export_results.js --run <run-id> --out ./data/exports
 *   node scripts/export_results.js --latest --format csv,geojson,html
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { exportService, toCsv } from '../backend/src/services/exportService.js';
import { performanceService } from '../backend/src/services/performanceService.js';
import { rows, closePool } from '../backend/src/db/pool.js';
import { env } from '../backend/src/config/index.js';
import { createLogger } from '../backend/src/utils/logger.js';

const log = createLogger('export-results');

const DATASETS = [
  'navigation',
  'ground_truth',
  'sensor_messages',
  'gnss_trust',
  'residuals',
  'alarms',
  'mode_transitions',
  'scenario_events',
  'sensor_health'
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
  };
  return {
    list: args.includes('--list'),
    latest: args.includes('--latest'),
    runId: get('--run'),
    out: get('--out', env.paths.exports),
    formats: (get('--format', 'csv,geojson,html') ?? '').split(',').map((f) => f.trim()).filter(Boolean),
    datasets: (get('--datasets') ?? DATASETS.join(',')).split(',').map((d) => d.trim()).filter(Boolean)
  };
}

async function listRuns() {
  const result = await performanceService.listRuns({ limit: 40 });
  if (result.items.length === 0) {
    process.stdout.write('No recorded runs. Run `npm run generate:data` first.\n');
    return;
  }
  process.stdout.write('\nRecorded runs:\n');
  for (const run of result.items) {
    process.stdout.write(
      `  ${run.run_id}  ${run.scenario_id.padEnd(24)} ${new Date(run.started_at).toISOString().slice(0, 19)}  ` +
        `${String(run.solution_count).padStart(6)} epochs  ${run.state}\n`
    );
  }
  process.stdout.write('\n');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    await listRuns();
    return;
  }

  let runId = args.runId;
  if (!runId || args.latest) {
    const latest = await rows(
      "SELECT id FROM scenario_runs WHERE state IN ('COMPLETED','STOPPED') ORDER BY started_at DESC LIMIT 1"
    );
    if (latest.length === 0) {
      throw new Error('No completed runs found. Run `npm run generate:data` first, or pass --run <id>.');
    }
    runId = latest[0].id;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const directory = path.resolve(args.out, `${runId.slice(0, 8)}_${stamp}`);
  await fs.mkdir(directory, { recursive: true });
  log.info('exporting', { run_id: runId, directory, formats: args.formats });

  const written = [];
  const write = async (name, content) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, content, 'utf8');
    const { size } = await fs.stat(file);
    written.push({ file: name, bytes: size });
  };

  for (const dataset of args.datasets) {
    const records = await exportService.fetchDataset(dataset, runId);
    if (records.length === 0) {
      log.warn('dataset is empty; skipped', { dataset });
      continue;
    }
    if (args.formats.includes('csv')) await write(`${dataset}.csv`, toCsv(records));
    if (args.formats.includes('json')) {
      await write(`${dataset}.json`, JSON.stringify({ dataset, run_id: runId, records }, null, 2));
    }
    if (args.formats.includes('geojson') && ['navigation', 'ground_truth'].includes(dataset)) {
      await write(`${dataset}.geojson`, JSON.stringify(await exportService.toGeoJson(dataset, runId), null, 2));
    }
    if (args.formats.includes('kml') && ['navigation', 'ground_truth'].includes(dataset)) {
      await write(`${dataset}.kml`, await exportService.toKml(dataset, runId));
    }
  }

  // The report is always produced: it is the document a reader actually reads.
  const report = await performanceService.buildReport(runId);
  await write('performance_report.json', JSON.stringify(report, null, 2));
  if (args.formats.includes('html')) {
    await write('performance_report.html', await exportService.toHtmlReport(runId));
  }

  process.stdout.write(`\nExported run ${runId} to:\n  ${directory}\n\n`);
  for (const item of written) {
    process.stdout.write(`  ${item.file.padEnd(34)} ${(item.bytes / 1024).toFixed(1)} KB\n`);
  }
  process.stdout.write(`\nCompliance result: ${report.summary.compliance_result}\n`);
  process.stdout.write(
    `Mean actual error ${report.summary.actual_error.mean_m} m · ` +
      `requirement met ${report.summary.requirement_met_pct} % · ` +
      `misleading information ${report.summary.misleading_information_pct} %\n\n`
  );
  if (args.formats.includes('html')) {
    process.stdout.write('Open performance_report.html in a browser and print to PDF for a shareable report.\n\n');
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    process.stderr.write(`\n${err.message}\n\n`);
    await closePool().catch(() => {});
    process.exit(1);
  });
