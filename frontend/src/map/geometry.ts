/**
 * Geographic primitives shared by every chart renderer.
 *
 * The uncertainty geometry - the protection level circle, the requirement
 * limit and the confidence ellipse - has to be drawn identically whichever
 * basemap is underneath it. Building the rings here, in metres, rather than
 * relying on each renderer's own circle primitive means the MapLibre chart and
 * the Google chart are showing the same shape rather than two approximations
 * of it.
 */

/** Build a circle polygon in geographic coordinates. */
export function circlePolygon(lat: number, lon: number, radiusM: number, points = 64): GeoJSON.Polygon {
  const coords: [number, number][] = [];
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
  const mPerDegLon = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
  for (let i = 0; i <= points; i += 1) {
    const angle = (2 * Math.PI * i) / points;
    coords.push([lon + (radiusM * Math.sin(angle)) / mPerDegLon, lat + (radiusM * Math.cos(angle)) / mPerDegLat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

/** Build an ellipse polygon oriented by a compass bearing. */
export function ellipsePolygon(
  lat: number,
  lon: number,
  semiMajorM: number,
  semiMinorM: number,
  orientationDeg: number,
  points = 72
): GeoJSON.Polygon {
  const coords: [number, number][] = [];
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad);
  const mPerDegLon = 111412.84 * Math.cos(latRad);
  // Orientation is a bearing (clockwise from north) of the major axis.
  const rot = (orientationDeg * Math.PI) / 180;
  for (let i = 0; i <= points; i += 1) {
    const t = (2 * Math.PI * i) / points;
    const x = semiMajorM * Math.cos(t); // along the major axis
    const y = semiMinorM * Math.sin(t); // along the minor axis
    const north = x * Math.cos(rot) - y * Math.sin(rot);
    const east = x * Math.sin(rot) + y * Math.cos(rot);
    coords.push([lon + east / mPerDegLon, lat + north / mPerDegLat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}
