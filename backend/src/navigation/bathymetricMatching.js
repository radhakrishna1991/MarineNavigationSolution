/**
 * Bathymetric terrain-matching engine (Section 10.3).
 *
 * Method: sequence matching (the classical TERCOM idea applied to a survey
 * vessel). A short history of corrected seabed depths, together with the
 * relative track shape from the filter, is slid over the stored bathymetric
 * surface on a grid of candidate offsets. Each candidate gets a likelihood; the
 * shape of the resulting likelihood surface - not just its peak - determines
 * whether the fix may be used.
 *
 * Deliberate design decisions
 *  - A constant depth bias is estimated and removed per candidate. Draft,
 *    squat, sound-velocity and tide errors all appear as a common offset, and
 *    not removing it would make every candidate look equally bad.
 *  - Multi-modality is measured explicitly. Over a flat or repetitive seabed
 *    the surface has many near-equal peaks; the engine reports that as
 *    ambiguity and refuses to publish a confident fix (Section 4.6).
 *  - Terrain observability is reported separately from confidence. A confident
 *    match over unobservable terrain is a contradiction and is treated as one.
 *
 * SIMPLIFICATION NOTICE: a production system would use a particle filter with
 * a proper measurement likelihood per beam, full multibeam swath matching, and
 * rigorous tide/sound-velocity uncertainty propagation. This grid search is a
 * transparent stand-in with the same input and output contract.
 */

import { sampleGridDepth, depthGradient } from '../geospatial/environment.js';
import { LocalizationEngine } from '../models/enums.js';
import { stdDev } from '../utils/stats.js';

const DEFAULTS = {
  searchRadiusM: 60,
  gridStepM: 3,
  sequenceLength: 25,
  sampleIntervalS: 1.0,
  minSequenceLength: 8,
  depthSigmaM: 0.18,
  ambiguityPeakRatio: 0.65,
  ambiguitySeparationM: 18,
  minTerrainObservability: 0.12,
  maxBiasM: 3.0
};

export class BathymetricMatchingEngine {
  constructor({ environment, tuning = {} }) {
    this.env = environment;
    this.grid = environment.bathymetry;
    this.tuning = { ...DEFAULTS, ...tuning };
    this.reset();
  }

  reset() {
    /** @type {{ t:number, east:number, north:number, depth:number }[]} */
    this.buffer = [];
    this.lastSampleTime = null;
    this.lastResult = null;
  }

  /**
   * Predicted tide at a time. In a deployment this comes from a tide model or
   * a tide gauge; here it is the true tide plus a small deterministic
   * prediction error so the engine never sees a perfect correction.
   */
  predictedTideM(t, trueTideM) {
    const predictionError = 0.06 * Math.sin(t / 260 + 0.9);
    return trueTideM + predictionError;
  }

  /**
   * Add a depth observation to the matching buffer.
   *
   * @param {object} obs
   * @param {number} obs.time simulation time
   * @param {number} obs.depthBelowTransducerM raw sounder reading
   * @param {number} obs.transducerOffsetM
   * @param {number} obs.tideM predicted tide (already corrected for prediction error)
   * @param {number} obs.squatM
   * @param {number} obs.east filter position estimate at the observation time
   * @param {number} obs.north
   */
  addObservation({ time, depthBelowTransducerM, transducerOffsetM, tideM, squatM, east, north }) {
    if (this.lastSampleTime !== null && time - this.lastSampleTime < this.tuning.sampleIntervalS) return;
    this.lastSampleTime = time;
    // Reduce the sounder reading to depth below chart datum.
    const datumDepth = depthBelowTransducerM + transducerOffsetM + squatM - tideM;
    this.buffer.push({ t: time, east, north, depth: datumDepth });
    if (this.buffer.length > this.tuning.sequenceLength) this.buffer.shift();
  }

  /** Number of buffered observations. */
  get sampleCount() {
    return this.buffer.length;
  }

  /**
   * Attempt a terrain fix around the predicted position.
   *
   * @param {object} prior { east, north, sigmaM }
   * @param {number} time simulation time
   * @returns {object} match result (always returned, `valid` says whether it may be used)
   */
  match(prior, time) {
    const t = this.tuning;
    if (this.buffer.length < t.minSequenceLength) {
      return this.emptyResult(time, 'INSUFFICIENT_DEPTH_HISTORY');
    }
    if (!prior || !Number.isFinite(prior.east)) {
      return this.emptyResult(time, 'NO_PRIOR_POSITION');
    }

    // Track shape relative to the most recent sample.
    const last = this.buffer[this.buffer.length - 1];
    const track = this.buffer.map((s) => ({
      de: s.east - last.east,
      dn: s.north - last.north,
      depth: s.depth
    }));

    // --- Terrain observability -------------------------------------------
    // How much depth variation does the map actually contain along this track,
    // and how steep is the local gradient? Both are needed: a steep uniform
    // slope is observable across-slope but not along it.
    const mapDepthsAlongTrack = track
      .map((p) => sampleGridDepth(this.grid, prior.east + p.de, prior.north + p.dn))
      .filter((d) => d !== null);
    const trackRelief = stdDev(mapDepthsAlongTrack) ?? 0;
    const grad = depthGradient(this.grid, prior.east, prior.north, 12);
    // Normalised to roughly 0..1 for typical harbour terrain.
    // Normalisers are calibrated against the relief actually present in a
    // dredged harbour approach: 0.35 m of along-track relief or a 5 mm/m slope
    // is enough to constrain position, and either alone saturates its term.
    const observability = Math.max(
      0,
      Math.min(1, 0.55 * Math.min(1, trackRelief / 0.35) + 0.45 * Math.min(1, grad.magnitude / 0.005))
    );

    // --- Candidate grid search --------------------------------------------
    const radius = t.searchRadiusM;
    const step = t.gridStepM;
    const candidates = [];
    let bestCost = Infinity;

    for (let de = -radius; de <= radius; de += step) {
      for (let dn = -radius; dn <= radius; dn += step) {
        const ce = prior.east + de;
        const cn = prior.north + dn;
        let sum = 0;
        let sumSq = 0;
        let count = 0;
        const residuals = [];
        for (const p of track) {
          const mapDepth = sampleGridDepth(this.grid, ce + p.de, cn + p.dn);
          if (mapDepth === null) continue;
          const r = p.depth - mapDepth;
          residuals.push(r);
          sum += r;
          sumSq += r * r;
          count += 1;
        }
        if (count < t.minSequenceLength) continue;
        // Estimate and remove the common depth bias.
        const bias = Math.max(-t.maxBiasM, Math.min(t.maxBiasM, sum / count));
        const cost = sumSq / count - 2 * bias * (sum / count) + bias * bias;
        candidates.push({ de, dn, east: ce, north: cn, cost, bias, samples: count });
        if (cost < bestCost) bestCost = cost;
      }
    }

    if (candidates.length === 0) {
      return this.emptyResult(time, 'NO_MAP_COVERAGE', { terrain_observability: observability });
    }

    // --- Likelihood surface -----------------------------------------------
    const sigma2 = t.depthSigmaM ** 2 + this.grid.verticalSigmaM ** 2;
    let norm = 0;
    for (const c of candidates) {
      c.likelihood = Math.exp(-(c.cost - bestCost) / (2 * sigma2));
      norm += c.likelihood;
    }
    for (const c of candidates) c.weight = c.likelihood / norm;

    const best = candidates.reduce((a, b) => (b.likelihood > a.likelihood ? b : a));

    // Weighted mean and covariance of the likelihood surface.
    let mE = 0;
    let mN = 0;
    for (const c of candidates) {
      mE += c.weight * c.east;
      mN += c.weight * c.north;
    }
    let vEE = 0;
    let vNN = 0;
    let vEN = 0;
    for (const c of candidates) {
      vEE += c.weight * (c.east - mE) ** 2;
      vNN += c.weight * (c.north - mN) ** 2;
      vEN += c.weight * (c.east - mE) * (c.north - mN);
    }
    // The grid discretisation itself contributes uncertainty.
    const gridVar = (step * step) / 12;
    const covariance = [
      [vEE + gridVar, vEN],
      [vEN, vNN + gridVar]
    ];
    const sigmaM = Math.sqrt(Math.max(vEE, vNN) + gridVar);

    // --- Ambiguity detection ----------------------------------------------
    // Count distinct peaks that are close in likelihood to the best one but
    // far away in space. That is precisely the "repetitive seabed" failure.
    const peakThreshold = best.likelihood * t.ambiguityPeakRatio;
    const strongCandidates = candidates.filter((c) => c.likelihood >= peakThreshold);
    const modes = [];
    for (const c of strongCandidates.sort((a, b) => b.likelihood - a.likelihood)) {
      const near = modes.find((m) => Math.hypot(m.east - c.east, m.north - c.north) < t.ambiguitySeparationM);
      if (!near) modes.push(c);
    }
    // Fraction of the search area that is "almost as good" as the best fix.
    const massFraction = strongCandidates.reduce((acc, c) => acc + c.weight, 0);
    const spatialSpread = Math.sqrt(vEE + vNN);
    const ambiguityScore = Math.max(
      0,
      Math.min(
        1,
        0.45 * Math.min(1, (modes.length - 1) / 3) +
          0.3 * massFraction +
          0.25 * Math.min(1, spatialSpread / (radius * 0.6))
      )
    );

    // --- Confidence ---------------------------------------------------------
    const residualQuality = Math.exp(-Math.sqrt(Math.max(0, bestCost)) / (3 * Math.sqrt(sigma2)));
    const confidence = Math.max(
      0,
      Math.min(1, residualQuality * (1 - ambiguityScore) * (0.25 + 0.75 * observability))
    );

    const valid =
      observability >= t.minTerrainObservability &&
      ambiguityScore < 0.6 &&
      confidence > 0.12 &&
      sigmaM < radius;

    let reason = 'OK';
    if (observability < t.minTerrainObservability) reason = 'TERRAIN_NOT_OBSERVABLE';
    else if (ambiguityScore >= 0.6) reason = 'AMBIGUOUS_MULTIPLE_CANDIDATES';
    else if (confidence <= 0.12) reason = 'CONFIDENCE_BELOW_THRESHOLD';
    else if (sigmaM >= radius) reason = 'SOLUTION_SPREAD_EXCEEDS_SEARCH_AREA';

    const geo = this.env.frame.toGeodetic(best.east, best.north);
    const result = {
      engine: LocalizationEngine.BATHYMETRIC_TERRAIN_MATCHING,
      time_s: time,
      valid,
      reason,
      east_m: best.east,
      north_m: best.north,
      latitude: geo.latitude,
      longitude: geo.longitude,
      covariance,
      sigma_m: sigmaM,
      confidence: Number(confidence.toFixed(4)),
      ambiguity_score: Number(ambiguityScore.toFixed(4)),
      terrain_observability: Number(observability.toFixed(4)),
      candidate_count: candidates.length,
      mode_count: modes.length,
      best_cost: Number(bestCost.toFixed(5)),
      residual_rms_m: Number(Math.sqrt(Math.max(0, bestCost)).toFixed(4)),
      depth_bias_m: Number(best.bias.toFixed(4)),
      sequence_length: track.length,
      track_relief_m: Number(trackRelief.toFixed(4)),
      gradient_magnitude: Number(grad.magnitude.toFixed(6)),
      // Top candidates for the engineering panel - the ambiguity made visible.
      top_candidates: candidates
        .sort((a, b) => b.likelihood - a.likelihood)
        .slice(0, 12)
        .map((c) => ({
          east_m: Number(c.east.toFixed(2)),
          north_m: Number(c.north.toFixed(2)),
          offset_east_m: c.de,
          offset_north_m: c.dn,
          weight: Number(c.weight.toFixed(5)),
          cost: Number(c.cost.toFixed(5))
        }))
    };
    this.lastResult = result;
    return result;
  }

  emptyResult(time, reason, extra = {}) {
    const result = {
      engine: LocalizationEngine.BATHYMETRIC_TERRAIN_MATCHING,
      time_s: time,
      valid: false,
      reason,
      east_m: null,
      north_m: null,
      latitude: null,
      longitude: null,
      covariance: null,
      sigma_m: null,
      confidence: 0,
      ambiguity_score: 1,
      terrain_observability: 0,
      candidate_count: 0,
      mode_count: 0,
      sequence_length: this.buffer.length,
      top_candidates: [],
      ...extra
    };
    this.lastResult = result;
    return result;
  }
}

export default BathymetricMatchingEngine;
