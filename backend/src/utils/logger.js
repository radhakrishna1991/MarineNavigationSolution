/**
 * Structured JSON logger.
 *
 * Deliberately dependency free: the platform must be auditable, so every log
 * line is a single JSON object with a stable shape that downstream log
 * shippers can parse without configuration.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

/** Fields that must never be written to logs. */
const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'access_token',
  'accessToken',
  'authorization',
  'jwt_secret',
  'pgpassword',
  'secret'
]);

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, component, message, context) {
  if (LEVELS[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    component,
    message
  };
  if (context && typeof context === 'object') {
    if (context instanceof Error) {
      record.error = { name: context.name, message: context.message, stack: context.stack };
    } else {
      Object.assign(record, redact(context));
    }
  } else if (context !== undefined) {
    record.detail = context;
  }
  const line = JSON.stringify(record);
  if (LEVELS[level] >= LEVELS.error) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Create a logger bound to a component name.
 * @param {string} component
 */
export function createLogger(component) {
  return {
    trace: (msg, ctx) => emit('trace', component, msg, ctx),
    debug: (msg, ctx) => emit('debug', component, msg, ctx),
    info: (msg, ctx) => emit('info', component, msg, ctx),
    warn: (msg, ctx) => emit('warn', component, msg, ctx),
    error: (msg, ctx) => emit('error', component, msg, ctx),
    fatal: (msg, ctx) => emit('fatal', component, msg, ctx),
    child: (sub) => createLogger(`${component}:${sub}`)
  };
}

export const logger = createLogger('amnp');
export default logger;
