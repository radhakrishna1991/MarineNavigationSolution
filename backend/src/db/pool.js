/**
 * PostgreSQL connection pool.
 *
 * Credentials come exclusively from the environment (Section 22). All queries
 * go through `query`/`withTransaction` so that slow statements are logged and
 * parameters are never interpolated into SQL text.
 */

import pg from 'pg';
import { env } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

// Return DECIMAL/NUMERIC as JS numbers rather than strings; every numeric
// column in this schema is a metric well within double precision.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  ssl: env.db.ssl,
  max: env.db.max,
  idleTimeoutMillis: env.db.idleTimeoutMillis,
  connectionTimeoutMillis: 10000,
  application_name: 'amnp-backend'
});

pool.on('error', (err) => {
  log.error('idle client error', err);
});

const SLOW_QUERY_MS = 500;

/**
 * Run a parameterised query.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_QUERY_MS) {
      log.warn('slow query', { elapsed_ms: elapsed, sql: text.slice(0, 200) });
    }
    return result;
  } catch (err) {
    log.error('query failed', { sql: text.slice(0, 300), message: err.message, code: err.code });
    throw err;
  }
}

/** Convenience: return rows only. */
export async function rows(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/** Convenience: return the first row or null. */
export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] ?? null;
}

/**
 * Run a function inside a transaction, rolling back on any throw.
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error('rollback failed', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Check connectivity; used by /api/health. */
export async function checkConnection() {
  const started = Date.now();
  const result = await pool.query('SELECT 1 AS ok');
  return { ok: result.rows[0]?.ok === 1, latency_ms: Date.now() - started };
}

/** Graceful shutdown. */
export async function closePool() {
  await pool.end();
  log.info('connection pool closed');
}

export default pool;
