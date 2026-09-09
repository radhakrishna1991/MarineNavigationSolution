/**
 * Shared plumbing for the Google-basemap charts.
 *
 * Both Google charts need the same two things: the API, loaded once and shared,
 * and an honest panel to show when it cannot be had. The second matters as much
 * as the first - this view depends on a public service and a billed key, and an
 * operator switching to it has to be told *why* it is blank rather than being
 * left to guess whether the vessel has stopped reporting.
 */

import { useEffect, useState } from 'react';
import { themeHex } from '../theme/theme';
import { currentGoogleMaps, googleMapsApiKey, loadGoogleMaps, type GoogleMapsStatus } from './googleMapsApi';

/**
 * A dark road basemap, so switching to Google at night does not throw a white
 * screen at a watchkeeper. Ignored by the satellite map types, which are dark
 * enough already, and so only seen by an operator who has chosen "Map".
 */
export function darkBasemapStyles(): google.maps.MapTypeStyle[] {
  return [
    { elementType: 'geometry', stylers: [{ color: themeHex('map-land') }] },
    { elementType: 'labels.text.fill', stylers: [{ color: themeHex('bridge-300') }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: themeHex('bridge-950') }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: themeHex('bridge-800') }] },
    { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: themeHex('map-depth-4') }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: themeHex('bridge-400') }] }
  ];
}

/**
 * Turn anything thrown into something an operator can read.
 *
 * Every call into the Google API is wrapped: this is a third-party service on
 * the far side of the internet, and a fault in an optional second view of the
 * chart must never be allowed to reach the error boundary and take the whole
 * navigation display down with it.
 */
export function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface GoogleMapsState {
  maps: typeof google.maps | null;
  status: GoogleMapsStatus;
  error: string | null;
}

/** Load the API on mount, and report every state the caller has to render. */
export function useGoogleMaps(): GoogleMapsState {
  const [state, setState] = useState<GoogleMapsState>(() => {
    // Another chart on the page may already have loaded it.
    const loaded = currentGoogleMaps();
    return {
      maps: loaded,
      status: loaded ? 'ready' : googleMapsApiKey() ? 'loading' : 'missing-key',
      error: null
    };
  });

  useEffect(() => {
    if (state.status === 'ready' || state.status === 'missing-key') return undefined;
    let cancelled = false;
    loadGoogleMaps()
      .then((maps) => {
        if (!cancelled) setState({ maps, status: 'ready', error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ maps: null, status: 'error', error: cause instanceof Error ? cause.message : String(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  return state;
}

/**
 * What the Google tab shows when there is no map to show.
 *
 * Deliberately styled as a chart-shaped panel rather than a small error line:
 * it occupies the space the chart would have, so nobody mistakes it for a chart
 * that simply has nothing on it.
 */
export function GoogleMapsUnavailable({
  status,
  error,
  className = ''
}: {
  status: GoogleMapsStatus;
  error: string | null;
  className?: string;
}) {
  if (status === 'loading') {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-bridge-700 bg-bridge-900 ${className}`}
      >
        <div className="flex items-center gap-2 text-xs text-bridge-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-bridge-600 border-t-info" aria-hidden />
          Loading the Google basemap…
        </div>
      </div>
    );
  }

  const missingKey = status === 'missing-key';

  return (
    <div
      className={`flex items-center justify-center rounded-lg border border-bridge-700 bg-bridge-900 p-6 ${className}`}
      role="status"
    >
      <div className="max-w-md text-center">
        <p className="text-2xl text-bridge-600" aria-hidden>
          ◍
        </p>
        <p className="mt-2 text-sm font-semibold text-bridge-100">
          {missingKey ? 'The Google basemap is not configured' : 'The Google basemap could not be loaded'}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-bridge-400">
          {missingKey ? (
            <>
              Set <code className="rounded bg-bridge-800 px-1 py-0.5 font-mono">VITE_GOOGLE_MAPS_API_KEY</code> before
              building the dashboard to enable this view.
            </>
          ) : (
            error ?? 'The Google Maps service did not respond.'
          )}
        </p>
        <p className="mt-3 text-2xs leading-relaxed text-bridge-500">
          This view needs the public internet. The platform chart in the first tab is drawn entirely from the
          platform's own data and is unaffected.
        </p>
      </div>
    </div>
  );
}
