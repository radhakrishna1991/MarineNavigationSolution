/** Health, system status, geospatial data and adapter catalogue. */

import { Router } from 'express';
import { z } from 'zod';
import { checkConnection, one, rows } from '../../db/pool.js';
import { getConfig, env, sensorCatalog, modeConfig } from '../../config/index.js';
import { ModeManager } from '../../navigation/modeManager.js';
import { buildEnvironment, sampleGridDepth, DEMONSTRATION_LABEL } from '../../geospatial/environment.js';
import { ADAPTERS } from '../../adapters/index.js';
import { scenarioService } from '../../services/scenarioService.js';
import { replayService } from '../../services/replayService.js';
import { recorder } from '../../services/recorder.js';
import { alarmService } from '../../services/alarmService.js';
import { liveHub } from '../../ws/hub.js';
import { asyncHandler, requireAuth, validate, q } from '../../middleware/index.js';

const router = Router();
const startedAt = Date.now();

/**
 * Liveness and readiness. Unauthenticated by design so an orchestrator can
 * probe it, and deliberately free of any internal detail.
 */
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    let database = { ok: false, latency_ms: null, error: null };
    try {
      database = { ...(await checkConnection()), error: null };
    } catch (err) {
      database = { ok: false, latency_ms: null, error: err.code ?? 'UNREACHABLE' };
    }
    const healthy = database.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      version: getConfig().platform.version,
      database,
      timestamp: new Date().toISOString()
    });
  })
);

/** Full system status for the dashboard header and the engineering panel. */
router.get(
  '/system/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    let database = { ok: false, latency_ms: null };
    try {
      database = await checkConnection();
    } catch {
      database = { ok: false, latency_ms: null };
    }
    const counts = database.ok
      ? await one(
          `SELECT (SELECT count(*)::int FROM scenario_runs) AS runs,
                  (SELECT count(*)::int FROM navigation_solutions) AS solutions,
                  (SELECT count(*)::int FROM sensor_messages) AS sensor_messages,
                  (SELECT count(*)::int FROM alarms) AS alarms,
                  (SELECT count(*)::int FROM audit_log) AS audit_entries,
                  (SELECT count(*)::int FROM replay_sessions) AS replay_sessions`
        )
      : null;

    const memory = process.memoryUsage();
    res.json({
      platform: getConfig().platform,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      node_version: process.version,
      environment: env.nodeEnv,
      database: { ...database, counts },
      scenario: scenarioService.status(),
      replay: replayService.status(),
      recorder: recorder.status(),
      alarms: await alarmService.summary(scenarioService.runId),
      websocket: liveHub.status(),
      ingestion: {
        udp_enabled: env.udp.enabled,
        udp_port: env.udp.enabled ? env.udp.port : null,
        udp_bind: env.udp.enabled ? env.udp.bind : null
      },
      process: {
        rss_mb: Math.round(memory.rss / 1048576),
        heap_used_mb: Math.round(memory.heapUsed / 1048576),
        heap_total_mb: Math.round(memory.heapTotal / 1048576)
      },
      trusted_output_read_only: getConfig().security.trusted_output_read_only,
      control_output_note:
        'This platform has no interface to autopilot, dynamic positioning, propulsion or steering gear, by design.'
    });
  })
);

/** The adapter catalogue, including which are placeholders and why. */
router.get('/system/adapters', requireAuth, (req, res) => {
  res.json({
    items: ADAPTERS,
    implemented: ADAPTERS.filter((a) => a.status === 'IMPLEMENTED').length,
    placeholders: ADAPTERS.filter((a) => a.status === 'PLACEHOLDER').length
  });
});

/**
 * The navigation mode catalogue with entry conditions, expected accuracy and
 * operator guidance for every mode (Section 5).
 */
const staticModeManager = new ModeManager();

router.get('/system/modes', requireAuth, (req, res) => {
  const manager = scenarioService.engine?.pipeline?.modeManager ?? staticModeManager;
  res.json({
    items: manager.catalogue(),
    current: scenarioService.engine ? manager.describeCurrent(scenarioService.engine.time) : null,
    initial_mode: staticModeManager.modes[0] ? modeConfig.initial_mode : null
  });
});

/** Sensor catalogue with live health merged in. */
router.get(
  '/sensors',
  requireAuth,
  asyncHandler(async (req, res) => {
    const configured = await rows('SELECT * FROM sensors ORDER BY sensor_id');
    const source = configured.length
      ? configured
      : sensorCatalog.map((s) => ({
          sensor_id: s.sensor_id,
          sensor_type: s.sensor_type,
          name: s.name,
          manufacturer_class: s.manufacturer_class,
          interface_description: s.interface,
          nominal_rate_hz: s.rate_hz,
          provides: s.provides ?? [],
          absolute_position_source: Boolean(s.absolute_position_source),
          optional: Boolean(s.optional),
          advisory_only: Boolean(s.advisory_only),
          enabled: s.enabled_by_default !== false,
          configuration: { simulation: s.simulation ?? {}, fusion: s.fusion ?? {} }
        }));

    const live = scenarioService.current()?.sensor_health ?? [];
    const byId = new Map(live.map((h) => [h.sensor_id, h]));
    const gnssTrust = scenarioService.current()?.gnss?.trust_score ?? null;

    res.json({
      items: source.map((s) => ({
        ...s,
        health: byId.get(s.sensor_id) ?? null,
        trust_score: s.sensor_id === 'GNSS_01' ? gnssTrust : null
      }))
    });
  })
);

router.get(
  '/sensors/:sensorId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sensor = await one('SELECT * FROM sensors WHERE sensor_id = $1', [req.params.sensorId]);
    if (!sensor) return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown sensor.' });
    const live = scenarioService.current()?.sensor_health?.find((h) => h.sensor_id === req.params.sensorId) ?? null;
    const recent = scenarioService.runId
      ? await rows(
          `SELECT sim_time_s, timestamp_utc, sequence_number, latitude, longitude, heading_deg, depth_m,
                  velocity_north_mps, velocity_east_mps, quality, valid, decision, decision_reason
           FROM sensor_messages WHERE run_id = $1 AND sensor_id = $2
           ORDER BY sim_time_s DESC LIMIT 100`,
          [scenarioService.runId, req.params.sensorId]
        )
      : [];
    const residuals = scenarioService.runId
      ? await rows(
          `SELECT sim_time_s, measurement_kind, residual, normalized_residual, gate_passed, decision, reason
           FROM sensor_residuals WHERE run_id = $1 AND sensor_id = $2
           ORDER BY sim_time_s DESC LIMIT 200`,
          [scenarioService.runId, req.params.sensorId]
        )
      : [];
    res.json({ sensor, health: live, recent_messages: recent, recent_residuals: residuals.reverse() });
  })
);

// --- Geospatial -------------------------------------------------------------

router.get(
  '/geospatial/layers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const stored = await rows('SELECT id, layer_type, name, description, is_demo_data FROM map_layers ORDER BY id');
    res.json({
      items: stored,
      label: DEMONSTRATION_LABEL,
      note: 'All geospatial data in this platform is synthetic and generated for demonstration.'
    });
  })
);

router.get(
  '/geospatial/layers/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const layer = await one('SELECT * FROM map_layers WHERE id = $1', [req.params.id.toUpperCase()]);
    if (!layer) return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown map layer.' });
    res.json(layer.geojson);
  })
);

/** Every layer in one call, which is what the map needs on load. */
router.get(
  '/geospatial/bundle',
  requireAuth,
  asyncHandler(async (req, res) => {
    const stored = await rows('SELECT id, layer_type, geojson FROM map_layers');
    const bundle = Object.fromEntries(stored.map((r) => [r.id, r.geojson]));
    const env2 = buildEnvironment();
    res.json({
      layers: bundle,
      origin: env2.origin,
      label: DEMONSTRATION_LABEL,
      bathymetry_meta: {
        id: env2.bathymetry.id,
        spacing_m: env2.bathymetry.spacing,
        width: env2.bathymetry.width,
        height: env2.bathymetry.height,
        min_depth_m: Number(env2.bathymetry.minDepth.toFixed(2)),
        max_depth_m: Number(env2.bathymetry.maxDepth.toFixed(2)),
        vertical_sigma_m: env2.bathymetry.verticalSigmaM,
        survey_date: env2.bathymetry.surveyDate,
        resolution_note: getConfig().geospatial.bathymetry.resolution_note
      },
      control_points: env2.controlPoints,
      radar_feature_count: env2.radarPoints.length,
      lidar_feature_count: env2.lidarPoints.length
    });
  })
);

const DepthQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180)
});

/** Point depth lookup, used by the map's cursor readout. */
router.get(
  '/geospatial/depth',
  requireAuth,
  validate(DepthQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { latitude, longitude } = q(req);
    const environment = buildEnvironment();
    const local = environment.frame.toLocal(latitude, longitude);
    const depth = sampleGridDepth(environment.bathymetry, local.east, local.north);
    res.json({
      latitude,
      longitude,
      east_m: Number(local.east.toFixed(2)),
      north_m: Number(local.north.toFixed(2)),
      depth_m: depth === null ? null : Number(depth.toFixed(3)),
      inside_grid: depth !== null,
      vertical_sigma_m: environment.bathymetry.verticalSigmaM,
      label: DEMONSTRATION_LABEL
    });
  })
);

/**
 * Bathymetric surface as a decimated grid, for the map's depth raster.
 * Decimated server-side because the full grid is 2.5 million cells.
 */
const GridQuerySchema = z.object({
  stride: z.coerce.number().int().min(1).max(64).default(12)
});

router.get(
  '/geospatial/bathymetry',
  requireAuth,
  validate(GridQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { stride } = q(req);
    const environment = buildEnvironment();
    const grid = environment.bathymetry;
    const cells = [];
    for (let j = 0; j < grid.height; j += stride) {
      for (let i = 0; i < grid.width; i += stride) {
        const e = grid.originEastM + i * grid.spacing;
        const n = grid.originNorthM + j * grid.spacing;
        const geo = environment.frame.toGeodetic(e, n);
        cells.push([
          Number(geo.longitude.toFixed(6)),
          Number(geo.latitude.toFixed(6)),
          Number(grid.depths[j * grid.width + i].toFixed(2))
        ]);
      }
    }
    res.json({
      format: '[longitude, latitude, depth_m]',
      stride,
      cell_size_m: grid.spacing * stride,
      min_depth_m: Number(grid.minDepth.toFixed(2)),
      max_depth_m: Number(grid.maxDepth.toFixed(2)),
      count: cells.length,
      cells,
      label: DEMONSTRATION_LABEL,
      resolution_note: getConfig().geospatial.bathymetry.resolution_note
    });
  })
);

export default router;
