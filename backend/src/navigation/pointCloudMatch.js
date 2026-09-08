/**
 * Simplified 2-D scan matching (Sections 10.1 Mode B and 10.2).
 *
 * This is an intentionally transparent point-to-point ICP with a spatial hash
 * for nearest-neighbour lookup and a trimmed-correspondence robust step. It is
 * NOT a production radar/LiDAR localization stack:
 *
 *   - no motion distortion correction
 *   - no probabilistic data association
 *   - no multi-hypothesis tracking
 *   - no sensor-specific clutter or sea-state model
 *
 * It is included because the specification requires a working simplified
 * implementation with defined input/output contracts and tests, and because it
 * makes the difference between a "vendor fix" (Mode A) and a fix the platform
 * computed itself (Mode B) visible in the demonstration. In production this
 * module would be replaced by the OEM localization output ingested through the
 * same adapter contract.
 *
 * Contract
 *   input : scan (body-frame [x_forward, y_starboard] metres),
 *           reference map (local-frame [east, north] metres),
 *           initial pose guess { east, north, headingRad }
 *   output: refined pose, covariance, inlier count, RMS residual, confidence
 */

/** Grid-based nearest-neighbour index over the reference cloud. */
export class SpatialIndex {
  /**
   * @param {Array<{e:number,n:number}>|Array<[number,number]>} points
   * @param {number} cellSize metres
   */
  constructor(points, cellSize = 40) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.points = points.map((p) => (Array.isArray(p) ? { e: p[0], n: p[1] } : p));
    for (let i = 0; i < this.points.length; i += 1) {
      const key = this.key(this.points[i].e, this.points[i].n);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  key(e, n) {
    return `${Math.floor(e / this.cellSize)},${Math.floor(n / this.cellSize)}`;
  }

  /**
   * Nearest reference point to (e, n) within `maxDistance`.
   * @returns {{ point: object, distance: number }|null}
   */
  nearest(e, n, maxDistance = 60) {
    const radiusCells = Math.ceil(maxDistance / this.cellSize);
    const cx = Math.floor(e / this.cellSize);
    const cy = Math.floor(n / this.cellSize);
    let best = null;
    let bestDist = maxDistance;
    for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
      for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
        const bucket = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          const p = this.points[idx];
          const d = Math.hypot(p.e - e, p.n - n);
          if (d < bestDist) {
            bestDist = d;
            best = p;
          }
        }
      }
    }
    return best ? { point: best, distance: bestDist } : null;
  }
}

/**
 * Run trimmed ICP.
 *
 * @param {object} args
 * @param {Array<[number, number]>} args.scan body-frame points [forward, starboard]
 * @param {SpatialIndex} args.index reference map index (local ENU frame)
 * @param {{east:number, north:number, headingRad:number}} args.initialPose
 * @param {object} [args.options]
 * @returns {object} match result
 */
export function icpMatch({ scan, index, initialPose, options = {} }) {
  const {
    maxIterations = 25,
    convergenceM = 0.01,
    maxCorrespondenceM = 45,
    trimFraction = 0.8,
    minInliers = 6
  } = options;

  if (!scan || scan.length < minInliers) {
    return {
      converged: false,
      reason: 'INSUFFICIENT_SCAN_POINTS',
      pose: { ...initialPose },
      inliers: 0,
      rmsResidualM: null,
      confidence: 0,
      covariance: null,
      iterations: 0
    };
  }

  let { east, north, headingRad } = initialPose;
  let iterations = 0;
  let inliers = 0;
  let rms = null;
  let lastShift = Infinity;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    const cos = Math.cos(headingRad);
    const sin = Math.sin(headingRad);

    // Transform the body-frame scan into the map frame.
    const correspondences = [];
    for (const [fwd, stb] of scan) {
      const e = east + fwd * sin + stb * cos;
      const n = north + fwd * cos - stb * sin;
      const nn = index.nearest(e, n, maxCorrespondenceM);
      if (nn) correspondences.push({ src: [e, n], dst: [nn.point.e, nn.point.n], d: nn.distance, body: [fwd, stb] });
    }

    if (correspondences.length < minInliers) {
      return {
        converged: false,
        reason: 'INSUFFICIENT_CORRESPONDENCES',
        pose: { east, north, headingRad },
        inliers: correspondences.length,
        rmsResidualM: null,
        confidence: 0,
        covariance: null,
        iterations
      };
    }

    // Trim the worst correspondences - a cheap but effective robust step.
    correspondences.sort((a, b) => a.d - b.d);
    const keep = Math.max(minInliers, Math.floor(correspondences.length * trimFraction));
    const used = correspondences.slice(0, keep);
    inliers = used.length;

    // Closed-form 2-D rigid alignment (Umeyama / Kabsch in the plane).
    const meanSrc = used.reduce((acc, c) => [acc[0] + c.src[0] / used.length, acc[1] + c.src[1] / used.length], [0, 0]);
    const meanDst = used.reduce((acc, c) => [acc[0] + c.dst[0] / used.length, acc[1] + c.dst[1] / used.length], [0, 0]);
    let sxx = 0;
    let sxy = 0;
    for (const c of used) {
      const sx = c.src[0] - meanSrc[0];
      const sy = c.src[1] - meanSrc[1];
      const dx = c.dst[0] - meanDst[0];
      const dy = c.dst[1] - meanDst[1];
      sxx += sx * dx + sy * dy;
      sxy += sx * dy - sy * dx;
    }
    const dTheta = Math.atan2(sxy, sxx);
    const cT = Math.cos(dTheta);
    const sT = Math.sin(dTheta);
    const tx = meanDst[0] - (cT * meanSrc[0] - sT * meanSrc[1]);
    const ty = meanDst[1] - (sT * meanSrc[0] + cT * meanSrc[1]);

    const newEast = cT * east - sT * north + tx;
    const newNorth = sT * east + cT * north + ty;
    // Rotation in the map frame is a clockwise-from-north heading, so the sign
    // of the correction is inverted relative to the mathematical convention.
    const newHeading = headingRad - dTheta;

    lastShift = Math.hypot(newEast - east, newNorth - north) + Math.abs(dTheta) * 30;
    east = newEast;
    north = newNorth;
    headingRad = newHeading;

    rms = Math.sqrt(used.reduce((acc, c) => acc + c.d * c.d, 0) / used.length);
    if (lastShift < convergenceM) break;
  }

  // Covariance from the residual spread and the correspondence geometry. This
  // is an approximation, not a rigorous Cramer-Rao bound, and is labelled as
  // such wherever it is displayed.
  const sigma = Math.max(0.05, (rms ?? 5) / Math.sqrt(Math.max(1, inliers)));
  const covariance = [
    [sigma * sigma, 0],
    [0, sigma * sigma]
  ];

  // Confidence blends inlier ratio against residual quality.
  const inlierRatio = inliers / scan.length;
  const residualQuality = rms === null ? 0 : Math.exp(-(rms / 6));
  const confidence = Math.max(0, Math.min(1, inlierRatio * residualQuality * 1.25));

  return {
    converged: lastShift < convergenceM * 10,
    reason: lastShift < convergenceM * 10 ? 'CONVERGED' : 'MAX_ITERATIONS',
    pose: { east, north, headingRad },
    inliers,
    scanPoints: scan.length,
    inlierRatio: Number(inlierRatio.toFixed(4)),
    rmsResidualM: rms === null ? null : Number(rms.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    covariance,
    sigmaM: Number(sigma.toFixed(4)),
    iterations
  };
}

export default icpMatch;
