/**
 * Local positioning engine (Section 10.6).
 *
 * Handles absolute fixes from local infrastructure: UWB, Locata-like
 * terrestrial ranging, radio beacons, total-station observations and acoustic
 * LBL/USBL. All of them share one contract - an absolute position with a
 * covariance and a coverage/geometry quality figure - so a single engine with a
 * configurable technology label covers all of them.
 *
 * If ranges to individual beacons are supplied rather than a computed position,
 * the engine solves for position by weighted least squares against the surveyed
 * control points, which is what a total station or an LBL array actually gives.
 */

import { LocalizationEngine } from '../models/enums.js';

const MAX_ITERATIONS = 12;
const CONVERGENCE_M = 0.01;

export class LocalPositioningEngine {
  constructor({ environment }) {
    this.env = environment;
    this.beacons = new Map();
    for (const cp of environment.controlPoints) {
      this.beacons.set(cp.id, cp);
    }
    this.lastResult = null;
  }

  /**
   * @param {object} message normalized LOCAL_RANGING message
   * @param {object} prior { east, north } used to seed a range solution
   */
  process(message, prior) {
    const ranges = message.raw?.ranges;
    if (Array.isArray(ranges) && ranges.length >= 3) {
      return this.solveFromRanges(ranges, prior, message);
    }
    return this.parsePositionFix(message);
  }

  /** A pre-computed position fix from the local system. */
  parsePositionFix(message) {
    if (!message.position || message.valid === false) {
      return this.invalid(message, 'NO_POSITION_IN_MESSAGE');
    }
    const q = message.quality || {};
    const local = this.env.frame.toLocal(message.position.latitude, message.position.longitude);
    const cov = Array.isArray(q.position_covariance)
      ? [
          [q.position_covariance[0], q.position_covariance[1]],
          [q.position_covariance[2], q.position_covariance[3]]
        ]
      : [
          [0.25, 0],
          [0, 0.25]
        ];
    const sigma = Math.sqrt(Math.max(cov[0][0], cov[1][1]));
    const result = {
      engine: LocalizationEngine.LOCAL_POSITIONING,
      sensor_id: message.sensor_id,
      valid: true,
      reason: 'OK',
      method: 'VENDOR_POSITION_FIX',
      technology: q.technology ?? 'UNKNOWN',
      east_m: local.east,
      north_m: local.north,
      latitude: message.position.latitude,
      longitude: message.position.longitude,
      covariance: cov,
      sigma_m: sigma,
      confidence: q.confidence ?? 0.8,
      beacon_count: q.beacon_count ?? null,
      gdop: q.gdop ?? null
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Weighted least-squares trilateration against surveyed control points.
   * @param {{beacon_id:string, range_m:number, sigma_m?:number}[]} ranges
   */
  solveFromRanges(ranges, prior, message) {
    const usable = ranges
      .map((r) => ({ ...r, beacon: this.beacons.get(r.beacon_id) }))
      .filter((r) => r.beacon && Number.isFinite(r.range_m));

    if (usable.length < 3) return this.invalid(message, 'INSUFFICIENT_BEACONS');

    let east = prior?.east ?? usable[0].beacon.east_m;
    let north = prior?.north ?? usable[0].beacon.north_m;

    let covariance = null;
    for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
      // Normal equations for a 2-parameter fit: A^T W A dx = A^T W dz
      let a11 = 0;
      let a12 = 0;
      let a22 = 0;
      let b1 = 0;
      let b2 = 0;
      for (const r of usable) {
        const de = east - r.beacon.east_m;
        const dn = north - r.beacon.north_m;
        const predicted = Math.hypot(de, dn);
        if (predicted < 1e-6) continue;
        const w = 1 / (r.sigma_m ?? 0.1) ** 2;
        const ge = de / predicted;
        const gn = dn / predicted;
        const residual = r.range_m - predicted;
        a11 += w * ge * ge;
        a12 += w * ge * gn;
        a22 += w * gn * gn;
        b1 += w * ge * residual;
        b2 += w * gn * residual;
      }
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-12) return this.invalid(message, 'SINGULAR_GEOMETRY');
      const dE = (a22 * b1 - a12 * b2) / det;
      const dN = (a11 * b2 - a12 * b1) / det;
      east += dE;
      north += dN;
      covariance = [
        [a22 / det, -a12 / det],
        [-a12 / det, a11 / det]
      ];
      if (Math.hypot(dE, dN) < CONVERGENCE_M) break;
    }

    const sigma = Math.sqrt(Math.max(covariance[0][0], covariance[1][1]));
    const gdop = Math.sqrt(covariance[0][0] + covariance[1][1]);
    const geo = this.env.frame.toGeodetic(east, north);
    const result = {
      engine: LocalizationEngine.LOCAL_POSITIONING,
      sensor_id: message.sensor_id,
      valid: sigma < 5,
      reason: sigma < 5 ? 'OK' : 'GEOMETRY_TOO_WEAK',
      method: 'WEIGHTED_LEAST_SQUARES_TRILATERATION',
      technology: message.quality?.technology ?? 'RANGING',
      east_m: east,
      north_m: north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      covariance,
      sigma_m: sigma,
      confidence: Math.max(0, Math.min(1, 1 / (1 + sigma))),
      beacon_count: usable.length,
      gdop: Number(gdop.toFixed(3)),
      beacons_used: usable.map((r) => r.beacon_id)
    };
    this.lastResult = result;
    return result;
  }

  invalid(message, reason) {
    const result = {
      engine: LocalizationEngine.LOCAL_POSITIONING,
      sensor_id: message?.sensor_id ?? null,
      valid: false,
      reason,
      east_m: null,
      north_m: null,
      latitude: null,
      longitude: null,
      covariance: null,
      sigma_m: null,
      confidence: 0
    };
    this.lastResult = result;
    return result;
  }
}

export default LocalPositioningEngine;
