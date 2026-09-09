/**
 * Vessel management.
 *
 * A vessel is the unit an operator manages: an identity, where it works, which
 * scenario it is experiencing, and which sensors it is fitted with. The sensor
 * fit is per vessel rather than global because two vessels in the same fleet
 * rarely carry the same equipment - a survey vessel with a multibeam and a
 * harbour tug without one need different pipelines, and a single global list
 * would be wrong for both.
 *
 * `fleet.yaml` seeds this table on first run and is then only a fallback. Once
 * a vessel exists in the database it is the database that owns it, so an
 * operator's edits are not silently overwritten by a redeploy.
 */

import { query, one, rows } from '../db/pool.js';
import { fleetConfig, getScenarioDefinition, sensorCatalog } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vessels');

/** Columns returned to clients, in a stable order. */
const SELECT = `
  id, name, vessel_type, call_sign, mmsi, imo, flag, operator,
  length_m, beam_m, draft_m,
  scenario_id, start_offset_s, station_offset_east_m, station_offset_north_m,
  focused, monitored, sensor_configuration, notes,
  created_at, updated_at
`;

/** Shape a database row into the object the API and the fleet service use. */
function toVessel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    vessel_type: row.vessel_type,
    call_sign: row.call_sign,
    mmsi: row.mmsi === null ? null : Number(row.mmsi),
    imo: row.imo === null ? null : Number(row.imo),
    flag: row.flag,
    operator: row.operator,
    dimensions: {
      length_m: row.length_m,
      beam_m: row.beam_m,
      draft_m: row.draft_m
    },
    scenario_id: row.scenario_id,
    scenario_name: getScenarioDefinition(row.scenario_id)?.name ?? null,
    start_offset_s: row.start_offset_s,
    station_offset: {
      east_m: row.station_offset_east_m,
      north_m: row.station_offset_north_m
    },
    focused: row.focused,
    monitored: row.monitored,
    sensor_configuration: row.sensor_configuration ?? {},
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** The sensors this vessel is fitted with, resolved against the catalogue. */
export function resolveSensorFit(vessel) {
  const configured = vessel?.sensor_configuration ?? {};
  return sensorCatalog.map((definition) => {
    const override = configured[definition.sensor_id] ?? {};
    return {
      sensor_id: definition.sensor_id,
      sensor_type: definition.sensor_type,
      name: definition.name,
      absolute_position_source: Boolean(definition.absolute_position_source),
      // Fitted unless the vessel explicitly says otherwise. A new vessel
      // therefore gets the full fit, which is the useful default; removing a
      // sensor is a deliberate act.
      fitted: override.fitted !== false,
      notes: override.notes ?? null
    };
  });
}

export class VesselService {
  async list({ monitoredOnly = false } = {}) {
    const result = await rows(
      `SELECT ${SELECT} FROM vessels
       ${monitoredOnly ? 'WHERE monitored' : ''}
       ORDER BY focused DESC, name ASC`
    );
    return result.map(toVessel);
  }

  async get(id) {
    const row = await one(`SELECT ${SELECT} FROM vessels WHERE id = $1`, [id]);
    return toVessel(row);
  }

  /**
   * Validate a vessel against the things a database constraint cannot express.
   * Returns a list of problems; empty means acceptable.
   */
  async validate(vessel, { existingId = null } = {}) {
    const problems = [];

    if (vessel.scenario_id && !getScenarioDefinition(vessel.scenario_id)) {
      problems.push({ field: 'scenario_id', message: `No scenario named "${vessel.scenario_id}".` });
    }

    // A vessel with no absolute positioning source can never satisfy the
    // requirement, whatever else it carries. Better to say so when the fit is
    // configured than to leave the operator wondering why it never goes green.
    const fit = resolveSensorFit(vessel);
    const absolute = fit.filter((s) => s.fitted && s.absolute_position_source);
    if (absolute.length === 0) {
      problems.push({
        field: 'sensor_configuration',
        message:
          'No absolute positioning source is fitted. This vessel can never report the requirement as met, ' +
          'because there would be nothing to bound its position against.'
      });
    }

    const heading = fit.filter((s) => s.fitted && ['GYRO', 'INS', 'RADAR'].includes(s.sensor_type));
    if (heading.length === 0) {
      problems.push({
        field: 'sensor_configuration',
        message: 'No heading reference is fitted. The filter cannot be initialised without one.'
      });
    }

    for (const [field, value] of [['mmsi', vessel.mmsi], ['imo', vessel.imo]]) {
      if (value === null || value === undefined) continue;
      const clash = await one(
        `SELECT id FROM vessels WHERE ${field} = $1 ${existingId ? 'AND id <> $2' : ''}`,
        existingId ? [value, existingId] : [value]
      );
      if (clash) {
        problems.push({ field, message: `${field.toUpperCase()} ${value} is already used by ${clash.id}.` });
      }
    }

    return problems;
  }

  async create(input, { userId = null } = {}) {
    const problems = await this.validate(input);
    if (problems.length > 0) {
      throw Object.assign(new Error('The vessel could not be accepted.'), {
        status: 400,
        code: 'VESSEL_INVALID',
        details: problems
      });
    }

    // Clearing any previous focus first keeps the single-focus index happy.
    if (input.focused) await query('UPDATE vessels SET focused = FALSE WHERE focused');

    const row = await one(
      `INSERT INTO vessels (
         id, name, vessel_type, call_sign, mmsi, imo, flag, operator,
         length_m, beam_m, draft_m,
         scenario_id, start_offset_s, station_offset_east_m, station_offset_north_m,
         focused, monitored, sensor_configuration, notes, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
       RETURNING ${SELECT}`,
      [
        input.id,
        input.name,
        input.vessel_type ?? null,
        input.call_sign ?? null,
        input.mmsi ?? null,
        input.imo ?? null,
        input.flag ?? null,
        input.operator ?? null,
        input.dimensions?.length_m ?? null,
        input.dimensions?.beam_m ?? null,
        input.dimensions?.draft_m ?? null,
        input.scenario_id ?? null,
        input.start_offset_s ?? 0,
        input.station_offset?.east_m ?? 0,
        input.station_offset?.north_m ?? 0,
        Boolean(input.focused),
        input.monitored !== false,
        JSON.stringify(input.sensor_configuration ?? {}),
        input.notes ?? null,
        userId
      ]
    );

    log.info('vessel created', { vessel_id: row.id, by: userId });
    return toVessel(row);
  }

  async update(id, input, { userId = null } = {}) {
    const existing = await this.get(id);
    if (!existing) {
      throw Object.assign(new Error('No such vessel.'), { status: 404, code: 'VESSEL_NOT_FOUND' });
    }

    const merged = { ...existing, ...input, id };
    const problems = await this.validate(merged, { existingId: id });
    if (problems.length > 0) {
      throw Object.assign(new Error('The change could not be accepted.'), {
        status: 400,
        code: 'VESSEL_INVALID',
        details: problems
      });
    }

    if (input.focused) await query('UPDATE vessels SET focused = FALSE WHERE focused AND id <> $1', [id]);

    const row = await one(
      `UPDATE vessels SET
         name = $2, vessel_type = $3, call_sign = $4, mmsi = $5, imo = $6,
         flag = $7, operator = $8, length_m = $9, beam_m = $10, draft_m = $11,
         scenario_id = $12, start_offset_s = $13,
         station_offset_east_m = $14, station_offset_north_m = $15,
         focused = $16, monitored = $17, sensor_configuration = $18, notes = $19,
         updated_at = now(), updated_by = $20
       WHERE id = $1
       RETURNING ${SELECT}`,
      [
        id,
        merged.name,
        merged.vessel_type ?? null,
        merged.call_sign ?? null,
        merged.mmsi ?? null,
        merged.imo ?? null,
        merged.flag ?? null,
        merged.operator ?? null,
        merged.dimensions?.length_m ?? null,
        merged.dimensions?.beam_m ?? null,
        merged.dimensions?.draft_m ?? null,
        merged.scenario_id ?? null,
        merged.start_offset_s ?? 0,
        merged.station_offset?.east_m ?? 0,
        merged.station_offset?.north_m ?? 0,
        Boolean(merged.focused),
        merged.monitored !== false,
        JSON.stringify(merged.sensor_configuration ?? {}),
        merged.notes ?? null,
        userId
      ]
    );

    log.info('vessel updated', { vessel_id: id, by: userId });
    return toVessel(row);
  }

  async remove(id, { userId = null } = {}) {
    const existing = await this.get(id);
    if (!existing) {
      throw Object.assign(new Error('No such vessel.'), { status: 404, code: 'VESSEL_NOT_FOUND' });
    }
    if (existing.focused) {
      // Removing the focused vessel would leave the detail screens, the
      // recorder and fault injection with nothing to follow.
      throw Object.assign(
        new Error('This is the focused vessel. Focus another vessel before deleting it.'),
        { status: 409, code: 'VESSEL_IS_FOCUSED' }
      );
    }

    await query('DELETE FROM vessels WHERE id = $1', [id]);
    log.info('vessel deleted', { vessel_id: id, by: userId });
    return { id, deleted: true };
  }

  /**
   * Seed the table from `fleet.yaml` if it is empty.
   *
   * Only when empty: once an operator has managed the fleet through the
   * interface, the database owns it and a redeploy must not overwrite their
   * work with the file's defaults.
   */
  async seedFromConfig() {
    const existing = await one('SELECT count(*)::int AS n FROM vessels');
    if ((existing?.n ?? 0) > 0) return { seeded: 0, reason: 'vessels already exist' };

    const profiles = fleetConfig?.vessels ?? [];
    let seeded = 0;
    for (const profile of profiles) {
      try {
        await this.create(
          {
            id: profile.id,
            name: profile.name,
            vessel_type: profile.type ?? null,
            call_sign: profile.call_sign ?? null,
            mmsi: profile.mmsi ?? null,
            flag: 'AE',
            scenario_id: profile.scenario,
            start_offset_s: profile.start_offset_s ?? 0,
            station_offset: profile.station_offset ?? { east_m: 0, north_m: 0 },
            focused: Boolean(profile.focused),
            monitored: true
          },
          { userId: null }
        );
        seeded += 1;
      } catch (err) {
        log.warn('could not seed vessel', { vessel_id: profile.id, message: err.message });
      }
    }
    log.info('fleet seeded from configuration', { seeded });
    return { seeded };
  }
}

export const vesselService = new VesselService();
export default vesselService;
