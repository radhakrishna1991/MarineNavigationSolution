/**
 * Deterministic vessel ground-truth model (Section 16).
 *
 * The vessel follows the planned route with a rate-limited heading and a
 * first-order speed response, which produces realistic turn dynamics without
 * the complexity of a full manoeuvring model. Given the same start state and
 * the same time step the trajectory is reproduced exactly.
 *
 * Ground truth is what the performance report measures *actual* error against;
 * it is never fed to the navigation pipeline.
 */

import { buildEnvironment, trueDepthAt } from '../geospatial/environment.js';
import { getConfig } from '../config/index.js';
import { normalizeHeading, headingDifference, neToCourseSpeed } from '../utils/geo.js';

/** Distance at which a waypoint is considered reached. */
const WAYPOINT_ARRIVAL_RADIUS_M = 45;

export class VesselModel {
  constructor({ environment = null } = {}) {
    const cfg = getConfig();
    this.env = environment || buildEnvironment();
    this.cfg = cfg.simulation.vessel;
    this.envCfg = cfg.simulation.environment;
    this.waypoints = this.env.routeWaypoints;
    this.reset();
  }

  reset() {
    const start = this.waypoints[0];
    const next = this.waypoints[1];
    this.legIndex = 1;
    this.east = start.e;
    this.north = start.n;
    const initialHeading = normalizeHeading(
      (Math.atan2(next.e - start.e, next.n - start.n) * 180) / Math.PI
    );
    this.heading = initialHeading;
    this.speed = start.speed_mps;
    this.turnRate = 0;
    this.time = 0;
    this.distanceTravelled = 0;
    this.lapCount = 0;
    this.zone = start.zone;
  }

  /** Target waypoint for the current leg. */
  get target() {
    return this.waypoints[Math.min(this.legIndex, this.waypoints.length - 1)];
  }

  /**
   * Advance the vessel by `dt` seconds.
   * @param {number} dt seconds
   * @returns {object} the ground-truth state after the step
   */
  step(dt) {
    const target = this.target;
    const dEast = target.e - this.east;
    const dNorth = target.n - this.north;
    const range = Math.hypot(dEast, dNorth);

    if (range < WAYPOINT_ARRIVAL_RADIUS_M) {
      this.legIndex += 1;
      if (this.legIndex >= this.waypoints.length) {
        // Loop the route so long runs remain well defined.
        this.legIndex = 1;
        this.lapCount += 1;
      }
      this.zone = this.waypoints[Math.min(this.legIndex, this.waypoints.length - 1)].zone;
    }

    const desiredHeading = normalizeHeading((Math.atan2(dEast, dNorth) * 180) / Math.PI);
    const headingError = headingDifference(desiredHeading, this.heading);
    const maxTurn = this.cfg.max_turn_rate_dps * dt;
    // Proportional heading controller with a rate limit.
    const commandedTurn = Math.max(-maxTurn, Math.min(maxTurn, headingError * 0.55));
    this.turnRate = dt > 0 ? commandedTurn / dt : 0;
    this.heading = normalizeHeading(this.heading + commandedTurn);

    // Speed responds to the leg's target speed with a first-order lag, and is
    // reduced while turning hard - as a real vessel would be.
    const turnPenalty = 1 - Math.min(0.35, Math.abs(this.turnRate) / (this.cfg.max_turn_rate_dps * 2.2));
    const desiredSpeed = Math.min(this.cfg.max_speed_mps, this.target.speed_mps * turnPenalty);
    const tau = 12.0;
    this.speed += ((desiredSpeed - this.speed) * dt) / tau;

    const headingRad = (this.heading * Math.PI) / 180;
    const vNorth = this.speed * Math.cos(headingRad);
    const vEast = this.speed * Math.sin(headingRad);
    this.east += vEast * dt;
    this.north += vNorth * dt;
    this.time += dt;
    this.distanceTravelled += this.speed * dt;

    return this.state();
  }

  /** Instantaneous tide height above chart datum (deterministic). */
  tideM(t = this.time) {
    const { tide_amplitude_m: amp, tide_period_s: period } = this.envCfg;
    return amp * Math.sin((2 * Math.PI * t) / period + 0.7);
  }

  /** Squat, proportional to speed squared. */
  squatM() {
    return this.envCfg.squat_coefficient * this.speed * this.speed;
  }

  /** Full ground-truth state at the current instant. */
  state() {
    const headingRad = (this.heading * Math.PI) / 180;
    const vNorth = this.speed * Math.cos(headingRad);
    const vEast = this.speed * Math.sin(headingRad);
    const geo = this.env.frame.toGeodetic(this.east, this.north);
    const seabedDepth = trueDepthAt(this.east, this.north);
    const tide = this.tideM();
    const draft = this.cfg.draft_m;
    const squat = this.squatM();
    // Depth below the transducer = charted depth + tide - draft - squat.
    const depthBelowKeel = seabedDepth + tide - draft - squat;
    const { courseDeg } = neToCourseSpeed(vNorth, vEast);
    return {
      time_s: this.time,
      east_m: this.east,
      north_m: this.north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      speed_mps: this.speed,
      velocity_north_mps: vNorth,
      velocity_east_mps: vEast,
      course_deg: courseDeg,
      heading_deg: this.heading,
      turn_rate_dps: this.turnRate,
      seabed_depth_m: seabedDepth,
      depth_below_transducer_m: depthBelowKeel,
      tide_m: tide,
      squat_m: squat,
      draft_m: draft,
      zone: this.zone,
      leg_index: this.legIndex,
      lap: this.lapCount,
      distance_travelled_m: this.distanceTravelled
    };
  }
}

export default VesselModel;
