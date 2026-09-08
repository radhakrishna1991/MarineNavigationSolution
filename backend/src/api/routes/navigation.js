/**
 * Trusted navigation output (Section 8).
 *
 * READ ONLY. There is no endpoint here that accepts a command, and there never
 * will be: the platform has no interface to autopilot, dynamic positioning,
 * propulsion or steering gear. Any write attempt is answered with an
 * explanation rather than a bare 405, because the refusal is part of the
 * product's safety argument.
 */

import { Router } from 'express';
import { z } from 'zod';
import { rows, one } from '../../db/pool.js';
import { scenarioService } from '../../services/scenarioService.js';
import { replayService } from '../../services/replayService.js';
import { getConfig } from '../../config/index.js';
import { asyncHandler, requireAuth, validate, q } from '../../middleware/index.js';

const router = Router();

/** Refuse any attempt to write to the navigation surface. */
function readOnlyGuard(req, res) {
  res.status(405).json({
    error: 'READ_ONLY_OUTPUT',
    message:
      'The trusted navigation output is read-only by design. This platform provides decision support and has ' +
      'no control interface to autopilot, dynamic positioning, propulsion or steering gear.',
    reference: 'Specification Section 8 and Section 23'
  });
}

router.post('/navigation/*', requireAuth, readOnlyGuard);
router.put('/navigation/*', requireAuth, readOnlyGuard);
router.patch('/navigation/*', requireAuth, readOnlyGuard);
router.delete('/navigation/*', requireAuth, readOnlyGuard);

/**
 * The current trusted navigation solution: everything the main screen needs in
 * one call, so a client that missed WebSocket frames can resynchronise.
 */
router.get(
  '/navigation/current',
  requireAuth,
  asyncHandler(async (req, res) => {
    const output = scenarioService.current() ?? replayService.lastOutput ?? null;
    if (!output) {
      return res.status(200).json({
        available: false,
        message: 'No scenario or replay is running. Start one to produce a navigation solution.',
        scenario: scenarioService.status(),
        replay: replayService.status(),
        requirement_limit_m: getConfig().requirements.horizontal_error_limit_m
      });
    }
    res.json({
      available: true,
      navigation: output,
      scenario: scenarioService.status(),
      replay: replayService.status(),
      disclaimer: getConfig().platform.disclaimer
    });
  })
);

const HistoryQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(20000).default(2000),
  stride: z.coerce.number().int().min(1).max(100).optional()
});

/** Historical navigation solutions for a run. */
router.get(
  '/navigation/history',
  requireAuth,
  validate(HistoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { runId, from, to, limit, stride } = q(req);
    const targetRun = runId ?? scenarioService.runId ?? replayService.runId;
    if (!targetRun) {
      return res.json({ run_id: null, items: [], message: 'No run is active and no run id was supplied.' });
    }
    const effectiveStride = stride ?? 1;
    const items = await rows(
      `SELECT * FROM (
         SELECT n.*, row_number() OVER (ORDER BY sim_time_s) AS rn
         FROM navigation_solutions n
         WHERE run_id = $1
           AND ($2::float8 IS NULL OR sim_time_s >= $2)
           AND ($3::float8 IS NULL OR sim_time_s <= $3)
       ) t
       WHERE (rn - 1) % $4 = 0
       ORDER BY sim_time_s LIMIT $5`,
      [targetRun, from ?? null, to ?? null, effectiveStride, limit]
    );
    res.json({ run_id: targetRun, count: items.length, stride: effectiveStride, items });
  })
);

/** Mode transition history. */
router.get(
  '/navigation/mode-transitions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const runId = req.query.runId ?? scenarioService.runId ?? replayService.runId;
    if (!runId) return res.json({ run_id: null, items: [] });
    const items = await rows(
      'SELECT * FROM mode_transitions WHERE run_id = $1 ORDER BY sim_time_s',
      [runId]
    );
    res.json({ run_id: runId, items });
  })
);

/** Current GNSS integrity assessment plus its recent history. */
router.get(
  '/navigation/gnss',
  requireAuth,
  asyncHandler(async (req, res) => {
    const current = scenarioService.current()?.gnss ?? replayService.lastOutput?.gnss ?? null;
    const runId = scenarioService.runId ?? replayService.runId;
    const history = runId
      ? await rows(
          `SELECT sim_time_s, trust_score, status, recommended_action, detected_conditions,
                  satellites, hdop, cn0_mean_dbhz, fix_type, diff_from_fused_m, diff_from_radar_m,
                  diff_from_bathy_m, diff_from_dr_m, drag_rate_m_per_s, time_offset_s
           FROM gnss_trust_records WHERE run_id = $1 ORDER BY sim_time_s DESC LIMIT 600`,
          [runId]
        )
      : [];
    res.json({
      current,
      history: history.reverse(),
      thresholds: getConfig().gnss_integrity,
      bands: [
        { min: 0, max: 20, status: 'REJECTED' },
        { min: 21, max: 50, status: 'HIGHLY_SUSPECT' },
        { min: 51, max: 75, status: 'DEGRADED' },
        { min: 76, max: 90, status: 'ACCEPTABLE' },
        { min: 91, max: 100, status: 'TRUSTED' }
      ]
    });
  })
);

/** Fusion and integrity engineering detail. */
router.get(
  '/navigation/integrity',
  requireAuth,
  asyncHandler(async (req, res) => {
    const output = scenarioService.current() ?? replayService.lastOutput;
    if (!output) return res.json({ available: false });
    const engine = scenarioService.engine;
    res.json({
      available: true,
      integrity: output.integrity,
      localization: output.localization,
      contributing_sensors: output.contributing_sensors,
      excluded_sensors: output.excluded_sensors,
      absolute_sources: output.absolute_sources,
      solution_confidence: output.solution_confidence,
      fusion_debug: engine ? engine.pipeline.fusion.debug() : output.fusion_debug,
      thresholds: {
        requirements: getConfig().requirements,
        integrity: getConfig().integrity,
        dead_reckoning: getConfig().dead_reckoning
      },
      terminology: {
        accuracy: 'How close the estimate is to truth. Measurable only against an independent reference.',
        precision: 'The spread of the estimate: the filter covariance.',
        confidence: 'A probability statement about a stated region, such as the 95% radius.',
        integrity: 'The ability to bound the error and warn when the bound is exceeded: the protection level.',
        availability: 'Whether a usable solution exists at all.',
        continuity: 'Whether it will keep existing for the duration of the intended operation.'
      }
    });
  })
);

/** Bathymetric matching detail, including the candidate surface. */
router.get(
  '/navigation/bathymetric',
  requireAuth,
  asyncHandler(async (req, res) => {
    const engine = scenarioService.engine;
    const result = engine?.pipeline?.bathyEngine?.lastResult ?? null;
    res.json({
      available: Boolean(result),
      result,
      sample_count: engine?.pipeline?.bathyEngine?.sampleCount ?? 0,
      note: 'A 10 cm bathymetric grid does not imply 10 cm positioning accuracy. Achievable accuracy is governed by seabed distinctiveness, sounder noise, tide and sound-velocity uncertainty, and vessel dynamics.'
    });
  })
);

/** Radar / LiDAR map-matching detail, including the Mode A vs Mode B choice. */
router.get(
  '/navigation/localization',
  requireAuth,
  asyncHandler(async (req, res) => {
    const engine = scenarioService.engine;
    res.json({
      radar: engine?.pipeline?.radarEngine?.lastResult ?? null,
      lidar: engine?.pipeline?.lidarEngine?.lastResult ?? null,
      local_ranging: engine?.pipeline?.localEngine?.lastResult ?? null,
      dead_reckoning: engine?.pipeline?.deadReckoning?.state() ?? null,
      mode_note:
        'Mode A is a vendor-supplied fix. Mode B is an independent scan match computed by this platform against the stored reference map. Where both are available the independent result is preferred, because it is auditable end to end.'
    });
  })
);

export default router;
