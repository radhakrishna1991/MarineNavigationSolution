/**
 * Fleet chart on Google's basemap.
 *
 * The Google counterpart of {@link FleetMap}, and deliberately the same display:
 * the same charted context at the same coarser grid, vessels coloured by the
 * same requirement status, the same click-to-select behaviour and the same
 * legend. An operator switching tabs is looking at one fleet on two grounds,
 * not at two different summaries of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBathymetryQuery, useGeoBundleQuery } from '../api/api';
import { buildBathymetryImage } from './bathymetryRaster';
import { themeHex } from '../theme/theme';
import { useResolvedTheme } from '../theme/useTheme';
import type { FleetVessel } from '../types';
import { darkBasemapStyles, describeFailure, GoogleMapsUnavailable, useGoogleMaps } from './GoogleMapsFrame';
import { markerSpec, overlaysFromGeoJson, syncMarkers, type MarkerSpec } from './googleOverlays';

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

export function GoogleFleetMap({
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
  const mapRef = useRef<google.maps.Map | null>(null);
  const groups = useRef<Record<string, google.maps.MapOverlay[]>>({});
  const [ready, setReady] = useState(false);
  /** A fault inside the Google API, reported instead of thrown. */
  const [failure, setFailure] = useState<string | null>(null);
  const framed = useRef(false);
  const theme = useResolvedTheme();

  const { maps, status, error } = useGoogleMaps();
  const { data: bundle } = useGeoBundleQuery();
  // A coarser grid than the single-vessel chart, for the same reason: at fleet
  // scale the fine structure is not readable.
  const { data: bathymetry } = useBathymetryQuery(14);

  // `onSelect` identity changes with the parent's render; reading it through a
  // ref keeps the vessel markers from being rebuilt for that alone.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  /**
   * Which vessel occupies each marker slot.
   *
   * Markers are reused across updates rather than rebuilt, so a click listener
   * cannot close over the vessel it was created for - the slot may be holding a
   * different vessel by the time anyone clicks it. It reads the owner out of
   * here instead.
   */
  const owners = useRef<string[]>([]);
  const markerKeys = useRef<string[]>([]);

  /**
   * Vessel markers carry click listeners and are rebuilt on every fleet update,
   * so a detached overlay must also be dropped from Google's listener registry
   * or it is never collected.
   */
  const setGroup = useCallback((name: string, items: google.maps.MapOverlay[]) => {
    for (const previous of groups.current[name] ?? []) {
      previous.setMap(null);
      window.google?.maps.event.clearInstanceListeners(previous);
    }
    groups.current[name] = items;
    for (const item of items) item.setMap(mapRef.current);
  }, []);

  // --- Map creation ---------------------------------------------------------
  useEffect(() => {
    if (!maps || !container.current || mapRef.current) return undefined;

    let map: google.maps.Map;
    try {
      map = new maps.Map(container.current, {
        center: { lat: 24.51, lng: 54.35 },
        zoom: 11,
        mapTypeId: 'hybrid',
        mapTypeControl: true,
        mapTypeControlOptions: { position: maps.ControlPosition.TOP_LEFT },
        zoomControl: true,
        zoomControlOptions: { position: maps.ControlPosition.TOP_RIGHT },
        scaleControl: true,
        streetViewControl: false,
        fullscreenControl: false,
        rotateControl: false,
        tilt: 0,
        clickableIcons: false,
        backgroundColor: themeHex('map-backdrop'),
        styles: theme === 'dark' ? darkBasemapStyles() : undefined
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

  // --- Static context: seabed, land, channel and the operating area ---------
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !ready || !bundle) return;

    const seabed = buildBathymetryImage(bathymetry);
    setGroup(
      'seabed',
      seabed
        ? (() => {
            const [[west, north], , [east, south]] = seabed.coordinates;
            return [
              new maps.GroundOverlay(
                seabed.url,
                { north, south, east, west },
                { opacity: 0.6, clickable: false }
              )
            ];
          })()
        : []
    );

    const layerOf = (key: string): GeoJSON.FeatureCollection =>
      (bundle.layers?.[key] ?? EMPTY_FC) as GeoJSON.FeatureCollection;

    setGroup(
      'land',
      overlaysFromGeoJson(maps, layerOf('LAND'), {
        strokeColor: themeHex('map-land-edge'),
        strokeWeight: 1.2,
        fillColor: themeHex('map-land'),
        fillOpacity: 0.35,
        zIndex: 1
      })
    );

    setGroup(
      'contours',
      overlaysFromGeoJson(maps, layerOf('CONTOURS'), {
        strokeColor: themeHex('map-land-edge'),
        strokeWeight: 0.6,
        strokeOpacity: 0.3,
        zIndex: 2
      })
    );

    setGroup(
      'channel',
      overlaysFromGeoJson(maps, layerOf('CHANNEL'), {
        strokeColor: themeHex('info'),
        strokeWeight: 1.2,
        strokeOpacity: 0.5,
        dashed: true,
        dashRepeat: '11px',
        zIndex: 3
      })
    );

    setGroup(
      'operating-area',
      overlaysFromGeoJson(maps, layerOf('OPERATING_AREA'), {
        strokeColor: themeHex('assured'),
        strokeWeight: 1.4,
        strokeOpacity: 0.55,
        dashed: true,
        dashRepeat: '10px',
        zIndex: 3
      })
    );
  }, [maps, ready, bundle, bathymetry, theme, setGroup]);

  // --- Vessels --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !ready) return;

    const placed = vessels.filter((v) => v.position);
    const specs: MarkerSpec[] = [];
    const slotOwners: string[] = [];

    for (const vessel of placed) {
      const colour = themeHex(statusToken(vessel));
      const selected = vessel.vessel_id === selectedId;
      const position = { lat: vessel.position!.latitude, lng: vessel.position!.longitude };

      // A wider ring marks the selection without changing the colour, which
      // still has to carry the status.
      specs.push(
        markerSpec({
          position,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: selected ? 20 : 14,
            fillColor: colour,
            fillOpacity: 0.16,
            strokeColor: colour,
            strokeWeight: selected ? 2 : 1,
            strokeOpacity: 0.7
          },
          title: vessel.name,
          zIndex: 10,
          cursor: 'pointer'
        }),
        markerSpec({
          position,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 6.5,
            fillColor: colour,
            fillOpacity: 1,
            strokeColor: themeHex('map-halo'),
            strokeWeight: 2
          },
          title: vessel.name,
          zIndex: 11,
          cursor: 'pointer'
        })
      );
      slotOwners.push(vessel.vessel_id, vessel.vessel_id);
    }

    // Reconciled rather than rebuilt: a fleet redrawn on every update makes
    // every vessel on the chart flicker.
    owners.current = slotOwners;
    const pool = (groups.current.vessels ?? []) as google.maps.Marker[];
    syncMarkers(maps, pool, markerKeys.current, specs, map, (marker, index) => {
      marker.addListener('click', () => {
        const id = owners.current[index];
        if (id) selectRef.current?.(id);
      });
    });
    groups.current.vessels = pool;

    // Frame once, and only when the surveyed extent is known. Framing on the
    // vessels alone zooms into wherever the fleet happens to be and hides the
    // operating area it is working in.
    const seabed = buildBathymetryImage(bathymetry);
    if (!framed.current && placed.length > 0 && seabed) {
      const [[west, north], , [east, south]] = seabed.coordinates;
      const bounds = new maps.LatLngBounds();
      bounds.extend({ lat: north, lng: west });
      bounds.extend({ lat: south, lng: east });
      for (const vessel of placed) {
        bounds.extend({ lat: vessel.position!.latitude, lng: vessel.position!.longitude });
      }
      map.fitBounds(bounds, 34);
      framed.current = true;
    }
  }, [maps, ready, vessels, selectedId, bathymetry, theme, setGroup]);

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
    <div className={`relative overflow-hidden ${className}`}>
      <div ref={container} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-10 right-3 z-10 rounded border border-bridge-700 bg-bridge-950/85 px-2.5 py-1.5 text-2xs backdrop-blur">
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
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: themeHex(token) }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

export default GoogleFleetMap;
