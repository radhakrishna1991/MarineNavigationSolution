/**
 * Fleet chart: every monitored vessel on one view.
 *
 * Shows the same charted context as the single-vessel view - shaded seabed,
 * contours, coastline, channel and operating area - at a coarser grid, because
 * at fleet scale the fine structure is not readable. Without that context the
 * fleet is a scatter of dots on an empty ground, and an operator cannot tell
 * whether a vessel is in the channel or over the bank.
 *
 * Each vessel is coloured by its requirement status, so a fleet in trouble is
 * visible before a single label is read.
 *
 * The camera frames the whole fleet once and then leaves the operator alone.
 * Re-framing on every update would fight anyone trying to look at one corner.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import { useBathymetryQuery, useGeoBundleQuery } from '../api/api';
import { buildBathymetryImage } from './bathymetryRaster';
import { themeHex } from '../theme/theme';
import { useResolvedTheme } from '../theme/useTheme';
import type { FleetVessel } from '../types';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Requirement status decides the colour, so trouble reads before names do. */
function statusToken(vessel: FleetVessel): Parameters<typeof themeHex>[0] {
  if (vessel.integrity_status === 'NOT_ASSURED') return 'critical';
  switch (vessel.requirement_status) {
    case 'REQUIREMENT_MET':
      return 'assured';
    case 'REQUIREMENT_AT_RISK':
      return 'caution';
    case 'REQUIREMENT_NOT_MET':
      return 'critical';
    default:
      return 'unknown';
  }
}

export function FleetMap({
  vessels,
  selectedId,
  onSelect,
  className = ''
}: {
  vessels: FleetVessel[];
  selectedId: string | null;
  onSelect?: (vesselId: string) => void;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const framed = useRef(false);
  const theme = useResolvedTheme();
  const { data: bundle } = useGeoBundleQuery();
  // A coarser grid than the single-vessel chart: at fleet scale the fine
  // structure is not readable, and the seabed here is context rather than the
  // subject.
  const { data: bathymetry } = useBathymetryQuery(14);

  const style = useMemo<StyleSpecification>(
    () => ({
      version: 8,
      sources: {},
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': themeHex('map-backdrop') } }
      ]
    }),
    []
  );

  // --- Map creation ---------------------------------------------------------
  useEffect(() => {
    if (!container.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: container.current,
      style,
      center: [54.35, 24.51],
      zoom: 11.5,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    map.on('load', () => setReady(true));

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Static context: land and the operating area --------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !bundle) return;

    map.setPaintProperty('background', 'background-color', themeHex('map-backdrop'));

    // The same shaded seabed as the single-vessel chart. Without it the fleet
    // view is a scatter of dots on an empty ground, and an operator cannot tell
    // whether a vessel is in the channel or over the bank.
    const seabed = buildBathymetryImage(bathymetry);
    if (seabed) {
      const existing = map.getSource('fleet-seabed') as maplibregl.ImageSource | undefined;
      if (existing) existing.updateImage({ url: seabed.url, coordinates: seabed.coordinates });
      else map.addSource('fleet-seabed', { type: 'image', url: seabed.url, coordinates: seabed.coordinates });
      if (!map.getLayer('fleet-seabed-raster')) {
        map.addLayer(
          {
            id: 'fleet-seabed-raster',
            type: 'raster',
            source: 'fleet-seabed',
            paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 0 }
          },
          map.getLayer('fleet-vessel-halo') ? 'fleet-vessel-halo' : undefined
        );
      }
    }

    // Vessels must stay on top of everything drawn for context.
    const belowVessels = map.getLayer('fleet-vessel-halo') ? 'fleet-vessel-halo' : undefined;

    const upsert = (id: string, data: GeoJSON.FeatureCollection, build: () => maplibregl.LayerSpecification) => {
      const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(data);
      else map.addSource(id, { type: 'geojson', data });
      const layer = build();
      if (!map.getLayer(layer.id)) {
        map.addLayer(layer, belowVessels);
        return;
      }
      const paint = (layer as { paint?: Record<string, unknown> }).paint;
      if (paint) {
        for (const [property, value] of Object.entries(paint)) {
          map.setPaintProperty(layer.id, property, value as never);
        }
      }
    };

    upsert('fleet-land', (bundle.layers?.LAND ?? EMPTY_FC) as GeoJSON.FeatureCollection, () => ({
      id: 'fleet-land-fill',
      type: 'fill',
      source: 'fleet-land',
      paint: { 'fill-color': themeHex('map-land'), 'fill-opacity': 1 }
    }));
    if (!map.getLayer('fleet-land-line')) {
      map.addLayer(
        {
          id: 'fleet-land-line',
          type: 'line',
          source: 'fleet-land',
          paint: { 'line-color': themeHex('map-land-edge'), 'line-width': 1.2 }
        },
        belowVessels
      );
    } else {
      map.setPaintProperty('fleet-land-line', 'line-color', themeHex('map-land-edge'));
    }

    upsert('fleet-contours', (bundle.layers?.CONTOURS ?? EMPTY_FC) as GeoJSON.FeatureCollection, () => ({
      id: 'fleet-contours-line',
      type: 'line',
      source: 'fleet-contours',
      paint: { 'line-color': themeHex('map-land-edge'), 'line-width': 0.6, 'line-opacity': 0.3 }
    }));

    upsert('fleet-channel', (bundle.layers?.CHANNEL ?? EMPTY_FC) as GeoJSON.FeatureCollection, () => ({
      id: 'fleet-channel-line',
      type: 'line',
      source: 'fleet-channel',
      paint: { 'line-color': themeHex('info'), 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.5 }
    }));

    upsert('fleet-area', (bundle.layers?.OPERATING_AREA ?? EMPTY_FC) as GeoJSON.FeatureCollection, () => ({
      id: 'fleet-area-line',
      type: 'line',
      source: 'fleet-area',
      paint: {
        'line-color': themeHex('assured'),
        'line-width': 1.4,
        'line-dasharray': [3, 2],
        'line-opacity': 0.55
      }
    }));
  }, [ready, bundle, bathymetry, theme]);

  // --- Vessels --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const features: GeoJSON.Feature[] = vessels
      .filter((v) => v.position)
      .map((v) => ({
        type: 'Feature',
        properties: {
          vessel_id: v.vessel_id,
          name: v.name,
          colour: themeHex(statusToken(v)),
          heading: v.heading_deg ?? 0,
          selected: v.vessel_id === selectedId ? 1 : 0
        },
        geometry: { type: 'Point', coordinates: [v.position!.longitude, v.position!.latitude] }
      }));

    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    const source = map.getSource('fleet-vessels') as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else map.addSource('fleet-vessels', { type: 'geojson', data });

    if (!map.getLayer('fleet-vessel-halo')) {
      // A wider ring marks the selected vessel without changing its colour,
      // which still has to carry the status.
      map.addLayer({
        id: 'fleet-vessel-halo',
        type: 'circle',
        source: 'fleet-vessels',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 20, 14],
          'circle-color': ['get', 'colour'],
          'circle-opacity': 0.16,
          'circle-stroke-color': ['get', 'colour'],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 2, 1],
          'circle-stroke-opacity': 0.7
        }
      });
      map.addLayer({
        id: 'fleet-vessel-dot',
        type: 'circle',
        source: 'fleet-vessels',
        paint: {
          'circle-radius': 6.5,
          'circle-color': ['get', 'colour'],
          'circle-stroke-color': themeHex('map-halo'),
          'circle-stroke-width': 2
        }
      });

      map.on('click', 'fleet-vessel-halo', (e) => {
        const id = e.features?.[0]?.properties?.vessel_id;
        if (typeof id === 'string') onSelect?.(id);
      });
      map.on('mouseenter', 'fleet-vessel-halo', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'fleet-vessel-halo', () => {
        map.getCanvas().style.cursor = '';
      });
    } else {
      map.setPaintProperty('fleet-vessel-dot', 'circle-stroke-color', themeHex('map-halo'));
    }

    // Frame once, and only when the surveyed extent is known. Framing on the
    // vessels alone - which is all that exists before the depth grid arrives -
    // zooms into wherever the fleet happens to be and hides the operating area
    // it is working in.
    const seabed = buildBathymetryImage(bathymetry);
    if (!framed.current && features.length > 0 && seabed) {
      const lons = features.map((f) => (f.geometry as GeoJSON.Point).coordinates[0]);
      const lats = features.map((f) => (f.geometry as GeoJSON.Point).coordinates[1]);
      const [[west, north], , [east, south]] = seabed.coordinates;
      lons.push(west, east);
      lats.push(north, south);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)]
        ],
        { padding: 34, duration: 0, maxZoom: 15 }
      );
      framed.current = true;
    }
  }, [ready, vessels, selectedId, onSelect, bathymetry, theme]);

  return (
    <div className={`relative overflow-hidden rounded-b-lg ${className}`}>
      <div ref={container} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded border border-bridge-700 bg-bridge-950/85 px-2.5 py-1.5 text-2xs backdrop-blur">
        <p className="mb-1 font-semibold uppercase tracking-wider text-bridge-300">Requirement</p>
        {(
          [
            ['assured', 'Met'],
            ['caution', 'At risk'],
            ['critical', 'Not met / integrity lost'],
            ['unknown', 'Unknown']
          ] as const
        ).map(([token, label]) => (
          <div key={token} className="flex items-center gap-1.5 text-bridge-300">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: themeHex(token) }}
            />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

export default FleetMap;
