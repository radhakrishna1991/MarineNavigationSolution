/**
 * Synthetic UAE-like harbour environment (Section 14).
 *
 * IMPORTANT: every geometry, depth and feature in this module is invented for
 * demonstration. It is *not* derived from any official chart, ENC or survey and
 * must never be represented as navigational data. The label required by the
 * specification is attached to every layer emitted from here.
 *
 * Everything is generated deterministically from the configured origin so the
 * database seed, the simulator and the localization engines all share exactly
 * the same world.
 */

import { LocalFrame, pointInPolygon, pointSegmentDistance } from '../utils/geo.js';
import { getConfig } from '../config/index.js';

const DEMO_LABEL = 'Demonstration geospatial data - not for navigation.';

/** Smooth Hermite interpolation between two edges. */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Local-frame geometry definitions (metres, East/North from the origin)
// ---------------------------------------------------------------------------

/** Mainland with a dredged basin notched into the northern shoreline. */
const MAINLAND_RING = [
  [3600, -2800],
  [3600, -2100],
  [2000, -1950],
  [900, -1750],
  [300, -1600],
  [200, -1500],
  [150, -1900],
  [-750, -2000],
  [-800, -1450],
  [-900, -1400],
  [-1700, -1500],
  [-2600, -1900],
  [-3600, -2050],
  [-3600, -2800]
];

const EAST_BREAKWATER = [
  [170, -1510],
  [245, -1495],
  [65, -985],
  [-10, -1005]
];

const WEST_BREAKWATER = [
  [-915, -1385],
  [-845, -1415],
  [-340, -1035],
  [-410, -1005]
];

/** Small rocky island offshore, a strong radar target. */
const ISLAND_CENTRE = [1500, 400];
const ISLAND_RADIUS = 185;

/** Quay faces inside the basin - the LiDAR reference structures. */
const QUAY_LINES = [
  { id: 'QUAY_SOUTH', from: [-700, -1955], to: [95, -1885] },
  { id: 'QUAY_WEST', from: [-760, -1950], to: [-790, -1470] },
  { id: 'QUAY_EAST', from: [175, -1880], to: [195, -1530] }
];

/** Dredged approach channel centreline, from the entrance out to open water. */
const CHANNEL_CENTRELINE = [
  [-160, -1015],
  [-120, -400],
  [150, 400],
  [600, 1200],
  [1400, 1700],
  [2300, 2100]
];
const CHANNEL_HALF_WIDTH_M = 130;
const CHANNEL_DEPTH_M = 13.0;

/** Featureless dredged spoil basin in the west - deliberately ambiguous. */
const FLAT_ZONE_CENTRE = [-1750, 700];
const FLAT_ZONE_RADIUS = 1150;
const FLAT_ZONE_DEPTH_M = 15.6;

/** Distinctive ridges giving the survey polygon good terrain observability. */
const RIDGES = [
  { centre: [1750, 850], sigmaAlong: 520, sigmaAcross: 130, bearingDeg: 35, amplitude: -2.6 },
  { centre: [1150, 200], sigmaAlong: 430, sigmaAcross: 110, bearingDeg: 110, amplitude: 1.9 },
  { centre: [2250, 1450], sigmaAlong: 380, sigmaAcross: 150, bearingDeg: 70, amplitude: -1.7 }
];

/** Shoal patch - a no-go area for the vessel. */
const SHOAL_CENTRE = [900, -700];
const SHOAL_RADIUS = 320;

/** Approved operating area for the survey (Section 6). */
const OPERATING_AREA_RING = [
  [-3200, -2150],
  [3200, -2150],
  [3200, 2550],
  [-3200, 2550]
];

/** Navigation marks and other isolated radar targets. */
const NAVIGATION_MARKS = [
  { id: 'BUOY_APPROACH_1', e: -160, n: -820, kind: 'LATERAL_BUOY', rcs: 0.6 },
  { id: 'BUOY_APPROACH_2', e: -40, n: -560, kind: 'LATERAL_BUOY', rcs: 0.6 },
  { id: 'BUOY_CHANNEL_1', e: -20, n: 60, kind: 'LATERAL_BUOY', rcs: 0.6 },
  { id: 'BUOY_CHANNEL_2', e: 300, n: 640, kind: 'LATERAL_BUOY', rcs: 0.6 },
  { id: 'BUOY_CHANNEL_3', e: 760, n: 1400, kind: 'LATERAL_BUOY', rcs: 0.6 },
  { id: 'BUOY_SHOAL', e: 900, n: -360, kind: 'CARDINAL_BUOY', rcs: 0.7 },
  { id: 'RACON_ISLAND', e: 1500, n: 585, kind: 'RACON', rcs: 1.0 },
  { id: 'MAST_HARBOUR', e: -420, n: -1930, kind: 'MAST', rcs: 0.9 },
  { id: 'CRANE_QUAY_1', e: -430, n: -1900, kind: 'CRANE', rcs: 1.0 },
  { id: 'CRANE_QUAY_2', e: -140, n: -1880, kind: 'CRANE', rcs: 1.0 },
  { id: 'TANK_FARM', e: 620, n: -1720, kind: 'TANK', rcs: 0.95 }
];

/** Surveyed control points and local-ranging beacons (Section 10.6). */
const CONTROL_POINTS = [
  { id: 'CP_ALPHA', name: 'Survey Mark ALPHA', e: -780, n: -1960, type: 'SURVEY_MARK', accuracy_m: 0.01 },
  { id: 'CP_BRAVO', name: 'Survey Mark BRAVO', e: 210, n: -1870, type: 'SURVEY_MARK', accuracy_m: 0.01 },
  { id: 'CP_CHARLIE', name: 'Survey Mark CHARLIE', e: 250, n: -1490, type: 'SURVEY_MARK', accuracy_m: 0.015 },
  { id: 'BEACON_1', name: 'Ranging Beacon 1 (west head)', e: -905, n: -1370, type: 'RANGING_BEACON', accuracy_m: 0.05 },
  { id: 'BEACON_2', name: 'Ranging Beacon 2 (east head)', e: 190, n: -1500, type: 'RANGING_BEACON', accuracy_m: 0.05 },
  { id: 'BEACON_3', name: 'Ranging Beacon 3 (island)', e: 1500, n: 585, type: 'RANGING_BEACON', accuracy_m: 0.06 },
  { id: 'BEACON_4', name: 'Ranging Beacon 4 (north quay)', e: -430, n: -1470, type: 'RANGING_BEACON', accuracy_m: 0.05 },
  { id: 'BEACON_5', name: 'Ranging Beacon 5 (tank farm)', e: 620, n: -1720, type: 'RANGING_BEACON', accuracy_m: 0.07 },
  { id: 'LBL_1', name: 'LBL Transponder 1', e: 300, n: -300, type: 'LBL_TRANSPONDER', accuracy_m: 0.2 },
  { id: 'LBL_2', name: 'LBL Transponder 2', e: 1100, n: 500, type: 'LBL_TRANSPONDER', accuracy_m: 0.2 }
];

/**
 * The survey mission route (Section 16). Legs carry a target speed and a zone
 * label; the vessel model follows them with a rate-limited heading.
 */
const ROUTE_WAYPOINTS = [
  { e: -200, n: -1000, zone: 'HARBOUR_ENTRANCE', speed_mps: 3.0, label: 'Basin exit' },
  { e: -120, n: -400, zone: 'HARBOUR_ENTRANCE', speed_mps: 3.4, label: 'Entrance clear' },
  { e: 150, n: 400, zone: 'CHANNEL', speed_mps: 4.5, label: 'Channel inner' },
  { e: 600, n: 1200, zone: 'CHANNEL', speed_mps: 5.0, label: 'Channel outer' },
  { e: 1400, n: 1700, zone: 'OPEN_APPROACH', speed_mps: 5.5, label: 'Approach fairway' },
  { e: 2100, n: 1200, zone: 'SURVEY_POLYGON', speed_mps: 3.5, label: 'Survey line 1 start' },
  { e: 1600, n: 400, zone: 'SURVEY_POLYGON', speed_mps: 3.5, label: 'Survey line 1 end' },
  { e: 500, n: 100, zone: 'FEATURE_POOR', speed_mps: 5.0, label: 'Open water transit' },
  { e: -900, n: 500, zone: 'FEATURE_POOR', speed_mps: 5.0, label: 'Spoil ground west' },
  { e: -1800, n: 1300, zone: 'FEATURE_POOR', speed_mps: 5.0, label: 'Spoil ground north' },
  { e: -1000, n: 2000, zone: 'RETURN', speed_mps: 5.5, label: 'Return leg 1' },
  { e: 300, n: 2100, zone: 'RETURN', speed_mps: 5.5, label: 'Return leg 2' },
  { e: -200, n: -1000, zone: 'RETURN', speed_mps: 4.0, label: 'Basin re-entry' }
];

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

let cached = null;

/** Sample points along a polyline every `stepM` metres. */
function samplePolyline(points, stepM, closed = false) {
  const out = [];
  const ring = closed ? [...points, points[0]] : points;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.round(len / stepM));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  if (!closed) out.push(points[points.length - 1]);
  return out;
}

/** Circle approximated as a polygon ring. */
function circleRing(centre, radius, segments = 48) {
  const ring = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (2 * Math.PI * i) / segments;
    ring.push([centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)]);
  }
  return ring;
}

/** Distance from a point to the channel centreline. */
function distanceToChannel(e, n) {
  let best = Infinity;
  for (let i = 0; i < CHANNEL_CENTRELINE.length - 1; i += 1) {
    const [ax, ay] = CHANNEL_CENTRELINE[i];
    const [bx, by] = CHANNEL_CENTRELINE[i + 1];
    best = Math.min(best, pointSegmentDistance(e, n, ax, ay, bx, by));
  }
  return best;
}

/**
 * The synthetic seabed. Deterministic, analytic, and shared by the "true"
 * depth used to generate echo-sounder readings and the stored grid used by the
 * terrain-matching engine. The stored grid additionally carries survey noise so
 * that matching is not a trivial identity operation.
 *
 * @returns {number} depth below chart datum in metres (positive down)
 */
export function trueDepthAt(e, n) {
  // Regional slope: deeper to the north and east.
  let depth = 6.0 + 0.0030 * n + 0.0016 * e;

  // Dredged approach channel.
  const chan = distanceToChannel(e, n);
  if (chan < CHANNEL_HALF_WIDTH_M + 90) {
    const t = smoothstep(CHANNEL_HALF_WIDTH_M, CHANNEL_HALF_WIDTH_M + 90, chan);
    depth = mix(CHANNEL_DEPTH_M, depth, t);
  }

  // Dredged harbour basin.
  if (e > -820 && e < 210 && n > -2010 && n < -1400) {
    const edge = Math.min(e + 820, 210 - e, n + 2010, -1400 - n);
    depth = mix(9.2, depth, 1 - smoothstep(0, 60, edge));
  }

  // Sand waves - the primary source of terrain observability offshore.
  depth += 0.55 * Math.sin(e / 155) * Math.cos(n / 205);
  depth += 0.22 * Math.sin((e + n) / 88);

  // Distinctive ridges and troughs in the survey polygon.
  for (const ridge of RIDGES) {
    const br = (ridge.bearingDeg * Math.PI) / 180;
    const dx = e - ridge.centre[0];
    const dy = n - ridge.centre[1];
    const along = dx * Math.sin(br) + dy * Math.cos(br);
    const across = dx * Math.cos(br) - dy * Math.sin(br);
    depth +=
      ridge.amplitude *
      Math.exp(-0.5 * ((along / ridge.sigmaAlong) ** 2 + (across / ridge.sigmaAcross) ** 2));
  }

  // Shoal patch.
  const shoalDist = Math.hypot(e - SHOAL_CENTRE[0], n - SHOAL_CENTRE[1]);
  if (shoalDist < SHOAL_RADIUS * 1.6) {
    depth -= 4.2 * Math.exp(-0.5 * (shoalDist / (SHOAL_RADIUS * 0.55)) ** 2);
  }

  // Island shallows.
  const islandDist = Math.hypot(e - ISLAND_CENTRE[0], n - ISLAND_CENTRE[1]);
  if (islandDist < 700) {
    depth = mix(0.5, depth, smoothstep(ISLAND_RADIUS, 700, islandDist));
  }

  // Featureless dredged spoil basin: this region is deliberately almost flat so
  // that terrain matching becomes genuinely ambiguous (Section 4.6).
  const flatDist = Math.hypot(e - FLAT_ZONE_CENTRE[0], n - FLAT_ZONE_CENTRE[1]);
  if (flatDist < FLAT_ZONE_RADIUS + 250) {
    const t = smoothstep(FLAT_ZONE_RADIUS, FLAT_ZONE_RADIUS + 250, flatDist);
    const flat = FLAT_ZONE_DEPTH_M + 0.04 * Math.sin(e / 620) + 0.03 * Math.cos(n / 700);
    depth = mix(flat, depth, t);
  }

  return Math.max(0.4, depth);
}

/**
 * Build the whole environment once and memoise it.
 * @returns {object}
 */
export function buildEnvironment(force = false) {
  if (cached && !force) return cached;
  const cfg = getConfig();
  const originLat = cfg.simulation.environment.origin_latitude;
  const originLon = cfg.simulation.environment.origin_longitude;
  const frame = new LocalFrame(originLat, originLon);

  const toLngLat = ([e, n]) => {
    const g = frame.toGeodetic(e, n);
    return [Number(g.longitude.toFixed(8)), Number(g.latitude.toFixed(8))];
  };
  const ringToLngLat = (ring) => {
    const out = ring.map(toLngLat);
    out.push(out[0]);
    return out;
  };

  const islandRing = circleRing(ISLAND_CENTRE, ISLAND_RADIUS);
  const shoalRing = circleRing(SHOAL_CENTRE, SHOAL_RADIUS, 36);
  const flatRing = circleRing(FLAT_ZONE_CENTRE, FLAT_ZONE_RADIUS, 40);

  // --- Land -----------------------------------------------------------------
  const landFeatures = [
    { id: 'MAINLAND', name: 'Mainland (demonstration)', ring: MAINLAND_RING },
    { id: 'BREAKWATER_EAST', name: 'East breakwater', ring: EAST_BREAKWATER },
    { id: 'BREAKWATER_WEST', name: 'West breakwater', ring: WEST_BREAKWATER },
    { id: 'ISLAND', name: 'Rocky island', ring: islandRing }
  ];

  const landLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: landFeatures.map((f) => ({
      type: 'Feature',
      id: f.id,
      properties: { name: f.name, layer: 'land', demonstration_only: true },
      geometry: { type: 'Polygon', coordinates: [ringToLngLat(f.ring)] }
    }))
  };

  // --- Operating area, no-go areas, channel --------------------------------
  const operatingAreaLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: [
      {
        type: 'Feature',
        id: 'APPROVED_OPERATING_AREA',
        properties: {
          name: 'Approved operating area',
          layer: 'operating_area',
          demonstration_only: true,
          note: 'GNSS positions reported outside this polygon are treated as implausible.'
        },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(OPERATING_AREA_RING)] }
      }
    ]
  };

  const noGoLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: [
      {
        type: 'Feature',
        id: 'SHOAL_NO_GO',
        properties: { name: 'Charted shoal - no-go', layer: 'no_go', min_depth_m: 1.9, demonstration_only: true },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(shoalRing)] }
      },
      {
        type: 'Feature',
        id: 'ISLAND_EXCLUSION',
        properties: { name: 'Island exclusion zone', layer: 'no_go', demonstration_only: true },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(circleRing(ISLAND_CENTRE, 420, 36))] }
      }
    ]
  };

  const channelLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: [
      {
        type: 'Feature',
        id: 'APPROACH_CHANNEL',
        properties: {
          name: 'Dredged approach channel',
          layer: 'channel',
          design_depth_m: CHANNEL_DEPTH_M,
          half_width_m: CHANNEL_HALF_WIDTH_M,
          demonstration_only: true
        },
        geometry: { type: 'LineString', coordinates: CHANNEL_CENTRELINE.map(toLngLat) }
      },
      {
        type: 'Feature',
        id: 'FEATURE_POOR_ZONE',
        properties: {
          name: 'Dredged spoil ground - low terrain observability',
          layer: 'feature_poor',
          nominal_depth_m: FLAT_ZONE_DEPTH_M,
          demonstration_only: true
        },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(flatRing)] }
      }
    ]
  };

  // --- Radar reference map --------------------------------------------------
  // Shoreline and structure returns sampled every 30 m, plus isolated marks.
  const radarPoints = [];
  const pushSamples = (ring, kind, rcs, step, closed = true) => {
    for (const [e, n] of samplePolyline(ring, step, closed)) {
      radarPoints.push({ e: Number(e.toFixed(2)), n: Number(n.toFixed(2)), kind, rcs });
    }
  };
  pushSamples(MAINLAND_RING, 'SHORELINE', 0.5, 30);
  pushSamples(EAST_BREAKWATER, 'BREAKWATER', 0.8, 15);
  pushSamples(WEST_BREAKWATER, 'BREAKWATER', 0.8, 15);
  pushSamples(islandRing, 'ISLAND', 0.9, 20);
  for (const mark of NAVIGATION_MARKS) {
    radarPoints.push({ e: mark.e, n: mark.n, kind: mark.kind, rcs: mark.rcs, id: mark.id });
  }

  // --- LiDAR reference map --------------------------------------------------
  const lidarPoints = [];
  for (const quay of QUAY_LINES) {
    for (const [e, n] of samplePolyline([quay.from, quay.to], 3, false)) {
      lidarPoints.push({ e: Number(e.toFixed(2)), n: Number(n.toFixed(2)), kind: 'QUAY_FACE', rcs: 1.0 });
    }
  }
  for (const [e, n] of samplePolyline(EAST_BREAKWATER, 4, true)) {
    lidarPoints.push({ e: Number(e.toFixed(2)), n: Number(n.toFixed(2)), kind: 'BREAKWATER', rcs: 1.0 });
  }
  for (const [e, n] of samplePolyline(WEST_BREAKWATER, 4, true)) {
    lidarPoints.push({ e: Number(e.toFixed(2)), n: Number(n.toFixed(2)), kind: 'BREAKWATER', rcs: 1.0 });
  }

  const radarFeatureLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: NAVIGATION_MARKS.map((m) => ({
      type: 'Feature',
      id: m.id,
      properties: { name: m.id.replace(/_/g, ' '), layer: 'radar_feature', kind: m.kind, rcs: m.rcs, demonstration_only: true },
      geometry: { type: 'Point', coordinates: toLngLat([m.e, m.n]) }
    }))
  };

  // --- Control points -------------------------------------------------------
  const controlPoints = CONTROL_POINTS.map((cp) => {
    const g = frame.toGeodetic(cp.e, cp.n);
    return {
      id: cp.id,
      name: cp.name,
      point_type: cp.type,
      latitude: Number(g.latitude.toFixed(8)),
      longitude: Number(g.longitude.toFixed(8)),
      height_m: 2.5,
      accuracy_m: cp.accuracy_m,
      east_m: cp.e,
      north_m: cp.n
    };
  });

  const controlPointLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: controlPoints.map((cp) => ({
      type: 'Feature',
      id: cp.id,
      properties: {
        name: cp.name,
        layer: 'control_point',
        point_type: cp.point_type,
        accuracy_m: cp.accuracy_m,
        demonstration_only: true
      },
      geometry: { type: 'Point', coordinates: [cp.longitude, cp.latitude] }
    }))
  };

  // --- Bathymetric grid -----------------------------------------------------
  const grid = buildBathymetryGrid(frame, cfg);

  // --- Depth contours -------------------------------------------------------
  const contourLayer = buildContourLayer(grid, frame, [4, 6, 8, 10, 12, 14, 16, 18, 20]);

  // --- Route ----------------------------------------------------------------
  const routeLayer = {
    type: 'FeatureCollection',
    properties: { demonstration_only: true, label: DEMO_LABEL },
    features: [
      {
        type: 'Feature',
        id: 'PLANNED_ROUTE',
        properties: { name: 'Planned survey route', layer: 'route', demonstration_only: true },
        geometry: { type: 'LineString', coordinates: ROUTE_WAYPOINTS.map((w) => toLngLat([w.e, w.n])) }
      },
      ...ROUTE_WAYPOINTS.map((w, i) => ({
        type: 'Feature',
        id: `WP_${i}`,
        properties: { name: w.label, layer: 'waypoint', zone: w.zone, speed_mps: w.speed_mps, index: i, demonstration_only: true },
        geometry: { type: 'Point', coordinates: toLngLat([w.e, w.n]) }
      }))
    ]
  };

  cached = {
    label: DEMO_LABEL,
    origin: { latitude: originLat, longitude: originLon },
    frame,
    landRings: [MAINLAND_RING, EAST_BREAKWATER, WEST_BREAKWATER, islandRing],
    operatingAreaRing: OPERATING_AREA_RING,
    noGoRings: [shoalRing, circleRing(ISLAND_CENTRE, 420, 36)],
    routeWaypoints: ROUTE_WAYPOINTS,
    channelCentreline: CHANNEL_CENTRELINE,
    radarPoints,
    lidarPoints,
    navigationMarks: NAVIGATION_MARKS,
    controlPoints,
    bathymetry: grid,
    flatZone: { centre: FLAT_ZONE_CENTRE, radius: FLAT_ZONE_RADIUS },
    layers: {
      land: landLayer,
      operating_area: operatingAreaLayer,
      no_go: noGoLayer,
      channel: channelLayer,
      radar_features: radarFeatureLayer,
      control_points: controlPointLayer,
      contours: contourLayer,
      route: routeLayer
    }
  };
  return cached;
}

/** Reset the memoised environment (used after a configuration change). */
export function resetEnvironment() {
  cached = null;
}

/**
 * Sample the analytic seabed into a regular grid. The stored grid is the
 * *survey product*: it carries a small deterministic survey error relative to
 * the analytic truth, so terrain matching has to work against imperfect data
 * exactly as it would in reality.
 */
function buildBathymetryGrid(frame, cfg) {
  const spacing = cfg.geospatial.bathymetry.grid_spacing_m;
  const halfW = cfg.geospatial.bathymetry.grid_half_width_m;
  const halfH = cfg.geospatial.bathymetry.grid_half_height_m;
  const width = Math.floor((2 * halfW) / spacing) + 1;
  const height = Math.floor((2 * halfH) / spacing) + 1;
  const depths = new Float32Array(width * height);
  let minDepth = Infinity;
  let maxDepth = -Infinity;

  for (let j = 0; j < height; j += 1) {
    const n = -halfH + j * spacing;
    for (let i = 0; i < width; i += 1) {
      const e = -halfW + i * spacing;
      // Deterministic survey error: a smooth low-frequency component plus a
      // high-frequency component, both bounded by the stated vertical sigma.
      const surveyError =
        0.05 * Math.sin(e / 730 + 1.7) * Math.cos(n / 610 - 0.4) + 0.03 * Math.sin((e * 0.31 + n * 0.27) / 11);
      const d = trueDepthAt(e, n) + surveyError;
      depths[j * width + i] = d;
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
    }
  }

  return {
    id: 'BATHY_HARBOUR_01',
    name: 'Demonstration harbour bathymetry',
    originEastM: -halfW,
    originNorthM: -halfH,
    spacing,
    width,
    height,
    minDepth,
    maxDepth,
    verticalSigmaM: cfg.geospatial.bathymetry.map_sigma_m,
    surveyDate: '2024-11-15',
    depths,
    frame
  };
}

/**
 * Bilinear depth lookup in a stored grid.
 * @returns {number|null} null when the query is outside the grid
 */
export function sampleGridDepth(grid, e, n) {
  const fx = (e - grid.originEastM) / grid.spacing;
  const fy = (n - grid.originNorthM) / grid.spacing;
  if (fx < 0 || fy < 0 || fx > grid.width - 1 || fy > grid.height - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d00 = grid.depths[y0 * grid.width + x0];
  const d10 = grid.depths[y0 * grid.width + x1];
  const d01 = grid.depths[y1 * grid.width + x0];
  const d11 = grid.depths[y1 * grid.width + x1];
  return d00 * (1 - tx) * (1 - ty) + d10 * tx * (1 - ty) + d01 * (1 - tx) * ty + d11 * tx * ty;
}

/**
 * Local depth gradient in metres per metre - the single best indicator of
 * whether terrain matching can work at all at a given location.
 */
export function depthGradient(grid, e, n, step = 8) {
  const dE = (sampleGridDepth(grid, e + step, n) ?? 0) - (sampleGridDepth(grid, e - step, n) ?? 0);
  const dN = (sampleGridDepth(grid, e, n + step) ?? 0) - (sampleGridDepth(grid, e, n - step) ?? 0);
  return { dEast: dE / (2 * step), dNorth: dN / (2 * step), magnitude: Math.hypot(dE, dN) / (2 * step) };
}

/**
 * Marching-squares contour extraction, decimated for display.
 * Contours are a visual aid only - they are not used by any engine.
 */
function buildContourLayer(grid, frame, levels) {
  const features = [];
  const step = 4; // decimate the grid for display-weight contours
  for (const level of levels) {
    const segments = [];
    for (let j = 0; j + step < grid.height; j += step) {
      for (let i = 0; i + step < grid.width; i += step) {
        const e0 = grid.originEastM + i * grid.spacing;
        const n0 = grid.originNorthM + j * grid.spacing;
        const e1 = e0 + step * grid.spacing;
        const n1 = n0 + step * grid.spacing;
        const d00 = grid.depths[j * grid.width + i];
        const d10 = grid.depths[j * grid.width + (i + step)];
        const d01 = grid.depths[(j + step) * grid.width + i];
        const d11 = grid.depths[(j + step) * grid.width + (i + step)];
        const corners = [
          { d: d00, e: e0, n: n0 },
          { d: d10, e: e1, n: n0 },
          { d: d11, e: e1, n: n1 },
          { d: d01, e: e0, n: n1 }
        ];
        const crossings = [];
        for (let k = 0; k < 4; k += 1) {
          const a = corners[k];
          const b = corners[(k + 1) % 4];
          if ((a.d - level) * (b.d - level) < 0) {
            const t = (level - a.d) / (b.d - a.d);
            crossings.push([a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t]);
          }
        }
        if (crossings.length === 2) segments.push(crossings);
      }
    }
    if (segments.length === 0) continue;
    features.push({
      type: 'Feature',
      id: `CONTOUR_${level}`,
      properties: { name: `${level} m contour`, layer: 'contour', depth_m: level, demonstration_only: true },
      geometry: {
        type: 'MultiLineString',
        coordinates: segments.map((seg) =>
          seg.map(([e, n]) => {
            const g = frame.toGeodetic(e, n);
            return [Number(g.longitude.toFixed(7)), Number(g.latitude.toFixed(7))];
          })
        )
      }
    });
  }
  return { type: 'FeatureCollection', properties: { demonstration_only: true, label: DEMO_LABEL }, features };
}

/** Is a local-frame point on land? */
export function isOnLand(env, e, n) {
  return env.landRings.some((ring) => pointInPolygon([e, n], [ring]));
}

/** Is a local-frame point inside the approved operating area? */
export function isInOperatingArea(env, e, n) {
  return pointInPolygon([e, n], [env.operatingAreaRing]);
}

/** Is a local-frame point inside a charted no-go area? */
export function isInNoGoArea(env, e, n) {
  return env.noGoRings.some((ring) => pointInPolygon([e, n], [ring]));
}

export const DEMONSTRATION_LABEL = DEMO_LABEL;
export { ROUTE_WAYPOINTS, CHANNEL_CENTRELINE, QUAY_LINES };
