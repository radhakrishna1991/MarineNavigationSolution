/** Vessel management: create, read, update and delete the monitored fleet. */

import { Router } from 'express';
import { z } from 'zod';
import { vesselService, resolveSensorFit } from '../../services/vesselService.js';
import { fleetService } from '../../services/fleetService.js';
import { scenarioCatalog, sensorCatalog } from '../../config/index.js';
import { Role } from '../../models/enums.js';
import { asyncHandler, requireAuth, requireRole, validate, audit, q } from '../../middleware/index.js';

const router = Router();

/**
 * A vessel identifier appears in log lines, alarm sources and file names, so it
 * is restricted to a safe character class rather than accepting free text.
 */
const VesselId = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscores, starting with a letter.');

const Dimensions = z
  .object({
    length_m: z.number().positive().max(500).nullable().optional(),
    beam_m: z.number().positive().max(100).nullable().optional(),
    draft_m: z.number().positive().max(40).nullable().optional()
  })
  .strict()
  .optional();

const StationOffset = z
  .object({
    // Bounded to the operating area: an offset of hundreds of kilometres would
    // put the vessel outside the surveyed environment, where every sensor that
    // depends on the map would silently stop working.
    east_m: z.number().min(-20000).max(20000).default(0),
    north_m: z.number().min(-20000).max(20000).default(0)
  })
  .strict()
  .optional();

/** Per-sensor overrides, keyed by sensor id. */
const SensorConfiguration = z
  .record(
    z.string().regex(/^[A-Z0-9_]+$/),
    z.object({ fitted: z.boolean().optional(), notes: z.string().max(500).nullable().optional() }).strict()
  )
  .optional();

const VesselBody = z
  .object({
    id: VesselId,
    name: z.string().min(1).max(120),
    vessel_type: z.string().max(80).nullable().optional(),
    call_sign: z.string().max(20).nullable().optional(),
    mmsi: z.number().int().min(100000000).max(999999999).nullable().optional(),
    imo: z.number().int().min(1000000).max(9999999).nullable().optional(),
    flag: z.string().max(3).nullable().optional(),
    operator: z.string().max(120).nullable().optional(),
    dimensions: Dimensions,
    scenario_id: z.string().max(80).nullable().optional(),
    start_offset_s: z.number().min(0).max(3600).default(0),
    station_offset: StationOffset,
    focused: z.boolean().default(false),
    monitored: z.boolean().default(true),
    sensor_configuration: SensorConfiguration,
    notes: z.string().max(2000).nullable().optional()
  })
  .strict();

/** Updates omit the id, which comes from the path. */
const VesselUpdate = VesselBody.omit({ id: true }).partial().strict();

router.get(
  '/vessels',
  requireAuth,
  validate(z.object({ monitored: z.coerce.boolean().optional() }).strict(), 'query'),
  asyncHandler(async (req, res) => {
    const items = await vesselService.list({ monitoredOnly: q(req).monitored === true });
    res.json({
      items,
      total: items.length,
      // Everything a form needs to offer valid choices, so the client never has
      // to hard-code a list that could drift from the server's.
      reference: {
        scenarios: scenarioCatalog.map((s) => ({ id: s.id, name: s.name, category: s.category })),
        sensors: sensorCatalog.map((s) => ({
          sensor_id: s.sensor_id,
          sensor_type: s.sensor_type,
          name: s.name,
          absolute_position_source: Boolean(s.absolute_position_source)
        }))
      }
    });
  })
);

router.get(
  '/vessels/:vesselId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const vessel = await vesselService.get(req.params.vesselId);
    if (!vessel) {
      return res.status(404).json({ error: 'VESSEL_NOT_FOUND', message: 'No such vessel.' });
    }
    res.json({
      vessel,
      sensor_fit: resolveSensorFit(vessel),
      live: fleetService.vesselDetail(req.params.vesselId)
    });
  })
);

router.post(
  '/vessels',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(VesselBody),
  audit('VESSEL_CREATE', 'vessel'),
  asyncHandler(async (req, res) => {
    const vessel = await vesselService.create(req.body, { userId: req.user.id });
    res.status(201).json({ vessel });
  })
);

router.put(
  '/vessels/:vesselId',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(VesselUpdate),
  audit('VESSEL_UPDATE', 'vessel'),
  asyncHandler(async (req, res) => {
    const vessel = await vesselService.update(req.params.vesselId, req.body, { userId: req.user.id });
    res.json({ vessel });
  })
);

router.delete(
  '/vessels/:vesselId',
  requireAuth,
  requireRole(Role.ENGINEER),
  audit('VESSEL_DELETE', 'vessel'),
  asyncHandler(async (req, res) => {
    const result = await vesselService.remove(req.params.vesselId, { userId: req.user.id });
    res.json(result);
  })
);

/**
 * Rebuild the running fleet from the current vessel records.
 *
 * Editing a vessel changes what will be monitored, not what is running right
 * now: restarting a vessel's pipeline discards its filter state, and doing that
 * silently on every keystroke would be hostile. The operator asks for it.
 */
router.post(
  '/vessels/apply',
  requireAuth,
  requireRole(Role.ENGINEER),
  audit('FLEET_APPLY', 'fleet'),
  asyncHandler(async (req, res) => {
    fleetService.start();
    res.json({ ...fleetService.status(), applying: true });
  })
);

export default router;
