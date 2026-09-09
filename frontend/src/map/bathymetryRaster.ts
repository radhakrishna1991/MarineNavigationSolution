/**
 * Seabed rendering.
 *
 * The depth grid used to be drawn as one filled polygon per cell - tens of
 * thousands of hard-edged squares, which read as a mosaic rather than a seabed
 * and cost a great deal to render. This turns the same grid into a single
 * shaded image instead: MapLibre resamples it smoothly, so the seabed reads as
 * a continuous surface, and the whole layer is one draw call.
 *
 * The image also carries relief shading. Depth alone is a flat colour wash and
 * the eye cannot pick out a channel edge or a bank from it; lighting the slope
 * makes the shape of the seabed legible at a glance, which is the point of
 * showing bathymetry on a navigation display at all.
 *
 * This is a visualisation. The colours are not a chart symbology, the shading
 * is not a survey product, and neither is used by any estimator - the terrain
 * matcher works from the numeric grid, never from these pixels.
 */

import { themeHex } from '../theme/theme';

export interface BathymetryGrid {
  /** `[longitude, latitude, depth_m]`, row-major from the API. */
  cells: [number, number, number][];
  cell_size_m: number;
  min_depth_m: number;
  max_depth_m: number;
}

export interface BathymetryImage {
  /** PNG data URL for a MapLibre `image` source. */
  url: string;
  /** Corner coordinates: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  width: number;
  height: number;
}

/**
 * The depth ramp, shallow to deep, read from the active theme.
 *
 * Stops are positioned as fractions of the surveyed depth range rather than at
 * fixed depths. A harbour that runs 0-20 m would otherwise use only the palest
 * third of a 0-30 m ramp, leaving the seabed almost uniformly pale and the
 * shape of the channel invisible - the ramp has to fit the data it is showing.
 */
function ramp(): { at: number; rgb: [number, number, number] }[] {
  const hexToRgb = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
  return [
    { at: 0, rgb: hexToRgb(themeHex('map-depth-0')) },
    { at: 0.13, rgb: hexToRgb(themeHex('map-depth-1')) },
    { at: 0.27, rgb: hexToRgb(themeHex('map-depth-2')) },
    { at: 0.43, rgb: hexToRgb(themeHex('map-depth-3')) },
    { at: 0.6, rgb: hexToRgb(themeHex('map-depth-4')) },
    { at: 0.8, rgb: hexToRgb(themeHex('map-depth-5')) },
    { at: 1, rgb: hexToRgb(themeHex('map-depth-6')) }
  ];
}

/** `fraction` is the depth's position within the surveyed range, 0 to 1. */
function sampleRamp(stops: ReturnType<typeof ramp>, fraction: number): [number, number, number] {
  if (fraction <= stops[0].at) return stops[0].rgb;
  for (let i = 1; i < stops.length; i += 1) {
    if (fraction <= stops[i].at) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (fraction - a.at) / (b.at - a.at || 1);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t)
      ];
    }
  }
  return stops[stops.length - 1].rgb;
}

/**
 * Rasterise the depth grid into a shaded PNG.
 *
 * Returns null when the grid is missing or degenerate, so the caller can leave
 * the layer out rather than draw something meaningless.
 */
export function buildBathymetryImage(grid: BathymetryGrid | undefined): BathymetryImage | null {
  if (!grid?.cells?.length) return null;
  const cells = grid.cells;

  // Reconstruct the grid axes. The API streams cells row-major, but sorting the
  // distinct coordinates rather than trusting that order keeps this correct if
  // the ordering ever changes.
  const lonValues = [...new Set(cells.map((c) => c[0]))].sort((a, b) => a - b);
  const latValues = [...new Set(cells.map((c) => c[1]))].sort((a, b) => b - a); // north first: image rows run top-down
  const width = lonValues.length;
  const height = latValues.length;
  if (width < 2 || height < 2) return null;

  const lonIndex = new Map(lonValues.map((v, i) => [v, i]));
  const latIndex = new Map(latValues.map((v, i) => [v, i]));

  // NaN marks a cell the grid does not cover, so gaps stay transparent rather
  // than being painted as zero depth - which would read as a shoal.
  const depths = new Float32Array(width * height).fill(Number.NaN);
  for (const [lon, lat, depth] of cells) {
    const x = lonIndex.get(lon);
    const y = latIndex.get(lat);
    if (x === undefined || y === undefined) continue;
    depths[y * width + x] = depth;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(width, height);
  const stops = ramp();

  // Normalise against the surveyed range so the full ramp is always used.
  const shallowest = Number.isFinite(grid.min_depth_m) ? grid.min_depth_m : 0;
  const deepest = Number.isFinite(grid.max_depth_m) ? grid.max_depth_m : shallowest + 1;
  const span = Math.max(0.1, deepest - shallowest);

  // Metres per cell, used to turn a depth difference into a real slope.
  const metresPerCell = grid.cell_size_m || 1;
  const at = (x: number, y: number) => {
    const v = depths[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    return Number.isNaN(v) ? Number.NaN : v;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const depth = depths[y * width + x];
      if (Number.isNaN(depth)) {
        image.data[index + 3] = 0;
        continue;
      }

      const [r, g, b] = sampleRamp(stops, (depth - shallowest) / span);

      // Relief shading. Depth increases downward, so a positive gradient means
      // the seabed is falling away. Light comes from the north-west, the
      // cartographic convention - relief lit from below reads as inverted.
      const west = at(x - 1, y);
      const east = at(x + 1, y);
      const north = at(x, y - 1);
      const south = at(x, y + 1);
      let shade = 1;
      if (!Number.isNaN(west) && !Number.isNaN(east) && !Number.isNaN(north) && !Number.isNaN(south)) {
        const dzdx = (east - west) / (2 * metresPerCell);
        const dzdy = (south - north) / (2 * metresPerCell);
        // Exaggerated: real harbour slopes are far too gentle to see otherwise.
        const relief = (dzdx + dzdy) * 12;
        // Headroom for brightening depends on how pale the colour already is.
        // Without this the light palette clips to white on every slope and the
        // seabed loses the shape the shading exists to reveal.
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const brightest = 1 + 0.16 * (1 - luminance);
        shade = Math.max(0.8, Math.min(brightest, 1 - relief));
      }

      image.data[index] = Math.max(0, Math.min(255, Math.round(r * shade)));
      image.data[index + 1] = Math.max(0, Math.min(255, Math.round(g * shade)));
      image.data[index + 2] = Math.max(0, Math.min(255, Math.round(b * shade)));
      image.data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  // Cell coordinates are centres, so the image covers half a cell beyond each
  // outer centre. Without this the raster is offset by half a cell against
  // every vector layer drawn on top of it.
  const halfLon = (lonValues[1] - lonValues[0]) / 2;
  const halfLat = (latValues[0] - latValues[1]) / 2;
  const west = lonValues[0] - halfLon;
  const east = lonValues[width - 1] + halfLon;
  const north = latValues[0] + halfLat;
  const south = latValues[height - 1] - halfLat;

  return {
    url: canvas.toDataURL('image/png'),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south]
    ],
    width,
    height
  };
}
