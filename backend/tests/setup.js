/**
 * Jest setup.
 *
 * The engine tests run entirely in memory: no database, no sockets, no timers.
 * That is deliberate — the navigation logic is the part that must be provable,
 * and a test that needs infrastructure to run is a test that stops being run.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PGDATABASE = process.env.PGDATABASE ?? 'marinenavigation';
process.env.UDP_INGEST_ENABLED = 'false';
process.env.RECORD_SENSOR_MESSAGES = 'false';

// `setupFiles` runs before the test framework is installed, so the timeout is
// set through the config rather than the jest global (which does not exist yet).
