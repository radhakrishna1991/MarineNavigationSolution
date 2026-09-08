/**
 * Interactive navigation chart (Section 14).
 *
 * MapLibre GL with a style built entirely from the platform's own synthetic
 * data - no external tile server. That is deliberate: the demonstration must
 * run on an isolated network, and a basemap that silently failed to load would
 * leave an operator looking at position markers floating on grey.
 *
 * Every position source is drawn separately and labelled. The trusted fused
 * position is never conflated with the raw GNSS position, because the whole
 * point of the platform is that those two can disagree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppDispatch, useAppSelector } from '../store';
import { followVesselToggled, mapLayerToggled } from '../store/uiSlice';
import { useBathymetryQuery, useGeoBundleQuery } from '../api/api';
import { SOURCE_COLOURS, SOURCE_LABELS } from '../utils/status';
import { latitudeDm, longitudeDm, metres, EM_DASH } from '../utils/format';
import type { NavigationOutput } from '../types';
import { Toggle } from '../components/ui';

/** Build a circle polygon in geographic coordinates. */
function circlePolygon(lat: number, lon: number, radiusM: number, points = 64): GeoJSON.Polygon {
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
function ellipsePolygon(
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

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Colour ramp for the depth raster, shallow to deep. */
const DEPTH_RAMP: Array<[number, string]> = [
  [0, '#1e3a5f'],
  [4, '#1a4d7a'],
  [8, '#15618f'],
  [12, '#0f6f9e'],
  [16, '#0a7fae'],
  [22, '#0891b2'],
  [30, '#0e7490']
];

export function MapView({
  navigation,
  className = '',
  showControls = true
}: {
  navigation: NavigationOutput | null;
  className?: string;
  showControls?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);

  const dispatch = useAppDispatch();
  const layers = useAppSelector((s) => s.ui.mapLayers);
  const follow = useAppSelector((s) => s.ui.mapFollowVessel);
  const trails = useAppSelector((s) => s.live.trails);

  const { data: bundle } = useGeoBundleQuery();
  const { data: bathymetry } = useBathymetryQuery(14);

  // --- Style ---------------------------------------------------------------
  const style = useMemo<StyleSpecification>(
    () => ({
      version: 8,
      // No external glyph server: labels use no-glyph symbol layers only.
      glyphs: undefined,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#05080f' } }]
    }),
    []
  );

  // --- Map creation --------------------------------------------------------
  useEffect(() => {
    if (!container.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: container.current,
      style,
      center: [54.35, 24.51],
      zoom: 12.2,
      attributionControl: false,
      maxZoom: 19,
      minZoom: 8,
      pitchWithRotate: false,
      dragRotate: false
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'Synthetic demonstration data · not for navigation'
      }),
      'bottom-right'
    );

    map.on('load', () => setReady(true));
    map.on('mousemove', (e) => setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.on('mouseout', () => setCursor(null));
    // Dragging the map means the operator wants to look somewhere specific, so
    // auto-follow is released rather than fighting them for control.
    map.on('dragstart', () => {
      if (follow) dispatch(followVesselToggled());
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Intentionally created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Static layers -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !bundle) return;

    const addSource = (id: string, data: GeoJSON.FeatureCollection) => {
      if (map.getSource(id)) (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
      else map.addSource(id, { type: 'geojson', data });
    };
    const addLayer = (layer: maplibregl.LayerSpecification) => {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    };

    // Depth raster, drawn as small squares.
    if (bathymetry?.cells?.length) {
      const size = bathymetry.cell_size_m;
      const features: GeoJSON.Feature[] = bathymetry.cells.map(([lon, lat, depth]) => {
        const dLat = size / 2 / 111320;
        const dLon = size / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
        return {
          type: 'Feature',
          properties: { depth },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lon - dLon, lat - dLat],
                [lon + dLon, lat - dLat],
                [lon + dLon, lat + dLat],
                [lon - dLon, lat + dLat],
                [lon - dLon, lat - dLat]
              ]
            ]
          }
        };
      });
      addSource('bathymetry', { type: 'FeatureCollection', features });
      addLayer({
        id: 'bathymetry-fill',
        type: 'fill',
        source: 'bathymetry',
        paint: {
          'fill-color': ['interpolate', ['linear'], ['get', 'depth'], ...DEPTH_RAMP.flat()] as never,
          'fill-opacity': 0.85
        }
      });
    }

    addSource('contours', (bundle.layers.CONTOURS ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'contours-line',
      type: 'line',
      source: 'contours',
      paint: { 'line-color': '#3b5178', 'line-width': 0.7, 'line-opacity': 0.7 }
    });

    addSource('channel', (bundle.layers.CHANNEL ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'channel-area',
      type: 'fill',
      source: 'channel',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#8ba1c4', 'fill-opacity': 0.08 }
    });
    addLayer({
      id: 'channel-line',
      type: 'line',
      source: 'channel',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#5eead4', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.6 }
    });

    addSource('operating-area', (bundle.layers.OPERATING_AREA ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'operating-area-line',
      type: 'line',
      source: 'operating-area',
      paint: { 'line-color': '#12b981', 'line-width': 1.6, 'line-dasharray': [4, 3], 'line-opacity': 0.75 }
    });

    addSource('no-go', (bundle.layers.NO_GO ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'no-go-fill',
      type: 'fill',
      source: 'no-go',
      paint: { 'fill-color': '#ef3f5b', 'fill-opacity': 0.16 }
    });
    addLayer({
      id: 'no-go-line',
      type: 'line',
      source: 'no-go',
      paint: { 'line-color': '#ef3f5b', 'line-width': 1.2, 'line-opacity': 0.8 }
    });

    addSource('land', (bundle.layers.LAND ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'land-fill',
      type: 'fill',
      source: 'land',
      paint: { 'fill-color': '#2a3c5e', 'fill-opacity': 0.95 }
    });
    addLayer({
      id: 'land-line',
      type: 'line',
      source: 'land',
      paint: { 'line-color': '#5a739c', 'line-width': 1.1 }
    });

    addSource('route', (bundle.layers.ROUTE ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#8ba1c4', 'line-width': 1.4, 'line-dasharray': [6, 4], 'line-opacity': 0.5 }
    });
    addLayer({
      id: 'route-waypoints',
      type: 'circle',
      source: 'route',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 3,
        'circle-color': '#0a0f1a',
        'circle-stroke-color': '#8ba1c4',
        'circle-stroke-width': 1.2
      }
    });

    addSource('radar-features', (bundle.layers.RADAR_FEATURES ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'radar-features-circle',
      type: 'circle',
      source: 'radar-features',
      paint: {
        'circle-radius': 4,
        'circle-color': '#38bdf8',
        'circle-opacity': 0.75,
        'circle-stroke-color': '#0a0f1a',
        'circle-stroke-width': 1
      }
    });

    addSource('control-points', (bundle.layers.CONTROL_POINTS ?? EMPTY_FC) as GeoJSON.FeatureCollection);
    addLayer({
      id: 'control-points-circle',
      type: 'circle',
      source: 'control-points',
      paint: {
        'circle-radius': 4,
        'circle-color': '#84cc16',
        'circle-opacity': 0.9,
        'circle-stroke-color': '#0a0f1a',
        'circle-stroke-width': 1
      }
    });

    // Click handling for the reference features.
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '280px' });
    const describe = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties ?? {};
      const rows = Object.entries(props)
        .filter(([k]) => !['demonstration_only'].includes(k))
        .map(
          ([k, v]) =>
            `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8ba1c4">${k.replace(/_/g, ' ')}</span><span style="font-family:monospace">${String(v)}</span></div>`
        )
        .join('');
      popup
        .setLngLat(e.lngLat)
        .setHTML(`<div style="padding:10px;font-size:12px;line-height:1.5">${rows}</div>`)
        .addTo(map);
    };
    for (const id of ['radar-features-circle', 'control-points-circle', 'route-waypoints', 'no-go-fill']) {
      map.on('click', id, describe);
      map.on('mouseenter', id, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', id, () => {
        map.getCanvas().style.cursor = '';
      });
    }
  }, [ready, bundle, bathymetry]);

  // --- Dynamic layers ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const upsert = (
      id: string,
      data: GeoJSON.FeatureCollection,
      spec: () => maplibregl.LayerSpecification
    ) => {
      if (map.getSource(id)) (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
      else {
        map.addSource(id, { type: 'geojson', data });
        map.addLayer(spec());
      }
    };

    const trailFc = (points: Array<{ lat: number; lon: number }>): GeoJSON.FeatureCollection =>
      points.length > 1
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) }
              }
            ]
          }
        : EMPTY_FC;

    const trailSpecs: Array<[string, keyof typeof trails, string, number, number[] | undefined]> = [
      ['trail-truth', 'truth', SOURCE_COLOURS.truth, 2, [2, 2]],
      ['trail-gnss', 'gnss', SOURCE_COLOURS.gnss, 1.6, [1, 2]],
      ['trail-dr', 'deadReckoning', SOURCE_COLOURS.deadReckoning, 1.4, [4, 3]],
      ['trail-fused', 'fused', SOURCE_COLOURS.fused, 2.6, undefined]
    ];
    for (const [id, key, colour, width, dash] of trailSpecs) {
      upsert(id, trailFc(trails[key]), () => ({
        id,
        type: 'line',
        source: id,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colour,
          'line-width': width,
          'line-opacity': 0.85,
          ...(dash ? { 'line-dasharray': dash } : {})
        }
      }));
    }

    // --- Uncertainty geometry ---------------------------------------------
    const pos = navigation?.trusted_position;
    const integrity = navigation?.integrity;

    const protectionFc: GeoJSON.FeatureCollection =
      pos && integrity?.horizontal_protection_level_m
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { kind: 'hpl' },
                geometry: circlePolygon(pos.latitude, pos.longitude, integrity.horizontal_protection_level_m)
              },
              {
                type: 'Feature',
                properties: { kind: 'limit' },
                geometry: circlePolygon(pos.latitude, pos.longitude, integrity.requirement_limit_m)
              }
            ]
          }
        : EMPTY_FC;

    upsert('protection', protectionFc, () => ({
      id: 'protection-fill',
      type: 'fill',
      source: 'protection',
      filter: ['==', ['get', 'kind'], 'hpl'],
      paint: { 'fill-color': '#f0b429', 'fill-opacity': 0.1 }
    }));
    if (!map.getLayer('protection-hpl-line')) {
      map.addLayer({
        id: 'protection-hpl-line',
        type: 'line',
        source: 'protection',
        filter: ['==', ['get', 'kind'], 'hpl'],
        paint: { 'line-color': '#f0b429', 'line-width': 1.5 }
      });
    }
    if (!map.getLayer('protection-limit-line')) {
      map.addLayer({
        id: 'protection-limit-line',
        type: 'line',
        source: 'protection',
        filter: ['==', ['get', 'kind'], 'limit'],
        paint: { 'line-color': '#12b981', 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 }
      });
    }

    const ellipseFc: GeoJSON.FeatureCollection =
      pos && integrity?.confidence_ellipse?.semi_major_m
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: ellipsePolygon(
                  pos.latitude,
                  pos.longitude,
                  integrity.confidence_ellipse.semi_major_m,
                  integrity.confidence_ellipse.semi_minor_m ?? integrity.confidence_ellipse.semi_major_m,
                  integrity.confidence_ellipse.orientation_deg
                )
              }
            ]
          }
        : EMPTY_FC;
    upsert('ellipse', ellipseFc, () => ({
      id: 'ellipse-line',
      type: 'line',
      source: 'ellipse',
      paint: { 'line-color': '#38bdf8', 'line-width': 1.4, 'line-dasharray': [3, 2] }
    }));

    // --- Position markers ---------------------------------------------------
    const markerFeatures: GeoJSON.Feature[] = [];
    const addMarker = (
      key: keyof typeof SOURCE_COLOURS,
      lat: number | null | undefined,
      lon: number | null | undefined,
      extra: Record<string, unknown> = {}
    ) => {
      if (lat === null || lat === undefined || lon === null || lon === undefined) return;
      markerFeatures.push({
        type: 'Feature',
        properties: { source: key, label: SOURCE_LABELS[key], colour: SOURCE_COLOURS[key], ...extra },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      });
    };

    addMarker('truth', navigation?.ground_truth?.latitude, navigation?.ground_truth?.longitude);
    addMarker('gnss', navigation?.gnss?.reported_position?.latitude, navigation?.gnss?.reported_position?.longitude, {
      used: navigation?.gnss?.used_in_fusion ?? false
    });
    const radar = navigation?.localization?.radar;
    if (radar?.valid) addMarker('radar', radar.latitude, radar.longitude);
    const lidar = navigation?.localization?.lidar;
    if (lidar?.valid) addMarker('lidar', lidar.latitude, lidar.longitude);
    const bathy = navigation?.localization?.bathymetric;
    if (bathy?.valid) addMarker('bathymetric', bathy.latitude, bathy.longitude);
    const local = navigation?.localization?.local_ranging;
    if (local?.valid) addMarker('localRanging', local.latitude, local.longitude);
    const dr = navigation?.localization?.dead_reckoning;
    if (dr) addMarker('deadReckoning', dr.latitude, dr.longitude);

    upsert('sensor-positions', { type: 'FeatureCollection', features: markerFeatures }, () => ({
      id: 'sensor-positions-circle',
      type: 'circle',
      source: 'sensor-positions',
      paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'colour'] as never,
        'circle-opacity': 0.5,
        'circle-stroke-color': ['get', 'colour'] as never,
        'circle-stroke-width': 1.6
      }
    }));

    // Bathymetric ambiguity candidates: showing them is the honest way to
    // display "the seabed here is consistent with several positions".
    const candidates = bathy?.top_candidates ?? [];
    const candidateFc: GeoJSON.FeatureCollection =
      candidates.length > 1 && bathy?.latitude && bathy?.longitude && (bathy.ambiguity_score ?? 0) > 0.4
        ? {
            type: 'FeatureCollection',
            features: candidates.slice(1, 10).map((c) => {
              // Candidates are offsets in metres from the best fix.
              const dLat = (c.offset_north_m - (candidates[0]?.offset_north_m ?? 0)) / 111320;
              const dLon =
                (c.offset_east_m - (candidates[0]?.offset_east_m ?? 0)) /
                (111320 * Math.cos((bathy.latitude! * Math.PI) / 180));
              return {
                type: 'Feature',
                properties: { weight: c.weight },
                geometry: { type: 'Point', coordinates: [bathy.longitude! + dLon, bathy.latitude! + dLat] }
              };
            })
          }
        : EMPTY_FC;
    upsert('bathy-candidates', candidateFc, () => ({
      id: 'bathy-candidates-circle',
      type: 'circle',
      source: 'bathy-candidates',
      paint: {
        'circle-radius': 4,
        'circle-color': '#22d3ee',
        'circle-opacity': 0.25,
        'circle-stroke-color': '#22d3ee',
        'circle-stroke-width': 1
      }
    }));

    // AIS contacts (advisory only, never fused).
    const aisFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: (navigation?.ais_contacts ?? []).map((c) => ({
        type: 'Feature',
        properties: { name: c.name, mmsi: c.mmsi },
        geometry: { type: 'Point', coordinates: [c.longitude, c.latitude] }
      }))
    };
    upsert('ais', aisFc, () => ({
      id: 'ais-circle',
      type: 'circle',
      source: 'ais',
      paint: {
        'circle-radius': 4,
        'circle-color': '#8ba1c4',
        'circle-opacity': 0.35,
        'circle-stroke-color': '#8ba1c4',
        'circle-stroke-width': 1
      }
    }));

    // --- Vessel ------------------------------------------------------------
    const vesselFc: GeoJSON.FeatureCollection = pos
      ? {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { heading: navigation?.heading_deg ?? 0 },
              geometry: { type: 'Point', coordinates: [pos.longitude, pos.latitude] }
            }
          ]
        }
      : EMPTY_FC;
    upsert('vessel', vesselFc, () => ({
      id: 'vessel-halo',
      type: 'circle',
      source: 'vessel',
      paint: {
        'circle-radius': 11,
        'circle-color': SOURCE_COLOURS.fused,
        'circle-opacity': 0.18,
        'circle-stroke-color': SOURCE_COLOURS.fused,
        'circle-stroke-width': 2
      }
    }));
    if (!map.getLayer('vessel-heading')) {
      map.addLayer({
        id: 'vessel-heading',
        type: 'symbol',
        source: 'vessel',
        layout: {
          'icon-image': 'vessel-arrow',
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-size': 1
        }
      });
    }
  }, [ready, navigation, trails]);

  // --- Vessel icon ---------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.hasImage('vessel-arrow')) return;
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.translate(size / 2, size / 2);
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(8, 11);
    ctx.lineTo(0, 6);
    ctx.lineTo(-8, 11);
    ctx.closePath();
    ctx.fillStyle = SOURCE_COLOURS.fused;
    ctx.fill();
    ctx.strokeStyle = '#05080f';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    map.addImage('vessel-arrow', ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  }, [ready]);

  // --- Layer visibility ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (layerId: string, visible: boolean) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    };
    set('bathymetry-fill', layers.bathymetry);
    set('contours-line', layers.contours);
    set('land-fill', layers.land);
    set('land-line', layers.land);
    set('operating-area-line', layers.operatingArea);
    set('no-go-fill', layers.noGo);
    set('no-go-line', layers.noGo);
    set('channel-area', layers.channel);
    set('channel-line', layers.channel);
    set('radar-features-circle', layers.radarFeatures);
    set('control-points-circle', layers.controlPoints);
    set('route-line', layers.route);
    set('route-waypoints', layers.route);
    set('trail-fused', layers.trails);
    set('trail-truth', layers.trails && layers.groundTruth);
    set('trail-gnss', layers.trails && layers.gnssPosition);
    set('trail-dr', layers.trails);
    set('protection-fill', layers.protectionCircle);
    set('protection-hpl-line', layers.protectionCircle);
    set('protection-limit-line', layers.protectionCircle);
    set('ellipse-line', layers.confidenceEllipse);
    set('sensor-positions-circle', layers.sensorPositions);
    set('bathy-candidates-circle', layers.sensorPositions);
    set('ais-circle', layers.aisContacts);
  }, [ready, layers]);

  // --- Follow vessel -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const pos = navigation?.trusted_position;
    if (!map || !ready || !follow || !pos) return;
    map.easeTo({ center: [pos.longitude, pos.latitude], duration: 400 });
  }, [ready, follow, navigation?.trusted_position?.latitude, navigation?.trusted_position?.longitude]);

  const layerToggles: Array<[keyof typeof layers, string]> = [
    ['bathymetry', 'Bathymetry raster'],
    ['contours', 'Depth contours'],
    ['land', 'Land and structures'],
    ['operatingArea', 'Approved operating area'],
    ['noGo', 'No-go areas'],
    ['channel', 'Channel and spoil ground'],
    ['route', 'Planned route'],
    ['radarFeatures', 'Radar map features'],
    ['controlPoints', 'Survey control points'],
    ['trails', 'Position trails'],
    ['groundTruth', 'Ground truth'],
    ['gnssPosition', 'Raw GNSS position'],
    ['sensorPositions', 'Per-sensor fixes'],
    ['protectionCircle', 'Protection level circle'],
    ['confidenceEllipse', 'Confidence ellipse'],
    ['aisContacts', 'AIS contacts (advisory)']
  ];

  return (
    <div className={`relative overflow-hidden rounded-lg border border-bridge-700 ${className}`}>
      <div ref={container} className="h-full w-full" />

      {/* Demonstration label, permanently visible over the chart. */}
      <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-caution/40 bg-bridge-950/85 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-caution backdrop-blur">
        Demonstration geospatial data — not for navigation
      </div>

      {showControls && (
        <>
          {/* Legend */}
          <div className="absolute bottom-3 left-3 z-10 max-w-[13rem] rounded-lg border border-bridge-700 bg-bridge-950/90 p-2.5 text-2xs backdrop-blur">
            <p className="mb-1.5 font-semibold uppercase tracking-wider text-bridge-300">Position sources</p>
            <ul className="space-y-1">
              {(
                [
                  ['fused', 'Trusted fused'],
                  ['truth', 'Ground truth'],
                  ['gnss', 'Raw GNSS'],
                  ['radar', 'Radar match'],
                  ['bathymetric', 'Bathymetric match'],
                  ['deadReckoning', 'Dead reckoning']
                ] as Array<[keyof typeof SOURCE_COLOURS, string]>
              ).map(([key, label]) => (
                <li key={key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full border"
                    style={{ borderColor: SOURCE_COLOURS[key], backgroundColor: `${SOURCE_COLOURS[key]}55` }}
                  />
                  <span className="text-bridge-300">{label}</span>
                </li>
              ))}
              <li className="flex items-center gap-2 pt-1">
                <span aria-hidden className="h-0 w-2.5 shrink-0 border-t-2 border-caution" />
                <span className="text-bridge-300">Protection level</span>
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-0 w-2.5 shrink-0 border-t-2 border-dashed border-assured" />
                <span className="text-bridge-300">{navigation?.integrity.requirement_limit_m ?? 2} m limit</span>
              </li>
            </ul>
          </div>

          {/* Controls */}
          <div className="absolute right-3 top-16 z-10 flex flex-col items-end gap-2">
            <button
              type="button"
              className={`chip backdrop-blur ${
                follow ? 'border-info/50 bg-info/20 text-info' : 'border-bridge-600 bg-bridge-950/85 text-bridge-300'
              }`}
              onClick={() => dispatch(followVesselToggled())}
            >
              <span aria-hidden>◎</span>
              {follow ? 'Following' : 'Free pan'}
            </button>
            <button
              type="button"
              className="chip border-bridge-600 bg-bridge-950/85 text-bridge-300 backdrop-blur"
              onClick={() => setLayerPanelOpen((v) => !v)}
              aria-expanded={layerPanelOpen}
            >
              <span aria-hidden>▦</span>
              Layers
            </button>
            {layerPanelOpen && (
              <div className="max-h-[24rem] w-60 overflow-y-auto rounded-lg border border-bridge-700 bg-bridge-950/95 p-2 backdrop-blur">
                {layerToggles.map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={layers[key]}
                    onChange={() => dispatch(mapLayerToggled(key))}
                    label={<span className="text-xs">{label}</span>}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Cursor readout */}
          <div className="absolute bottom-3 right-3 z-10 rounded-lg border border-bridge-700 bg-bridge-950/90 px-2.5 py-1.5 font-mono text-2xs tabular-nums text-bridge-300 backdrop-blur">
            {cursor ? (
              <>
                <div>{latitudeDm(cursor.lat)}</div>
                <div>{longitudeDm(cursor.lon)}</div>
              </>
            ) : navigation?.trusted_position ? (
              <>
                <div>{latitudeDm(navigation.trusted_position.latitude)}</div>
                <div>{longitudeDm(navigation.trusted_position.longitude)}</div>
              </>
            ) : (
              <div>{EM_DASH}</div>
            )}
            {navigation?.actual_error_vs_truth_m !== null && navigation?.actual_error_vs_truth_m !== undefined && (
              <div className="mt-1 border-t border-bridge-700 pt-1 text-caution">
                Actual error {metres(navigation.actual_error_vs_truth_m)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default MapView;
