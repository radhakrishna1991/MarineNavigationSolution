/**
 * Configuration loader.
 *
 * Layers, lowest precedence first:
 *   1. `default.yaml` shipped with the build
 *   2. runtime overrides persisted in the `config_overrides` table
 *   3. environment variables (secrets and deployment topology only)
 *
 * Secrets are never read from YAML - only from the environment (Section 22:
 * "no credentials in source code").
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import dotenv from 'dotenv';
import { createLogger } from '../utils/logger.js';

const log = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the repository root, then the backend folder (backend wins).
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, 'backend', '.env'), override: true });

function readYaml(file) {
  const full = path.join(__dirname, file);
  return YAML.parse(fs.readFileSync(full, 'utf8'));
}

/** Deep merge where plain objects are merged and everything else is replaced. */
export function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Read a dotted path out of a nested object. */
export function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Immutably set a dotted path in a nested object. */
export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const out = Array.isArray(obj) ? obj.slice() : { ...obj };
  let cursor = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cursor[key];
    cursor[key] = next && typeof next === 'object' ? (Array.isArray(next) ? next.slice() : { ...next }) : {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return out;
}

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Deployment / secret configuration sourced only from the environment. */
export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  logLevel: process.env.LOG_LEVEL || 'info',
  port: int(process.env.BACKEND_PORT, 4000),
  // `::` binds every interface on both address families, so `http://localhost`
  // works whether the name resolves to 127.0.0.1 or ::1. Binding 0.0.0.0 listens
  // on IPv4 only, and on Windows `localhost` resolves to ::1 first — the server
  // is then up and unreachable at the address the documentation gives, which is
  // a confusing way to start. Set BACKEND_HOST explicitly to narrow the bind.
  host: process.env.BACKEND_HOST || '::',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || 'marinenavigation',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
    max: int(process.env.PG_POOL_MAX, 20),
    idleTimeoutMillis: int(process.env.PG_IDLE_TIMEOUT_MS, 30000)
  },
  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    issuer: process.env.JWT_ISSUER || 'ispatialtec-amnp'
  },
  seed: {
    adminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
    demoPassword: process.env.SEED_DEMO_PASSWORD || 'Demo@12345'
  },
  allowAnonymousViewer: bool(process.env.ALLOW_ANONYMOUS_VIEWER, false),
  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: int(process.env.RATE_LIMIT_MAX, 600),
    ingestMax: int(process.env.INGEST_RATE_LIMIT_MAX, 6000)
  },
  maxRequestBodyBytes: int(process.env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024),
  udp: {
    enabled: bool(process.env.UDP_INGEST_ENABLED, true),
    port: int(process.env.UDP_INGEST_PORT, 5005),
    bind: process.env.UDP_INGEST_BIND || '127.0.0.1'
  },
  recording: {
    enabled: bool(process.env.RECORD_SENSOR_MESSAGES, true),
    decimation: Math.max(1, int(process.env.RECORD_SENSOR_DECIMATION, 1)),
    flushMs: int(process.env.RECORDER_FLUSH_MS, 1000),
    maxBuffer: int(process.env.RECORDER_MAX_BUFFER, 5000)
  },
  paths: {
    repoRoot,
    data: path.join(repoRoot, 'data'),
    exports: path.join(repoRoot, 'data', 'exports')
  }
});

/** Static YAML documents. */
const defaults = readYaml('default.yaml');
const modes = readYaml('modes.yaml');
const sensorsDoc = readYaml('sensors.yaml');
const scenariosDoc = readYaml('scenarios.yaml');
const fleetDoc = readYaml('fleet.yaml');

let runtimeOverrides = {};
let effective = defaults;

const listeners = new Set();

function recompute() {
  effective = deepMerge(defaults, runtimeOverrides);
  for (const fn of listeners) {
    try {
      fn(effective);
    } catch (err) {
      log.error('config listener failed', err);
    }
  }
}

/** Current effective configuration (defaults + persisted overrides). */
export function getConfig() {
  return effective;
}

/** The pristine defaults, used by the UI to show "changed from default". */
export function getDefaults() {
  return defaults;
}

/** Current override layer only. */
export function getOverrides() {
  return runtimeOverrides;
}

/**
 * Replace the override layer wholesale (used at boot after reading the DB).
 */
export function setOverrides(overrides) {
  runtimeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  recompute();
  return effective;
}

/**
 * Apply a set of dotted-path updates to the override layer.
 * @param {Record<string, unknown>} updates
 */
export function applyOverrides(updates) {
  let next = runtimeOverrides;
  for (const [dotted, value] of Object.entries(updates)) {
    next = setPath(next, dotted, value);
  }
  runtimeOverrides = next;
  recompute();
  return effective;
}

/** Subscribe to configuration changes; returns an unsubscribe function. */
export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const modeConfig = modes;
export const sensorCatalog = sensorsDoc.sensors;
export const scenarioCatalog = scenariosDoc.scenarios;
export const fleetConfig = fleetDoc.fleet;

/** Look up a sensor definition by id. */
export function getSensorDefinition(sensorId) {
  return sensorCatalog.find((s) => s.sensor_id === sensorId) || null;
}

/** Look up a scenario definition by id. */
export function getScenarioDefinition(scenarioId) {
  return scenarioCatalog.find((s) => s.id === scenarioId) || null;
}

/** Validate that mandatory secrets are present before the server starts. */
export function assertSecrets() {
  const problems = [];
  if (!env.jwt.secret || env.jwt.secret.length < 32) {
    problems.push('JWT_SECRET must be set to at least 32 characters');
  }
  if (env.isProduction && env.jwt.secret.startsWith('CHANGE_ME')) {
    problems.push('JWT_SECRET still holds the placeholder value');
  }
  if (!env.db.password && env.isProduction) {
    problems.push('PGPASSWORD must be set');
  }
  if (problems.length) {
    throw new Error(`Configuration error:\n  - ${problems.join('\n  - ')}`);
  }
}

recompute();

export default { env, getConfig, getDefaults, applyOverrides, onConfigChange };
