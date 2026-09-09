/**
 * Interactive navigation chart, drawn on Google's basemap.
 *
 * This is the same picture as {@link MapView} - the same layers, the same
 * legend, the same layer toggles, the same follow-the-vessel behaviour and the
 * same per-source colours - over real satellite imagery instead of the
 * platform's own synthetic chart. It exists so a demonstration can put the
 * trusted position on ground an audience recognises; the platform's own chart
 * remains the primary view, because it is the one that works with no external
 * service at all.
 *
 * Nothing here feeds any estimator. Google supplies pixels underneath the
 * picture and nothing else: every position, bound and track drawn on top comes
 * from the platform, exactly as it does on the primary chart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { followVesselToggled, mapLayerToggled, type MapLayerVisibility } from '../store/uiSlice';
import { useBathymetryQuery, useGeoBundleQuery } from '../api/api';
import { sourceColours, SOURCE_LABELS, type SourceKey } from '../utils/status';
import { themeHex } from '../theme/theme';
import { buildBathymetryImage } from './bathymetryRaster';
import { circlePolygon, ellipsePolygon } from './geometry';
import { useResolvedTheme } from '../theme/useTheme';
import { latitudeDm, longitudeDm, metres, EM_DASH } from '../utils/format';
import type { NavigationOutput } from '../types';
import { Toggle } from '../components/ui';
import { darkBasemapStyles, describeFailure, GoogleMapsUnavailable, useGoogleMaps } from './GoogleMapsFrame';
import {
  dashedStroke,
  featureInfoHtml,
  markerSpec,
  overlaysFromGeoJson,
  ringOf,
  syncMarkers,
  syncPaths,
  toPath,
  type MarkerSpec,
  type PathSpec
} from './googleOverlays';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Hull silhouette: pointed bow, parallel sides, square transom - the same shape
 * the primary chart rasterises, so the vessel reads identically on both.
 */
const HULL_PATH = 'M 0,-26 C 7,-18 10,-6 10,6 L 10,20 L -10,20 L -10,6 C -10,-6 -7,-18 0,-26 Z';

/**
 * Which toggle governs each overlay group.
 *
 * Trails are nested: a track is drawn only when trails are on *and* its source
 * is on, which is what the primary chart does.
 */
function groupVisible(name: string, layers: MapLayerVisibility): boolean {
  switch (name) {
    case 'bathymetry':
    case 'survey-extent':
      return layers.bathymetry;
    case 'contours':
      return layers.contours;
    case 'land':
      return layers.land;
    case 'operating-area':
      return layers.operatingArea;
    case 'no-go':
      return layers.noGo;
    case 'channel':
      return layers.channel;
    case 'route':
      return layers.route;
    case 'radar-features':
      return layers.radarFeatures;
    case 'control-points':
      return layers.controlPoints;
    case 'trail-fused':
    case 'trail-dr':
      return layers.trails;
    case 'trail-truth':
      return layers.trails && layers.groundTruth;
    case 'trail-gnss':
      return layers.trails && layers.gnssPosition;
    case 'protection':
      return layers.protectionCircle;
    case 'ellipse':
      return layers.confidenceEllipse;
    case 'sensor-positions':
    case 'bathy-candidates':
      return layers.sensorPositions;
    case 'ais':
      return layers.aisContacts;
    default:
      // The vessel itself is never hidden - it is the subject of the display.
      return true;
  }
}

export function GoogleMapView({
  navigation,
  className = '',
  showControls = true
}: {
  navigation: NavigationOutput | null;
  className?: string;
  showControls?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  /** Every overlay currently on the map, keyed by the group it belongs to. */
  const groups = useRef<Record<string, google.maps.MapOverlay[]>>({});
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  /** A fault inside the Google API, reported instead of thrown. */
  const [failure, setFailure] = useState<string | null>(null);
  // Framed once, on the first load, for the same reason as the primary chart:
  // re-framing would yank the view back while an operator was looking at it.
  const fitted = useRef(false);

  const dispatch = useAppDispatch();
  const theme = useResolvedTheme();
  const layers = useAppSelector((s) => s.ui.mapLayers);
  const follow = useAppSelector((s) => s.ui.mapFollowVessel);
  const trails = useAppSelector((s) => s.live.trails);

  const { maps, status, error } = useGoogleMaps();
  const { data: bundle } = useGeoBundleQuery();
  const { data: bathymetry } = useBathymetryQuery(8);

  // Read inside callbacks that must not re-run when a toggle changes.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const followRef = useRef(follow);
  followRef.current = follow;

  /** What occupies each slot of a reconciled group; see `syncMarkers`. */
  const poolKeys = useRef<Record<string, string[]>>({});

  /** Where a group belongs right now: the map, or nowhere if it is toggled off. */
  const targetFor = useCallback(
    (name: string) => (groupVisible(name, layersRef.current) ? mapRef.current : null),
    []
  );

  /**
   * Replace a group outright, discarding whatever it held.
   *
   * Used for the charted context, which changes only when the bundle or the
   * palette does. Detaching alone is not enough: Google keeps its own registry
   * of listeners, and an overlay left in it is never collected.
   */
  const setGroup = useCallback(
    (name: string, items: google.maps.MapOverlay[]) => {
      for (const previous of groups.current[name] ?? []) {
        previous.setMap(null);
        window.google?.maps.event.clearInstanceListeners(previous);
      }
      groups.current[name] = items;
      delete poolKeys.current[name];
      const map = targetFor(name);
      for (const item of items) item.setMap(map);
    },
    [targetFor]
  );

  /**
   * Update a marker group in place.
   *
   * The vessel and the per-sensor fixes move several times a second. Rebuilding
   * their markers each time removes and redraws them, which reads as a marker
   * shaking rather than one moving, so they are moved instead.
   */
  const syncMarkerGroup = useCallback(
    (name: string, api: typeof google.maps, specs: MarkerSpec[]) => {
      const pool = (groups.current[name] ?? []) as google.maps.Marker[];
      const keys = poolKeys.current[name] ?? [];
      syncMarkers(api, pool, keys, specs, targetFor(name));
      groups.current[name] = pool;
      poolKeys.current[name] = keys;
    },
    [targetFor]
  );

  /** The same, for the trails and the uncertainty rings. */
  const syncPathGroup = useCallback(
    (name: string, api: typeof google.maps, specs: PathSpec[]) => {
      const pool = groups.current[name] ?? [];
      const keys = poolKeys.current[name] ?? [];
      syncPaths(api, pool, keys, specs, targetFor(name));
      groups.current[name] = pool;
      poolKeys.current[name] = keys;
    },
    [targetFor]
  );

  // --- Map creation --------------------------------------------------------
  useEffect(() => {
    if (!maps || !container.current || mapRef.current) return undefined;

    let map: google.maps.Map;
    try {
      map = new maps.Map(container.current, {
        center: { lat: 24.51, lng: 54.35 },
        zoom: 12,
        minZoom: 3,
        maxZoom: 21,
        // Imagery is the reason to be on this basemap at all.
        mapTypeId: 'hybrid',
        mapTypeControl: true,
        mapTypeControlOptions: { position: maps.ControlPosition.TOP_LEFT },
        zoomControl: true,
        // Matches where the primary chart puts its zoom control.
        zoomControlOptions: { position: maps.ControlPosition.TOP_RIGHT },
        scaleControl: true,
        streetViewControl: false,
        fullscreenControl: false,
        rotateControl: false,
        tilt: 0,
        // Points of interest are clickable by default and open Google's own
        // popups over the chart, which is noise on a navigation display.
        clickableIcons: false,
        backgroundColor: themeHex('map-backdrop'),
        styles: theme === 'dark' ? darkBasemapStyles() : undefined
      });
      infoRef.current = new maps.InfoWindow({ maxWidth: 280 });

      map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) setCursor({ lat: e.latLng.lat(), lon: e.latLng.lng() });
      });
      map.addListener('mouseout', () => setCursor(null));
      // Dragging means the operator wants to look somewhere specific, so
      // auto-follow is released rather than fighting them for control.
      map.addListener('dragstart', () => {
        if (followRef.current) dispatch(followVesselToggled());
      });
    } catch (cause) {
      setFailure(describeFailure(cause));
      return undefined;
    }

    mapRef.current = map;
    setReady(true);

    return () => {
      for (const items of Object.values(groups.current)) {
        for (const item of items) {
          item.setMap(null);
          maps.event.clearInstanceListeners(item);
        }
      }
      groups.current = {};
      infoRef.current?.close();
      infoRef.current = null;
      maps.event.clearInstanceListeners(map);
      mapRef.current = null;
      setReady(false);
    };
    // Created once, as soon as the API is available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maps]);

  // The palette can change under a live map; the basemap has to follow it.
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    mapRef.current.setOptions({
      backgroundColor: themeHex('map-backdrop'),
      styles: theme === 'dark' ? darkBasemapStyles() : []
    });
  }, [ready, theme]);

  const showFeature = useCallback(
    (properties: Record<string, unknown>, latLng: google.maps.LatLng | null) => {
      const map = mapRef.current;
      const info = infoRef.current;
      if (!map || !info || !latLng) return;
      info.setContent(featureInfoHtml(properties, themeHex('bridge-500')));
      info.setPosition(latLng);
      info.open({ map });
    },
    []
  );

  // --- Static layers -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !ready || !bundle) return;

    // Seabed, as one shaded image rather than a polygon per cell.
    const seabed = buildBathymetryImage(bathymetry);
    if (seabed) {
      const [[west, north], , [east, south]] = seabed.coordinates;
      const bounds = { north, south, east, west };
      setGroup('bathymetry', [
        new maps.GroundOverlay(seabed.url, bounds, { opacity: 0.72, clickable: false })
      ]);
      setGroup(
        'survey-extent',
        overlaysFromGeoJson(
          maps,
          {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [west, north],
                    [east, north],
                    [east, south],
                    [west, south],
                    [west, north]
                  ]
                }
              }
            ]
          },
          { strokeColor: themeHex('map-land-edge'), strokeWeight: 1, strokeOpacity: 0.5, dashed: true, dashRepeat: '9px' }
        )
      );

      // Frame the survey area once the extent is known.
      if (!fitted.current) {
        map.fitBounds(bounds, 28);
        fitted.current = true;
      }
    }

    const layerOf = (key: string): GeoJSON.FeatureCollection =>
      (bundle.layers[key] ?? EMPTY_FC) as GeoJSON.FeatureCollection;

    setGroup(
      'contours',
      overlaysFromGeoJson(maps, layerOf('CONTOURS'), {
        strokeColor: themeHex('map-land-edge'),
        strokeWeight: 0.8,
        strokeOpacity: 0.45,
        zIndex: 2
      })
    );

    setGroup(
      'channel',
      overlaysFromGeoJson(maps, layerOf('CHANNEL'), {
        strokeColor: themeHex('assured-light'),
        strokeWeight: 2,
        strokeOpacity: 0.6,
        fillColor: themeHex('unknown'),
        fillOpacity: 0.08,
        zIndex: 3
      })
    );

    setGroup(
      'operating-area',
      overlaysFromGeoJson(maps, layerOf('OPERATING_AREA'), {
        strokeColor: themeHex('assured'),
        strokeWeight: 1.6,
        strokeOpacity: 0.75,
        dashed: true,
        dashRepeat: '12px',
        zIndex: 4
      })
    );

    setGroup(
      'no-go',
      overlaysFromGeoJson(
        maps,
        layerOf('NO_GO'),
        {
          strokeColor: themeHex('critical'),
          strokeWeight: 1.2,
          strokeOpacity: 0.8,
          fillColor: themeHex('critical'),
          fillOpacity: 0.16,
          zIndex: 4
        },
        showFeature
      )
    );

    setGroup(
      'land',
      overlaysFromGeoJson(maps, layerOf('LAND'), {
        strokeColor: themeHex('map-land-edge'),
        strokeWeight: 1.4,
        strokeOpacity: 0.9,
        fillColor: themeHex('map-land'),
        // Translucent: hiding the imagery underneath would defeat the point of
        // being on this basemap, but the charted coastline still has to be
        // visible against it.
        fillOpacity: 0.35,
        zIndex: 1
      })
    );

    setGroup(
      'route',
      overlaysFromGeoJson(
        maps,
        layerOf('ROUTE'),
        {
          strokeColor: themeHex('unknown'),
          strokeWeight: 1.6,
          strokeOpacity: 0.6,
          dashed: true,
          dashRepeat: '14px',
          point: {
            radius: 3.5,
            fillColor: themeHex('map-halo'),
            fillOpacity: 1,
            strokeColor: themeHex('unknown'),
            strokeWeight: 1.2
          },
          zIndex: 5
        },
        showFeature
      )
    );

    setGroup(
      'radar-features',
      overlaysFromGeoJson(
        maps,
        layerOf('RADAR_FEATURES'),
        {
          point: {
            radius: 4,
            fillColor: themeHex('info'),
            fillOpacity: 0.75,
            strokeColor: themeHex('map-halo'),
            strokeWeight: 1
          },
          zIndex: 5
        },
        showFeature
      )
    );

    setGroup(
      'control-points',
      overlaysFromGeoJson(
        maps,
        layerOf('CONTROL_POINTS'),
        {
          point: {
            radius: 4,
            fillColor: themeHex('source-local-ranging'),
            fillOpacity: 0.9,
            strokeColor: themeHex('map-halo'),
            strokeWeight: 1
          },
          zIndex: 5
        },
        showFeature
      )
    );
  }, [maps, ready, bundle, bathymetry, theme, setGroup, showFeature]);

  // --- Dynamic layers ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !ready) return;

    const colours = sourceColours();

    // Every group below is reconciled rather than rebuilt: these change several
    // times a second, and replacing the overlays each time makes them shake.

    // --- Trails ------------------------------------------------------------
    const trailSpecs: Array<[string, keyof typeof trails, string, number, boolean]> = [
      ['trail-truth', 'truth', colours.truth, 2, true],
      ['trail-gnss', 'gnss', colours.gnss, 1.6, true],
      ['trail-dr', 'deadReckoning', colours.deadReckoning, 1.4, true],
      ['trail-fused', 'fused', colours.fused, 2.6, false]
    ];
    for (const [name, key, colour, weight, dashed] of trailSpecs) {
      const points = trails[key];
      syncPathGroup(
        name,
        maps,
        points.length > 1
          ? [
              {
                kind: 'line',
                options: {
                  path: toPath(points.map((p) => [p.lon, p.lat])),
                  strokeColor: colour,
                  strokeWeight: weight,
                  strokeOpacity: dashed ? 0 : 0.85,
                  icons: dashed ? dashedStroke(colour, 0.85, weight, '9px') : undefined,
                  zIndex: 10,
                  clickable: false
                }
              }
            ]
          : []
      );
    }

    // --- Uncertainty geometry ----------------------------------------------
    const pos = navigation?.trusted_position;
    const integrity = navigation?.integrity;

    const protection: PathSpec[] = [];
    if (pos && integrity?.horizontal_protection_level_m) {
      protection.push(
        {
          kind: 'polygon',
          options: {
            paths: [ringOf(circlePolygon(pos.latitude, pos.longitude, integrity.horizontal_protection_level_m))],
            strokeColor: themeHex('caution'),
            strokeWeight: 1.5,
            strokeOpacity: 1,
            fillColor: themeHex('caution'),
            fillOpacity: 0.1,
            zIndex: 11,
            clickable: false
          }
        },
        // Dashed, so drawn as its own line: Google has no dashed polygon.
        {
          kind: 'line',
          options: {
            path: ringOf(circlePolygon(pos.latitude, pos.longitude, integrity.requirement_limit_m)),
            strokeColor: themeHex('assured'),
            strokeWeight: 1.2,
            strokeOpacity: 0,
            icons: dashedStroke(themeHex('assured'), 0.9, 1.2, '8px'),
            zIndex: 11,
            clickable: false
          }
        }
      );
    }
    syncPathGroup('protection', maps, protection);

    const ellipse = integrity?.confidence_ellipse;
    syncPathGroup(
      'ellipse',
      maps,
      pos && ellipse?.semi_major_m
        ? [
            {
              kind: 'line',
              options: {
                path: ringOf(
                  ellipsePolygon(
                    pos.latitude,
                    pos.longitude,
                    ellipse.semi_major_m,
                    ellipse.semi_minor_m ?? ellipse.semi_major_m,
                    ellipse.orientation_deg
                  )
                ),
                strokeColor: themeHex('info'),
                strokeWeight: 1.4,
                strokeOpacity: 0,
                icons: dashedStroke(themeHex('info'), 1, 1.4, '8px'),
                zIndex: 12,
                clickable: false
              }
            }
          ]
        : []
    );

    // --- Per-source position markers ---------------------------------------
    const sensors: MarkerSpec[] = [];
    const addMarker = (key: SourceKey, lat: number | null | undefined, lon: number | null | undefined) => {
      if (lat === null || lat === undefined || lon === null || lon === undefined) return;
      sensors.push(
        markerSpec({
          position: { lat, lng: lon },
          title: SOURCE_LABELS[key],
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: colours[key],
            fillOpacity: 0.5,
            strokeColor: colours[key],
            strokeWeight: 1.6
          },
          zIndex: 13,
          clickable: false
        })
      );
    };

    addMarker('truth', navigation?.ground_truth?.latitude, navigation?.ground_truth?.longitude);
    addMarker('gnss', navigation?.gnss?.reported_position?.latitude, navigation?.gnss?.reported_position?.longitude);
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
    syncMarkerGroup('sensor-positions', maps, sensors);

    // Bathymetric ambiguity candidates: the honest way to show "the seabed here
    // is consistent with several positions".
    const candidates = bathy?.top_candidates ?? [];
    const candidateSpecs: MarkerSpec[] = [];
    if (candidates.length > 1 && bathy?.latitude && bathy?.longitude && (bathy.ambiguity_score ?? 0) > 0.4) {
      for (const candidate of candidates.slice(1, 10)) {
        // Candidates are offsets in metres from the best fix.
        const dLat = (candidate.offset_north_m - (candidates[0]?.offset_north_m ?? 0)) / 111320;
        const dLon =
          (candidate.offset_east_m - (candidates[0]?.offset_east_m ?? 0)) /
          (111320 * Math.cos((bathy.latitude * Math.PI) / 180));
        candidateSpecs.push(
          markerSpec({
            position: { lat: bathy.latitude + dLat, lng: bathy.longitude + dLon },
            icon: {
              path: maps.SymbolPath.CIRCLE,
              scale: 4,
              fillColor: themeHex('source-bathymetric'),
              fillOpacity: 0.25,
              strokeColor: themeHex('source-bathymetric'),
              strokeWeight: 1
            },
            zIndex: 12,
            clickable: false
          })
        );
      }
    }
    syncMarkerGroup('bathy-candidates', maps, candidateSpecs);

    // AIS contacts (advisory only, never fused).
    syncMarkerGroup(
      'ais',
      maps,
      (navigation?.ais_contacts ?? []).map((contact) =>
        markerSpec({
          position: { lat: contact.latitude, lng: contact.longitude },
          title: `${contact.name ?? 'AIS contact'} · ${contact.mmsi ?? EM_DASH}`,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 4,
            fillColor: themeHex('unknown'),
            fillOpacity: 0.35,
            strokeColor: themeHex('unknown'),
            strokeWeight: 1
          },
          zIndex: 12
        })
      )
    );

    // --- The vessel ---------------------------------------------------------
    syncMarkerGroup(
      'vessel',
      maps,
      pos
        ? [
            markerSpec({
              position: { lat: pos.latitude, lng: pos.longitude },
              icon: {
                path: maps.SymbolPath.CIRCLE,
                scale: 15,
                fillColor: colours.fused,
                fillOpacity: 0.14,
                strokeColor: colours.fused,
                strokeWeight: 1.5,
                strokeOpacity: 0.55
              },
              zIndex: 20,
              clickable: false
            }),
            markerSpec({
              position: { lat: pos.latitude, lng: pos.longitude },
              title: 'Trusted fused position',
              icon: {
                path: HULL_PATH,
                scale: 0.6,
                rotation: navigation?.heading_deg ?? 0,
                fillColor: colours.fused,
                fillOpacity: 1,
                strokeColor: themeHex('map-halo'),
                strokeWeight: 1.5
              },
              zIndex: 21
            })
          ]
        : []
    );
  }, [maps, ready, navigation, trails, theme, syncMarkerGroup, syncPathGroup]);

  // --- Layer visibility ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const [name, items] of Object.entries(groups.current)) {
      const target = groupVisible(name, layers) ? map : null;
      for (const item of items) item.setMap(target);
    }
  }, [ready, layers]);

  // --- Follow vessel -------------------------------------------------------
  const followedTo = useRef<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const pos = navigation?.trusted_position;
    if (!map || !ready || !follow || !pos) return;

    // The fused position moves a little on every solution, even alongside. Each
    // re-centre restarts Google's pan animation, and a pan restarted several
    // times a second reads as the whole chart - vessel included - vibrating.
    // So the camera only follows movement large enough to be worth following.
    const last = followedTo.current;
    if (last) {
      const north = (pos.latitude - last.lat) * 111320;
      const east = (pos.longitude - last.lon) * 111320 * Math.cos((pos.latitude * Math.PI) / 180);
      if (Math.hypot(north, east) < 2) return;
    }
    followedTo.current = { lat: pos.latitude, lon: pos.longitude };
    map.panTo({ lat: pos.latitude, lng: pos.longitude });
  }, [ready, follow, navigation?.trusted_position?.latitude, navigation?.trusted_position?.longitude]);

  const layerToggles = useMemo<Array<[keyof MapLayerVisibility, string]>>(
    () => [
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
    ],
    []
  );

  if (status !== 'ready' || failure) {
    return (
      <GoogleMapsUnavailable
        status={failure ? 'error' : status}
        error={failure ?? error}
        className={className}
      />
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-lg border border-bridge-700 ${className}`}>
      <div ref={container} className="h-full w-full" />

      {showControls && (
        <>
          {/* Legend. Clear of Google's logo, which must stay visible. */}
          <div className="absolute bottom-10 left-3 z-10 max-w-[13rem] rounded-lg border border-bridge-700 bg-bridge-950/90 p-2.5 text-2xs backdrop-blur">
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
                ] as Array<[SourceKey, string]>
              ).map(([key, label]) => (
                <li key={key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full border"
                    style={{ borderColor: sourceColours()[key], backgroundColor: `${sourceColours()[key]}55` }}
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
          <div className="absolute right-3 top-24 z-10 flex flex-col items-end gap-2">
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

          {/* Cursor readout, clear of Google's scale bar. */}
          <div className="absolute bottom-10 right-3 z-10 rounded-lg border border-bridge-700 bg-bridge-950/90 px-2.5 py-1.5 font-mono text-2xs tabular-nums text-bridge-300 backdrop-blur">
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

export default GoogleMapView;
