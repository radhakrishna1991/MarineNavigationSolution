/** Fleet monitoring: several vessels, each with its own navigation pipeline. */

import { Router } from 'express';
import { fleetService } from '../../services/fleetService.js';
import { fleetConfig } from '../../config/index.js';
import { Role } from '../../models/enums.js';
import { asyncHandler, requireAuth, requireRole, audit } from '../../middleware/index.js';

const router = Router();

/**
 * The whole fleet: every vessel's current state plus the counts an operations
 * room reads first. This is the fleet overview screen's only data source.
 */
router.get(
  '/fleet',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      ...fleetService.snapshot(),
      configured_vessels: (fleetConfig?.vessels ?? []).length
    });
  })
);

/** One vessel in full, for the detail screens. */
router.get(
  '/fleet/:vesselId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const detail = fleetService.vesselDetail(req.params.vesselId);
    if (!detail) {
      // A vessel that is configured but has not finished joining is a different
      // situation from one that does not exist, and the operator should be able
      // to tell them apart.
      const configured = (fleetConfig?.vessels ?? []).some((v) => v.id === req.params.vesselId);
      return res.status(configured ? 409 : 404).json({
        error: configured ? 'VESSEL_NOT_READY' : 'VESSEL_NOT_FOUND',
        message: configured
          ? 'That vessel is configured but has not yet joined the fleet.'
          : 'No such vessel.'
      });
    }
    res.json(detail);
  })
);

router.post(
  '/fleet/start',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('FLEET_START', 'fleet'),
  asyncHandler(async (req, res) => {
    // Not awaited: vessels are wound forward to their staggered start
    // positions in the background and join as they become ready, so the
    // request returns immediately rather than holding the connection open.
    fleetService.start();
    res.json({ ...fleetService.status(), starting: true });
  })
);

router.post(
  '/fleet/stop',
  requireAuth,
  requireRole(Role.OPERATOR),
  audit('FLEET_STOP', 'fleet'),
  asyncHandler(async (req, res) => res.json(fleetService.stop()))
);

export default router;
