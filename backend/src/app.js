/**
 * Express application assembly.
 *
 * Ordering matters: security headers, then body limits, then rate limiting,
 * then authentication, then routes, then the error handler. A request that
 * fails an earlier stage never reaches a later one.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { env, getConfig } from './config/index.js';
import {
  attachUser,
  ensureActiveUser,
  apiLimiter,
  securityHeaders,
  notFound,
  errorHandler
} from './middleware/index.js';
import authRoutes from './api/routes/auth.js';
import systemRoutes from './api/routes/system.js';
import navigationRoutes from './api/routes/navigation.js';
import scenarioRoutes from './api/routes/scenarios.js';
import performanceRoutes from './api/routes/performance.js';
import ingestRoutes from './api/routes/ingest.js';
import fleetRoutes from './api/routes/fleet.js';
import vesselRoutes from './api/routes/vessels.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('app');

export function createApp() {
  const app = express();

  // Behind a reverse proxy the client address comes from X-Forwarded-For.
  // Trust exactly one hop rather than blindly trusting the header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and the SPA is served separately; a restrictive
      // default CSP here would only mislead. The frontend's own CSP is set by
      // its web server (see frontend/nginx.conf).
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );
  app.use(securityHeaders);

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients send no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed.`));
      },
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600
    })
  );

  app.use(compression());
  app.use(express.json({ limit: env.maxRequestBodyBytes }));
  app.use(express.text({ limit: env.maxRequestBodyBytes, type: ['text/csv', 'text/plain'] }));

  // Request logging, excluding the health probe which would drown the log.
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const started = Date.now();
    res.on('finish', () => {
      const elapsed = Date.now() - started;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level]('request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        elapsed_ms: elapsed,
        user: req.user?.username ?? null
      });
    });
    return next();
  });

  app.use('/api', apiLimiter);
  app.use(attachUser);
  app.use(ensureActiveUser);

  // A machine-readable description of the platform, unauthenticated so an
  // integrator can discover it.
  app.get('/api', (req, res) => {
    const cfg = getConfig();
    res.json({
      name: cfg.platform.name,
      version: cfg.platform.version,
      classification: cfg.platform.classification,
      disclaimer: cfg.platform.disclaimer,
      documentation: '/docs/api.md',
      websocket: '/ws/live',
      endpoints: [
        'GET  /api/health',
        'GET  /api/system/status',
        'GET  /api/system/adapters',
        'GET  /api/system/modes',
        'GET  /api/navigation/current',
        'GET  /api/navigation/history',
        'GET  /api/navigation/gnss',
        'GET  /api/navigation/integrity',
        'GET  /api/navigation/localization',
        'GET  /api/navigation/bathymetric',
        'GET  /api/sensors',
        'GET  /api/sensors/{sensor_id}',
        'GET  /api/alarms',
        'POST /api/alarms/{alarm_id}/acknowledge',
        'GET  /api/scenarios',
        'POST /api/scenarios/{scenario_id}/start',
        'POST /api/scenarios/pause',
        'POST /api/scenarios/resume',
        'POST /api/scenarios/stop',
        'POST /api/scenarios/reset',
        'POST /api/scenarios/step',
        'POST /api/scenarios/speed',
        'POST /api/scenarios/jump',
        'POST /api/scenarios/inject-fault',
        'POST /api/scenarios/remove-fault',
        'GET  /api/performance/summary',
        'GET  /api/performance/timeseries',
        'GET  /api/performance/tracks',
        'POST /api/performance/report',
        'GET  /api/export',
        'GET  /api/config',
        'PUT  /api/config',
        'POST /api/data/upload',
        'POST /api/data/ingest',
        'GET  /api/replay/sessions',
        'POST /api/replay/{session_id}/start',
        'WS   /ws/live'
      ],
      control_outputs: 'None. This platform has no interface to autopilot, DP, propulsion or steering gear.'
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', systemRoutes);
  app.use('/api', navigationRoutes);
  app.use('/api', scenarioRoutes);
  app.use('/api', performanceRoutes);
  app.use('/api', ingestRoutes);
  app.use('/api', fleetRoutes);
  app.use('/api', vesselRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
