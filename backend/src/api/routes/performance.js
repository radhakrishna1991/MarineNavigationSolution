/** Performance analytics, reporting, exports, replay and configuration. */

import { Router } from 'express';
import { z } from 'zod';
import { performanceService } from '../../services/performanceService.js';
import { exportService, toCsv } from '../../services/exportService.js';
import { replayService } from '../../services/replayService.js';
import { configService } from '../../services/configService.js';
import { scenarioService } from '../../services/scenarioService.js';
import { Role } from '../../models/enums.js';
import { asyncHandler, requireAuth, requireRole, validate, audit, q, uuidParams, ingestLimiter } from '../../middleware/index.js';

const router = Router();

// --- Runs and analytics -----------------------------------------------------

const RunsQuerySchema = z.object({
  scenarioId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

router.get(
  '/runs',
  requireAuth,
  validate(RunsQuerySchema, 'query'),
  asyncHandler(async (req, res) => res.json(await performanceService.listRuns(q(req))))
);

router.get(
  '/performance/summary',
  requireAuth,
  validate(z.object({ runId: z.string().uuid().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const runId = q(req).runId ?? scenarioService.runId ?? replayService.runId;
    if (!runId) {
      return res.json({
        available: false,
        overall: await performanceService.overallSummary(),
        message: 'No run is active. Supply ?runId= to report on a recorded run.'
      });
    }
    const report = await performanceService.buildReport(runId);
    res.json({ available: true, ...report, overall: await performanceService.overallSummary() });
  })
);

const TimeseriesQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  maxPoints: z.coerce.number().int().min(50).max(20000).default(1500),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional()
});

router.get(
  '/performance/timeseries',
  requireAuth,
  validate(TimeseriesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { runId, maxPoints, from, to } = q(req);
    const target = runId ?? scenarioService.runId ?? replayService.runId;
    if (!target) return res.json({ run_id: null, series: [], point_count: 0 });
    res.json(await performanceService.timeseries(target, { maxPoints, from, to }));
  })
);

router.get(
  '/performance/tracks',
  requireAuth,
  validate(
    z.object({ runId: z.string().uuid().optional(), maxPoints: z.coerce.number().min(2).max(20000).default(2000) }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { runId, maxPoints } = q(req);
    const target = runId ?? scenarioService.runId ?? replayService.runId;
    if (!target) return res.json({ run_id: null, fused: [], truth: [], gnss: [] });
    res.json(await performanceService.tracks(target, { maxPoints }));
  })
);

router.post(
  '/performance/report',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(z.object({ runId: z.string().uuid().optional() })),
  audit('REPORT_GENERATE', 'run'),
  asyncHandler(async (req, res) => {
    const target = req.body.runId ?? scenarioService.runId ?? replayService.runId;
    if (!target) return res.status(400).json({ error: 'NO_RUN', message: 'No run is active and no run id was supplied.' });
    res.json(await performanceService.generateAndStore(target, req.user.id));
  })
);

router.get(
  '/performance/reports',
  requireAuth,
  asyncHandler(async (req, res) => res.json({ items: await performanceService.listReports(req.query.runId ?? null) }))
);

// --- Exports ----------------------------------------------------------------

router.get('/export/datasets', requireAuth, (req, res) => {
  res.json({ items: exportService.datasets() });
});

const ExportQuerySchema = z.object({
  dataset: z.string().min(1).max(40),
  runId: z.string().uuid().optional(),
  format: z.enum(['csv', 'json', 'geojson', 'kml', 'html']).default('csv'),
  limit: z.coerce.number().int().min(1).max(500000).default(200000)
});

router.get(
  '/export',
  requireAuth,
  validate(ExportQuerySchema, 'query'),
  audit('DATA_EXPORT', 'run'),
  asyncHandler(async (req, res) => {
    const { dataset, format, limit } = q(req);
    const runId = q(req).runId ?? scenarioService.runId ?? replayService.runId;
    if (!runId && dataset !== 'audit') {
      return res.status(400).json({ error: 'NO_RUN', message: 'Supply ?runId= or start a scenario first.' });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `amnp_${dataset}_${(runId ?? 'system').slice(0, 8)}_${stamp}`;

    if (dataset === 'report') {
      if (format === 'html') {
        const html = await exportService.toHtmlReport(runId);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${filename}.html"`);
        return res.send(html);
      }
      const report = await performanceService.buildReport(runId);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.json(report);
    }

    switch (format) {
      case 'geojson': {
        const geo = await exportService.toGeoJson(dataset, runId);
        res.setHeader('Content-Type', 'application/geo+json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.geojson"`);
        return res.send(JSON.stringify(geo));
      }
      case 'kml': {
        const kml = await exportService.toKml(dataset, runId);
        res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
        return res.send(kml);
      }
      case 'json': {
        const records = await exportService.fetchDataset(dataset, runId, { limit });
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
        return res.json({ dataset, run_id: runId, count: records.length, records });
      }
      case 'csv':
      default: {
        const records = await exportService.fetchDataset(dataset, runId, { limit });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(toCsv(records));
      }
    }
  })
);

// --- Replay -----------------------------------------------------------------

router.get(
  '/replay/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await replayService.listSessions(), current: replayService.status() });
  })
);

const UploadSchema = z.object({
  name: z.string().min(1).max(120),
  format: z.enum(['csv', 'json']),
  content: z.string().min(1).max(40 * 1024 * 1024),
  defaultSensorId: z.string().max(64).optional(),
  defaultSensorType: z.string().max(32).optional()
});

router.post(
  '/data/upload',
  requireAuth,
  requireRole(Role.ENGINEER),
  ingestLimiter,
  validate(UploadSchema),
  audit('REPLAY_IMPORT', 'replay_session'),
  asyncHandler(async (req, res) => {
    const session = await replayService.importFile({ ...req.body, userId: req.user.id });
    res.status(201).json({ session });
  })
);

router.post(
  '/replay/from-run',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(z.object({ runId: z.string().uuid(), name: z.string().max(120).optional() })),
  audit('REPLAY_FROM_RUN', 'replay_session'),
  asyncHandler(async (req, res) => {
    const session = await replayService.importFromRun(req.body.runId, {
      name: req.body.name,
      userId: req.user.id
    });
    res.status(201).json({ session });
  })
);

router.post(
  '/replay/:sessionId/start',
  requireAuth,
  uuidParams('sessionId'),
  requireRole(Role.OPERATOR),
  validate(z.object({ speedMultiplier: z.coerce.number().min(0.1).max(50).default(1) })),
  audit('REPLAY_START', 'replay_session'),
  asyncHandler(async (req, res) => {
    await scenarioService.stop({ userId: req.user.id });
    const status = await replayService.start(req.params.sessionId, {
      userId: req.user.id,
      speedMultiplier: req.body.speedMultiplier
    });
    res.json(status);
  })
);

router.post(
  '/replay/pause',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('REPLAY_PAUSE', 'replay_session'),
  asyncHandler(async (req, res) => res.json(await replayService.pause()))
);

router.post(
  '/replay/resume',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('REPLAY_RESUME', 'replay_session'),
  asyncHandler(async (req, res) => res.json(await replayService.resume()))
);

router.post(
  '/replay/stop',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('REPLAY_STOP', 'replay_session'),
  asyncHandler(async (req, res) => res.json(await replayService.stop()))
);

router.delete(
  '/replay/:sessionId',
  requireAuth,
  uuidParams('sessionId'),
  requireRole(Role.ENGINEER),
  audit('REPLAY_DELETE', 'replay_session'),
  asyncHandler(async (req, res) => res.json(await replayService.deleteSession(req.params.sessionId)))
);

// --- Configuration ----------------------------------------------------------

router.get('/config', requireAuth, (req, res) => {
  res.json(configService.describe());
});

router.get(
  '/config/history',
  requireAuth,
  requireRole(Role.ENGINEER),
  asyncHandler(async (req, res) => res.json({ items: await configService.history() }))
);

const ConfigUpdateSchema = z.object({
  updates: z.record(z.union([z.number(), z.string(), z.boolean(), z.array(z.any())])),
  note: z.string().max(300).optional()
});

router.put(
  '/config',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(ConfigUpdateSchema),
  audit('CONFIG_UPDATE', 'config'),
  asyncHandler(async (req, res) => {
    res.json(await configService.update(req.body.updates, req.user, req.body.note));
  })
);

router.post(
  '/config/reset',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(z.object({ paths: z.array(z.string().max(120)).max(200).optional() })),
  audit('CONFIG_RESET', 'config'),
  asyncHandler(async (req, res) => {
    res.json(await configService.reset(req.body.paths, req.user));
  })
);

export default router;
