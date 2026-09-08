/**
 * Server entry point: wiring, startup and graceful shutdown.
 *
 * The wiring here is the only place the layers know about each other. Engines
 * emit events, services persist and broadcast, adapters feed the pipeline -
 * none of them import the others directly, which is what keeps the navigation
 * code testable without a database or a socket.
 */

import http from 'node:http';
import { createApp } from './app.js';
import { env, assertSecrets, getConfig } from './config/index.js';
import { migrate } from './db/migrate.js';
import { closePool, checkConnection } from './db/pool.js';
import { configService } from './services/configService.js';
import { scenarioService } from './services/scenarioService.js';
import { replayService } from './services/replayService.js';
import { alarmService } from './services/alarmService.js';
import { recorder } from './services/recorder.js';
import { liveHub } from './ws/hub.js';
import { setIngestHandler } from './api/routes/ingest.js';
import { UdpIngestAdapter } from './adapters/udpIngest.js';
import { validateSensorMessage } from './models/sensorMessage.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

let server;
let udpAdapter = null;

/**
 * Route an externally supplied sensor message into whichever pipeline is
 * currently running.
 *
 * External data is validated a second time here even though the adapter has
 * already validated it: the pipeline is the trust boundary, and it does not
 * assume its callers behaved.
 */
function ingestExternalMessage(message, meta = {}) {
  const result = validateSensorMessage(message);
  if (!result.ok) return { ok: false, errors: result.errors };

  const engine = scenarioService.engine;
  if (engine && ['RUNNING', 'PAUSED'].includes(scenarioService.state)) {
    engine.pipeline.ingest(result.message, engine.time);
    return { ok: true, target: 'scenario', ...meta };
  }
  if (replayService.pipeline && ['RUNNING', 'PAUSED'].includes(replayService.state)) {
    replayService.pipeline.ingest(result.message, replayService.time);
    return { ok: true, target: 'replay', ...meta };
  }
  return {
    ok: false,
    errors: ['No navigation pipeline is running. Start a scenario or a replay before ingesting data.']
  };
}

function wireEvents() {
  scenarioService.on('epoch', (payload) => liveHub.publishEpoch(payload));
  scenarioService.on('state', (status) => liveHub.publishScenarioState(status));
  scenarioService.on('mode_transition', (t) => liveHub.publishModeTransition(t));
  scenarioService.on('completed', (info) => {
    log.info('scenario completed', info);
    liveHub.publishScenarioState(scenarioService.status());
  });

  replayService.on('epoch', (payload) => liveHub.publishEpoch(payload));
  replayService.on('completed', (info) => {
    log.info('replay completed', info);
    liveHub.publishReplayState(replayService.status());
  });

  alarmService.on('alarm', (alarm) => liveHub.broadcast('alarms', { type: 'alarm', alarm }));
  alarmService.on('alarm_cleared', (alarm) =>
    liveHub.broadcast('alarms', { type: 'alarm_cleared', alarm: { id: alarm.id, code: alarm.code } })
  );
  alarmService.on('alarm_acknowledged', (alarm) =>
    liveHub.broadcast('alarms', { type: 'alarm_acknowledged', alarm })
  );

  setIngestHandler(ingestExternalMessage);
}

async function start() {
  assertSecrets();

  // The schema is applied at boot so a fresh container is usable immediately.
  // It is idempotent, so this is safe on every restart.
  try {
    await checkConnection();
    await migrate({ drop: false });
    await configService.load();
  } catch (err) {
    log.fatal('database initialisation failed', err);
    log.fatal('the platform cannot start without its database', {
      host: env.db.host,
      port: env.db.port,
      database: env.db.database,
      hint: 'Check PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, and that PostgreSQL is running.'
    });
    process.exit(1);
  }

  const app = createApp();
  server = http.createServer(app);
  liveHub.attach(server, { onIngest: ingestExternalMessage });
  wireEvents();

  if (env.udp.enabled) {
    try {
      udpAdapter = new UdpIngestAdapter({ onMessage: (message, meta) => ingestExternalMessage(message, meta) });
      await udpAdapter.start();
    } catch (err) {
      // A busy UDP port must not prevent the dashboard from starting.
      log.error('udp ingestion could not start; continuing without it', { message: err.message });
      udpAdapter = null;
    }
  }

  await new Promise((resolve) => server.listen(env.port, env.host, resolve));

  const cfg = getConfig();
  log.info('platform ready', {
    name: cfg.platform.name,
    version: cfg.platform.version,
    classification: cfg.platform.classification,
    http: `http://${env.host}:${env.port}`,
    websocket: `ws://${env.host}:${env.port}/ws/live`,
    database: `${env.db.host}:${env.db.port}/${env.db.database}`,
    udp_ingest: udpAdapter ? `${env.udp.bind}:${env.udp.port}` : 'disabled',
    environment: env.nodeEnv
  });
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const timeout = setTimeout(() => {
    log.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15000);
  timeout.unref();

  try {
    await scenarioService.shutdown();
    await replayService.stop();
    await recorder.stop();
    if (udpAdapter) await udpAdapter.stop();
    await liveHub.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
    clearTimeout(timeout);
    log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('error during shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason instanceof Error ? reason : { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.fatal('uncaught exception', err);
  shutdown('uncaughtException');
});

start().catch((err) => {
  log.fatal('startup failed', err);
  process.exit(1);
});

export { start, shutdown, ingestExternalMessage };
