/** Scenario control, fault injection and alarms. */

import { Router } from 'express';
import { z } from 'zod';
import { scenarioService } from '../../services/scenarioService.js';
import { alarmService } from '../../services/alarmService.js';
import { FAULT_TYPES } from '../../simulation/faults.js';
import { getConfig } from '../../config/index.js';
import { AlarmSeverity, Role } from '../../models/enums.js';
import { asyncHandler, requireAuth, requireRole, validate, uuidParams, audit, q } from '../../middleware/index.js';

const router = Router();

// --- Scenarios --------------------------------------------------------------

router.get(
  '/scenarios',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      items: await scenarioService.listScenarios(),
      current: scenarioService.status(),
      allowed_speed_multipliers: getConfig().simulation.allowed_speed_multipliers
    });
  })
);

router.get('/scenarios/status', requireAuth, (req, res) => {
  res.json(scenarioService.status());
});

router.get('/scenarios/fault-types', requireAuth, (req, res) => {
  res.json({ items: scenarioService.faultCatalogue() });
});

const StartSchema = z.object({
  speedMultiplier: z.coerce.number().min(0.1).max(50).optional(),
  insEnabled: z.boolean().optional(),
  seed: z.coerce.number().int().optional(),
  label: z.string().max(120).optional()
});

router.post(
  '/scenarios/:scenarioId/start',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(StartSchema),
  audit('SCENARIO_START', 'scenario'),
  asyncHandler(async (req, res) => {
    const status = await scenarioService.start(req.params.scenarioId, {
      userId: req.user.id,
      speedMultiplier: req.body.speedMultiplier ?? 1,
      insEnabled: req.body.insEnabled ?? null,
      seed: req.body.seed ?? null,
      label: req.body.label ?? null
    });
    res.json(status);
  })
);

router.post(
  '/scenarios/pause',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('SCENARIO_PAUSE', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.pause()))
);

router.post(
  '/scenarios/resume',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('SCENARIO_RESUME', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.resume()))
);

router.post(
  '/scenarios/stop',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('SCENARIO_STOP', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.stop({ userId: req.user.id })))
);

router.post(
  '/scenarios/reset',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('SCENARIO_RESET', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.reset({ userId: req.user.id })))
);

const StepSchema = z.object({ seconds: z.coerce.number().min(0.1).max(60).default(1) });

router.post(
  '/scenarios/step',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(StepSchema),
  audit('SCENARIO_STEP', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.step(req.body.seconds)))
);

const SpeedSchema = z.object({ speedMultiplier: z.coerce.number().min(0.1).max(50) });

router.post(
  '/scenarios/speed',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(SpeedSchema),
  audit('SCENARIO_SPEED', 'scenario'),
  (req, res) => {
    res.json(scenarioService.setSpeed(req.body.speedMultiplier));
  }
);

const JumpSchema = z.object({ timeS: z.coerce.number().min(0).max(100000) });

router.post(
  '/scenarios/jump',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(JumpSchema),
  audit('SCENARIO_JUMP', 'scenario'),
  asyncHandler(async (req, res) => res.json(await scenarioService.jumpTo(req.body.timeS)))
);

const ManualFallbackSchema = z.object({ enabled: z.boolean() });

router.post(
  '/scenarios/manual-fallback',
  requireAuth,
  requireRole(Role.OPERATOR),
  validate(ManualFallbackSchema),
  audit('MANUAL_FALLBACK', 'scenario'),
  (req, res) => {
    const value = scenarioService.setManualFallback(req.body.enabled);
    res.json({
      manual_fallback: value,
      message: value
        ? 'Manual fallback engaged. The platform will stop publishing an automatic trusted position and will show raw sensor values only.'
        : 'Manual fallback cleared. Automatic navigation assurance has resumed.'
    });
  }
);

// --- Fault injection --------------------------------------------------------

const InjectSchema = z.object({
  type: z.enum(Object.keys(FAULT_TYPES)),
  sensor_id: z.string().min(1).max(64),
  label: z.string().max(120).optional(),
  start_s: z.coerce.number().min(0).optional(),
  end_s: z.coerce.number().min(0).optional(),
  duration_s: z.coerce.number().min(1).max(100000).optional(),
  params: z.record(z.coerce.number()).optional()
});

router.post(
  '/scenarios/inject-fault',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(InjectSchema),
  audit('FAULT_INJECT', 'scenario'),
  asyncHandler(async (req, res) => {
    const body = { ...req.body };
    if (body.duration_s && !body.end_s) {
      const start = body.start_s ?? scenarioService.engine?.time ?? 0;
      body.end_s = start + body.duration_s;
    }
    const fault = scenarioService.injectFault(body, req.user.id);
    res.status(201).json({ fault, scenario: scenarioService.status() });
  })
);

router.post(
  '/scenarios/remove-fault',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(z.object({ faultId: z.string().min(1).max(120) })),
  audit('FAULT_REMOVE', 'scenario'),
  asyncHandler(async (req, res) => {
    const removed = scenarioService.removeFault(req.body.faultId, req.user.id);
    res.json({ removed, scenario: scenarioService.status() });
  })
);

// --- Alarms -----------------------------------------------------------------

const AlarmQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  severity: z
    .union([z.enum(Object.values(AlarmSeverity)), z.array(z.enum(Object.values(AlarmSeverity)))])
    .optional(),
  code: z.string().max(64).optional(),
  source: z.string().max(64).optional(),
  active: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .optional(),
  acknowledged: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .optional(),
  search: z.string().max(160).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

router.get(
  '/alarms',
  requireAuth,
  validate(AlarmQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const filters = q(req);
    const result = await alarmService.list(filters);
    res.json({
      ...result,
      active_now: alarmService.snapshot(),
      summary: await alarmService.summary(filters.runId ?? null)
    });
  })
);

router.get(
  '/alarms/active',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: alarmService.snapshot(), summary: await alarmService.summary(scenarioService.runId) });
  })
);

router.post(
  '/alarms/:alarmId/acknowledge',
  requireAuth,
  uuidParams('alarmId'),
  requireRole(Role.OPERATOR),
  audit('ALARM_ACKNOWLEDGE', 'alarm'),
  asyncHandler(async (req, res) => {
    const alarm = await alarmService.acknowledge(req.params.alarmId, req.user.id);
    if (!alarm) return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown alarm.' });
    res.json({
      alarm,
      note: 'Acknowledgement records that the alarm has been seen. It does not clear the underlying condition, and the alarm stays active until the condition clears.'
    });
  })
);

router.post(
  '/alarms/acknowledge-all',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('ALARM_ACKNOWLEDGE_ALL', 'alarm'),
  asyncHandler(async (req, res) => {
    const count = await alarmService.acknowledgeAll(req.user.id);
    res.json({ acknowledged: count });
  })
);

export default router;
