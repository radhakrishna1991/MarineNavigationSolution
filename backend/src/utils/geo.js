/**
 * Geodetic helpers.
 *
 * The fusion filter runs in a *local East-North-Up tangent plane* anchored at a
 * configurable origin (the harbour reference point). Over the few kilometres of
 * an operating area, the tangent-plane approximation contributes well under a
 * centimetre of error, which is two orders of magnitude below the 2 m
 * requirement being assessed. Positions are converted back to WGS84 only for
 * display and export.
 */

export const WGS84_A = 6378137.0; // semi-major axis, metres
export const WGS84_F = 1 / 298.257223563; // flattening
export const WGS84_E2 = WGS84_F * (2 - WGS84_F); // first eccentricity squared

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

/**
 * Meridian radius of curvature (north-south) at a latitude.
 */
export function meridianRadius(latDeg) {
  const s = Math.sin(deg2rad(latDeg));
  return (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s * s, 1.5);
}

/**
 * Prime vertical radius of curvature (east-west) at a latitude.
 */
export function primeVerticalRadius(latDeg) {
  const s = Math.sin(deg2rad(latDeg));
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
}

/**
 * A local ENU frame anchored at (originLat, originLon).
 */
export class LocalFrame {
  /**
   * @param {number} originLat degrees
   * @param {number} originLon degrees
   */
  constructor(originLat, originLon) {
    this.originLat = originLat;
    this.originLon = originLon;
    this.mPerDegLat = (Math.PI / 180) * meridianRadius(originLat);
    this.mPerDegLon = (Math.PI / 180) * primeVerticalRadius(originLat) * Math.cos(deg2rad(originLat));
  }

  /**
   * WGS84 -> local ENU metres.
   * @returns {{ east: number, north: number }}
   */
  toLocal(latDeg, lonDeg) {
    return {
      east: (lonDeg - this.originLon) * this.mPerDegLon,
      north: (latDeg - this.originLat) * this.mPerDegLat
    };
  }

  /**
   * Local ENU metres -> WGS84.
   * @returns {{ latitude: number, longitude: number }}
   */
  toGeodetic(east, north) {
    return {
      latitude: this.originLat + north / this.mPerDegLat,
      longitude: this.originLon + east / this.mPerDegLon
    };
  }
}

/**
 * Great-circle-ish horizontal distance in metres between two WGS84 points.
 * Uses the haversine formula; adequate for the ranges involved (<100 km).
 */
export function haversineMetres(lat1, lon1, lat2, lon2) {
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * WGS84_A * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = deg2rad(lat1);
  const p2 = deg2rad(lat2);
  const dl = deg2rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (rad2deg(Math.atan2(y, x)) + 360) % 360;
}

/** Normalise a heading to [0, 360). */
export function normalizeHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Smallest signed difference a - b in degrees, in [-180, 180). */
export function headingDifference(a, b) {
  let diff = (a - b + 180) % 360;
  if (diff < 0) diff += 360;
  return diff - 180;
}

/** Convert a heading + speed into north/east velocity components. */
export function headingSpeedToNE(headingDeg, speedMps) {
  const h = deg2rad(headingDeg);
  return { north: speedMps * Math.cos(h), east: speedMps * Math.sin(h) };
}

/** Convert north/east velocity into course-over-ground and speed. */
export function neToCourseSpeed(north, east) {
  return {
    courseDeg: normalizeHeading(rad2deg(Math.atan2(east, north))),
    speedMps: Math.hypot(north, east)
  };
}

/**
 * Ray-casting point-in-polygon test.
 * @param {[number, number]} point [lon, lat]
 * @param {Array<[number, number]>} ring closed or open ring of [lon, lat]
 */
export function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-polygon supporting holes: `polygon` is an array of rings where the
 * first ring is the outer boundary and subsequent rings are holes.
 */
export function pointInPolygon(point, polygon) {
  if (!polygon || polygon.length === 0) return false;
  if (!pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(point, polygon[i])) return false;
  }
  return true;
}

/** Point-in-(Multi)Polygon for a GeoJSON geometry. */
export function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygon(point, poly));
  }
  return false;
}

/**
 * Shortest distance in metres from a point to a polygon boundary
 * (positive outside, negative inside).
 */
export function distanceToPolygonMetres(lat, lon, polygon, frame) {
  const p = frame.toLocal(lat, lon);
  let best = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = frame.toLocal(ring[j][1], ring[j][0]);
      const b = frame.toLocal(ring[i][1], ring[i][0]);
      best = Math.min(best, pointSegmentDistance(p.east, p.north, a.east, a.north, b.east, b.north));
    }
  }
  const inside = pointInPolygon([lon, lat], polygon);
  return inside ? -best : best;
}

/** Euclidean distance from (px,py) to segment (ax,ay)-(bx,by). */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Round coordinates for display without pretending to sub-millimetre precision. */
export function roundCoord(value, decimals = 8) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
