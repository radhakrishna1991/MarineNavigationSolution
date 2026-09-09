/**
 * Seabed raster tests.
 *
 * The grid-to-image conversion is pure geometry, and geometry that is slightly
 * wrong is the worst kind: a half-cell offset looks plausible until the channel
 * edge sits a cell away from where the vessel actually is. These check the
 * arithmetic rather than the appearance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBathymetryImage, type BathymetryGrid } from '../src/map/bathymetryRaster';

/**
 * A canvas stub with just enough 2D context to run the encoder.
 *
 * jsdom has no canvas, and the global setup makes `getContext` return null so
 * the map's own guard is exercised. Here the real path is wanted, so the
 * element is replaced with something that records what was drawn.
 */
let lastImageData: ImageData | null = null;

beforeEach(() => {
  lastImageData = null;
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return document.createElementNS('http://www.w3.org/1999/xhtml', tag);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w: number, h: number) =>
          ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData,
        putImageData: (data: ImageData) => {
          lastImageData = data;
        }
      }),
      toDataURL: () => 'data:image/png;base64,stub'
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
});

/** A 3x2 grid of 100 m cells. */
function grid(overrides: Partial<BathymetryGrid> = {}): BathymetryGrid {
  return {
    // [lon, lat, depth], two rows of three
    cells: [
      [54.0, 24.02, 5],
      [54.001, 24.02, 6],
      [54.002, 24.02, 7],
      [54.0, 24.01, 8],
      [54.001, 24.01, 9],
      [54.002, 24.01, 10]
    ],
    cell_size_m: 100,
    min_depth_m: 5,
    max_depth_m: 10,
    ...overrides
  };
}

describe('seabed raster', () => {
  it('produces an image the size of the grid', () => {
    const image = buildBathymetryImage(grid());
    expect(image).not.toBeNull();
    expect(image!.width).toBe(3);
    expect(image!.height).toBe(2);
  });

  it('extends the image half a cell beyond the outermost cell centres', () => {
    // Cell coordinates are centres. Without the half-cell extension the raster
    // sits offset against every vector layer drawn over it.
    const image = buildBathymetryImage(grid())!;
    const [[west, north], , [east, south]] = image.coordinates;
    const halfLon = 0.001 / 2;
    const halfLat = 0.01 / 2;

    expect(west).toBeCloseTo(54.0 - halfLon, 9);
    expect(east).toBeCloseTo(54.002 + halfLon, 9);
    expect(north).toBeCloseTo(24.02 + halfLat, 9);
    expect(south).toBeCloseTo(24.01 - halfLat, 9);
  });

  it('orders rows north to south, as an image is drawn', () => {
    const image = buildBathymetryImage(grid())!;
    const [[, north], , [, south]] = image.coordinates;
    expect(north).toBeGreaterThan(south);
  });

  it('leaves cells the survey does not cover transparent', () => {
    // A gap painted as zero depth would read as a shoal - the one mistake that
    // matters on a depth display.
    const sparse = grid();
    sparse.cells = sparse.cells.filter((_, i) => i !== 4); // drop one interior cell
    buildBathymetryImage(sparse);

    expect(lastImageData).not.toBeNull();
    const alphas: number[] = [];
    for (let i = 3; i < lastImageData!.data.length; i += 4) alphas.push(lastImageData!.data[i]);
    expect(alphas).toContain(0);
    expect(alphas.filter((a) => a === 0)).toHaveLength(1);
  });

  it('spans the full colour ramp across the surveyed depth range', () => {
    // The shallowest and deepest cells must not come out the same colour: a
    // ramp fixed to 0-30 m left a 5-10 m harbour almost uniformly pale.
    buildBathymetryImage(grid());
    const data = lastImageData!.data;
    const shallowest = [data[0], data[1], data[2]];
    const last = (3 * 2 - 1) * 4;
    const deepest = [data[last], data[last + 1], data[last + 2]];
    expect(shallowest).not.toEqual(deepest);
  });

  it('declines a grid it cannot rasterise', () => {
    expect(buildBathymetryImage(undefined)).toBeNull();
    expect(buildBathymetryImage(grid({ cells: [] }))).toBeNull();
    // A single row has no second axis to build an image from.
    expect(buildBathymetryImage(grid({ cells: [[54.0, 24.0, 5]] }))).toBeNull();
  });
});
