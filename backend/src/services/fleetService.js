/**
 * Fleet monitoring.
 *
 * Runs a complete, independent navigation pipeline for every vessel in the
 * fleet. Nothing is shared between them - not the filter, not the GNSS trust
 * assessment, not the integrity calculation - because in service nothing would
 * be. A spoofing attack on one vessel says nothing about the others, and an
 * operator watching a fleet needs each vessel's answer to stand on its own.
 *
 * The cost of that independence is real but small: each vessel is a few hundred
 * floating-point operations per epoch, and the loop advances all of them from
 * one timer rather than one timer each.
 *
 * Relationship to `scenarioService`: that service owns the *focused* vessel -
 * the one with full recording, fault injection and replay. This service owns
 * the rest of the fleet, which is monitored but not recorded. Keeping them
 * separate means fleet monitoring cannot disturb the audit trail of the vessel
 * under detailed examination.
 */

import { EventEmitter } from 'node:events';
import { ScenarioEngine } from '../simulation/engine.js';
import { fleetConfig, getScenarioDefinition } from '../config/index.js';
import { vesselService } from './vesselService.js';
import { ScenarioState } from '../models/enums.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fleet');

/** Wall-clock tick. Vessels are advanced by real elapsed time. */
const TICK_MS = 200;

export class FleetService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {profile: object, engine: ScenarioEngine, output: object|null}>} */
    this.vessels = new Map();
    this.timer = null;
    this.lastTickAt = null;
    this.lastBroadcastAt = 0;
    this.running = false;
  }

  /**
   * Vessel profiles, excluding the focused vessel.
   *
   * The database is the source of truth once it holds anything, so an
   * operator's edits survive a redeploy. `fleet.yaml` is the fallback for a
   * fresh install and for tests, which run without a database.
   */
  async loadProfiles() {
    try {
      const vessels = await vesselService.list({ monitoredOnly: true });
      if (vessels.length > 0) {
        return vessels
          .filter((v) => !v.focused)
          .map((v) => ({
            id: v.id,
            name: v.name,
            type: v.vessel_type,
            call_sign: v.call_sign,
            mmsi: v.mmsi,
            scenario: v.scenario_id,
            start_offset_s: v.start_offset_s,
            station_offset: v.station_offset
          }));
      }
    } catch (err) {
      // A database that is unreachable must not stop fleet monitoring: the
      // configured fleet is a usable answer, and navigation is the point.
      log.warn('could not read vessels from the database; using configuration', { message: err.message });
    }
    return this.profiles;
  }

  /** The configured fleet, used as the fallback when the database has nothing. */
  get profiles() {
    return (fleetConfig?.vessels ?? []).filter((v) => !v.focused);
  }

  /** The focused vessel's profile, if one is declared. */
  get focusedProfile() {
    return (fleetConfig?.vessels ?? []).find((v) => v.focused) ?? null;
  }

  /**
   * Build the fleet and begin advancing it.
   *
   * Each vessel is staggered along its route by running it forward silently
   * before the first broadcast, so the fleet is spread across the operating
   * area instead of stacked on one another at the start line.
   */
  async start() {
    this.stop();
    this.running = true;
    this.lastTickAt = Date.now();

    // Begin ticking straight away. Vessels join the fleet as their stagger
    // completes, rather than the caller waiting for all of them: winding six
    // vessels forward several minutes each takes seconds of CPU, and blocking
    // the event loop for that long would stall every other request on the
    // server, including the health check.
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();

    const profiles = await this.loadProfiles();
    for (const profile of profiles) {
      const scenario = getScenarioDefinition(profile.scenario);
      if (!scenario) {
        log.warn('fleet vessel skipped - unknown scenario', {
          vessel_id: profile.id,
          scenario: profile.scenario
        });
        continue;
      }

      const engine = new ScenarioEngine({ scenario, stationOffset: profile.station_offset ?? null });
      engine.state = ScenarioState.RUNNING;

      // Stagger. Advancing in chunks keeps each engine's own tick accounting
      // intact, which is what makes a vessel's run reproducible.
      const offset = Math.max(0, Number(profile.start_offset_s) || 0);
      let remaining = offset;
      let last = null;
      while (remaining > 0 && this.running) {
        const chunk = Math.min(20, remaining);
        const { outputs } = engine.advance(chunk);
        if (outputs.length) last = outputs[outputs.length - 1];
        remaining -= chunk;
        // Hand the event loop back between chunks.
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (!this.running) return this.status(); // stopped while we were winding
      this.vessels.set(profile.id, { profile, engine, output: last });
    }

    if (this.vessels.size === 0) {
      log.warn('fleet started with no vessels - none configured');
    } else {
      log.info('fleet ready', { vessels: this.vessels.size });
    }
    return this.status();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.vessels.clear();
    this.running = false;
    this.lastTickAt = null;
    return this.status();
  }

  /** Advance every vessel by the elapsed wall-clock time. */
  tick() {
    if (!this.running) return;
    const now = Date.now();
    const deltaS = Math.min(2, (now - (this.lastTickAt ?? now)) / 1000);
    this.lastTickAt = now;
    if (deltaS <= 0) return;

    for (const vessel of this.vessels.values()) {
      try {
        const { outputs } = vessel.engine.advance(deltaS);
        if (outputs.length) vessel.output = outputs[outputs.length - 1];

        // A vessel that reaches the end of its scenario starts again rather
        // than freezing. A fleet display with stopped vessels on it looks
        // broken, and there is nothing to be learned from a frozen track.
        if (vessel.engine.complete) {
          const scenario = getScenarioDefinition(vessel.profile.scenario);
          vessel.engine = new ScenarioEngine({ scenario, stationOffset: vessel.profile.station_offset ?? null });
          vessel.engine.state = ScenarioState.RUNNING;
        }
      } catch (err) {
        // One vessel's fault must not stop the rest of the fleet.
        log.error('fleet vessel step failed', {
          vessel_id: vessel.profile.id,
          message: err.message
        });
      }
    }

    const broadcastInterval = (fleetConfig?.broadcast_interval_s ?? 1) * 1000;
    if (now - this.lastBroadcastAt >= broadcastInterval) {
      this.lastBroadcastAt = now;
      this.emit('fleet', this.snapshot());
    }
  }

  /** One vessel's current state, in the shape the dashboard consumes. */
  vesselSummary(vessel) {
    const { profile, engine, output } = vessel;
    const integrity = output?.integrity ?? null;

    return {
      vessel_id: profile.id,
      name: profile.name,
      type: profile.type ?? null,
      call_sign: profile.call_sign ?? null,
      mmsi: profile.mmsi ?? null,
      scenario_id: profile.scenario,
      scenario_name: engine.scenario?.name ?? null,
      sim_time_s: output?.time_s ?? null,

      position: output?.trusted_position ?? null,
      heading_deg: output?.heading_deg ?? null,
      speed_mps: output?.velocity?.speed_mps ?? null,
      course_deg: output?.course_deg ?? null,

      navigation_mode: output?.navigation_mode ?? null,
      mode_label: output?.navigation_mode_detail?.label ?? null,
      operator_guidance: output?.navigation_mode_detail?.operator_guidance ?? null,

      solution_available: output?.solution_available ?? false,
      requirement_status: integrity?.requirement_status ?? null,
      integrity_status: integrity?.integrity_status ?? null,
      horizontal_protection_level_m: integrity?.horizontal_protection_level_m ?? null,
      requirement_limit_m: integrity?.requirement_limit_m ?? null,
      independent_absolute_sources: integrity?.independent_absolute_sources ?? 0,
      protection_level_growth_rate_m_per_s: integrity?.protection_level_growth_rate_m_per_s ?? null,
      dead_reckoning_duration_s: integrity?.dead_reckoning_duration_s ?? null,

      gnss_trust_score: output?.gnss?.trust_score ?? null,
      gnss_status: output?.gnss?.status ?? null,
      gnss_spoofing_suspected: Boolean(output?.gnss?.spoofing_suspected),
      gnss_jamming_suspected: Boolean(output?.gnss?.jamming_suspected),

      contributing_sensors: output?.contributing_sensors ?? [],
      excluded_sensors: output?.excluded_sensors ?? [],

      // Truth is carried for the demonstration overlay only. It is absent on a
      // live feed, and no estimator anywhere reads it.
      ground_truth: output?.truth
        ? { latitude: output.truth.latitude, longitude: output.truth.longitude }
        : null,
      actual_error_m: output?.actual_error_vs_truth_m ?? null
    };
  }

  /** Every vessel, plus counts an operations room needs at a glance. */
  snapshot() {
    const vessels = [...this.vessels.values()].map((v) => this.vesselSummary(v));

    const counts = {
      total: vessels.length,
      requirement_met: 0,
      requirement_at_risk: 0,
      requirement_not_met: 0,
      integrity_not_assured: 0,
      gnss_rejected: 0,
      under_attack: 0
    };

    for (const v of vessels) {
      if (v.requirement_status === 'REQUIREMENT_MET') counts.requirement_met += 1;
      else if (v.requirement_status === 'REQUIREMENT_AT_RISK') counts.requirement_at_risk += 1;
      else if (v.requirement_status === 'REQUIREMENT_NOT_MET') counts.requirement_not_met += 1;
      if (v.integrity_status === 'NOT_ASSURED') counts.integrity_not_assured += 1;
      if (v.excluded_sensors?.some((id) => id.startsWith('GNSS'))) counts.gnss_rejected += 1;
      if (v.gnss_spoofing_suspected || v.gnss_jamming_suspected) counts.under_attack += 1;
    }

    return {
      running: this.running,
      broadcast_interval_s: fleetConfig?.broadcast_interval_s ?? 1,
      counts,
      vessels
    };
  }

  status() {
    return { running: this.running, vessel_count: this.vessels.size };
  }

  /** One vessel's full navigation output, for the detail screens. */
  vesselDetail(vesselId) {
    const vessel = this.vessels.get(vesselId);
    if (!vessel) return null;
    return {
      ...this.vesselSummary(vessel),
      navigation: vessel.output ?? null,
      scenario: vessel.engine.snapshot()
    };
  }

  async shutdown() {
    this.stop();
  }
}

export const fleetService = new FleetService();
export default fleetService;
