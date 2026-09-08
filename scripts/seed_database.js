#!/usr/bin/env node
/**
 * One-shot database preparation: migrate, seed reference data, and optionally
 * generate demonstration history.
 *
 * Usage:
 *   node scripts/seed_database.js               # migrate + seed reference data
 *   node scripts/seed_database.js --with-data   # also generate historical runs
 *   node scripts/seed_database.js --fresh       # drop everything first
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../backend/src/db/migrate.js';
import { seed } from '../backend/src/db/seed.js';
import { checkConnection, closePool } from '../backend/src/db/pool.js';
import { env } from '../backend/src/config/index.js';
import { createLogger } from '../backend/src/utils/logger.js';

const log = createLogger('seed-database');
const here = path.dirname(fileURLToPath(import.meta.url));

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const withData = args.includes('--with-data');

  log.info('checking database connectivity', {
    host: env.db.host,
    port: env.db.port,
    database: env.db.database,
    user: env.db.user
  });
  await checkConnection();

  if (fresh) log.warn('--fresh: dropping the existing schema');
  await migrate({ drop: fresh });
  await seed({ migrateFirst: false });

  log.info('reference data seeded', {
    accounts: ['admin (administrator)', 'engineer', 'operator', 'viewer'],
    note: 'Passwords come from SEED_ADMIN_PASSWORD and SEED_DEMO_PASSWORD in the environment.'
  });

  await closePool();

  if (withData) {
    log.info('generating demonstration history (this drives the real navigation pipeline and takes a minute)');
    await run('generate_demo_data.js');
  }

  process.stdout.write('\nDatabase ready.\n');
  process.stdout.write('  npm run dev        start the backend and the dashboard\n');
  process.stdout.write('  npm run generate:data  produce historical runs for the analytics screens\n\n');
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.fatal('seeding failed', err);
    process.stderr.write(
      '\nCheck that PostgreSQL is running and that PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD are set.\n\n'
    );
    await closePool().catch(() => {});
    process.exit(1);
  });
