/**
 * Schema migration runner.
 *
 * The schema is idempotent (every statement is CREATE ... IF NOT EXISTS or
 * CREATE OR REPLACE) so running this repeatedly is safe. `--drop` tears the
 * schema down first, which is what `npm run db:reset` uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, closePool } from './pool.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db:migrate');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DROP_ORDER = [
  'replay_messages',
  'replay_sessions',
  'performance_reports',
  'audit_log',
  'scenario_events',
  'alarms',
  'mode_transitions',
  'sensor_health_snapshots',
  'sensor_residuals',
  'gnss_trust_records',
  'navigation_solutions',
  'ground_truth',
  'sensor_messages',
  'scenario_runs',
  'control_points',
  'reference_point_clouds',
  'bathymetry_grids',
  'map_layers',
  'scenarios',
  'sensors',
  'config_overrides',
  'users',
  'app_meta'
];

export async function dropSchema() {
  log.warn('dropping existing schema');
  await query('DROP VIEW IF EXISTS v_run_summary CASCADE');
  await query('DROP VIEW IF EXISTS v_active_alarms CASCADE');
  for (const table of DROP_ORDER) {
    await query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await query('DROP FUNCTION IF EXISTS audit_log_immutable() CASCADE');
}

export async function migrate({ drop = false } = {}) {
  if (drop) await dropSchema();
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    // The schema file contains a PL/pgSQL function body with semicolons, so it
    // must be executed as a single multi-statement command rather than split.
    await client.query(sql);
    log.info('schema applied');
  } finally {
    client.release();
  }

  await query(
    `INSERT INTO app_meta(key, value, updated_at)
     VALUES ('schema_version', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ version: 1, applied_at: new Date().toISOString() })]
  );
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const drop = process.argv.includes('--drop');
  migrate({ drop })
    .then(async () => {
      log.info('migration complete', { drop });
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      log.fatal('migration failed', err);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
