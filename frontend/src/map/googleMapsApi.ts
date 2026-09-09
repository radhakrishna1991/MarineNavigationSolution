/**
 * Loading the Google Maps JavaScript API.
 *
 * The Google chart is an *optional* second view of the same navigation picture.
 * The platform's primary chart is drawn entirely from its own data and needs no
 * external service, because the demonstration has to run on an isolated
 * network; this one needs the public internet and a billed API key, so it is
 * loaded lazily - the script is only fetched when an operator actually opens
 * the Google tab, and never during a normal session on the primary chart.
 *
 * Every failure mode is reported rather than swallowed. A chart that silently
 * shows nothing is worse than one that says why: an operator has to be able to
 * tell "the key is missing" from "the network is down" from "this vessel has no
 * position", and only the first two are this module's business.
 */

/**
 * Configured at build time. Empty when the deployment has no Google key.
 *
 * Read on each call rather than captured at import: a module-level constant is
 * fixed the moment this file is first loaded, which leaves the "not configured"
 * path untestable on any machine that happens to have a key in its environment.
 */
export function googleMapsApiKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
}

const SCRIPT_ID = 'google-maps-js-api';

/** The global the API calls once it is genuinely ready. */
const CALLBACK_NAME = '__amnpGoogleMapsReady';

/** One in-flight load, shared by every chart on the screen. */
let loader: Promise<typeof google.maps> | null = null;

/**
 * Is the API actually usable, as opposed to merely present?
 *
 * `window.google.maps` appears *before* the API has finished loading - under
 * `loading=async` the script's `load` event fires while the namespace is still
 * a stub that carries little more than `importLibrary`. Treating that as ready
 * gets as far as constructing the map options and then dies on the first
 * constant it reads, so readiness is asserted against the things actually used
 * rather than against the namespace existing.
 */
function usableApi(): typeof google.maps | null {
  const maps = typeof window !== 'undefined' ? window.google?.maps : undefined;
  if (!maps) return null;
  const required = [
    maps.Map,
    maps.Marker,
    maps.Polyline,
    maps.Polygon,
    maps.GroundOverlay,
    maps.InfoWindow,
    maps.LatLngBounds
  ];
  if (required.some((member) => typeof member !== 'function')) return null;
  if (!maps.ControlPosition || !maps.SymbolPath || !maps.event) return null;
  return maps;
}

/**
 * Fetch the API, or hand back the copy already on the page.
 *
 * Rejects rather than hanging when the key is missing or the script cannot be
 * reached, so the caller can put the reason on screen.
 */
export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps can only be loaded in a browser.'));
  }
  const alreadyLoaded = usableApi();
  if (alreadyLoaded) return Promise.resolve(alreadyLoaded);
  if (loader) return loader;
  const key = googleMapsApiKey();
  if (!key) {
    return Promise.reject(new Error('No Google Maps API key is configured (VITE_GOOGLE_MAPS_API_KEY).'));
  }

  loader = new Promise<typeof google.maps>((resolve, reject) => {
    const holder = window as unknown as Record<string, unknown>;
    const script = (document.getElementById(SCRIPT_ID) as HTMLScriptElement | null) ?? document.createElement('script');

    const cleanUp = () => {
      delete holder[CALLBACK_NAME];
    };
    const fail = (message: string) => {
      // A failed load must not be cached, or a transient network fault would
      // leave the tab permanently broken for the rest of the session.
      loader = null;
      cleanUp();
      script.remove();
      reject(new Error(message));
    };

    // The API invokes this once every default library is in place. Resolving
    // on the script's own `load` event instead is what leaves callers holding
    // a half-built namespace.
    holder[CALLBACK_NAME] = () => {
      cleanUp();
      const maps = usableApi();
      if (maps) resolve(maps);
      else fail('The Google Maps API loaded but is missing members this chart needs.');
    };

    script.addEventListener(
      'error',
      () => fail('The Google Maps script could not be loaded. Check the network and the API key.'),
      { once: true }
    );

    if (!script.isConnected) {
      script.id = SCRIPT_ID;
      script.async = true;
      const params = new URLSearchParams({
        key,
        v: 'weekly',
        // `marker` carries the marker classes; without it they are not
        // guaranteed to be present in the default set.
        libraries: 'marker',
        loading: 'async',
        callback: CALLBACK_NAME
      });
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      document.head.appendChild(script);
    }
  });

  return loader;
}

/** The API as it stands right now, or null if it is not usable yet. */
export function currentGoogleMaps(): typeof google.maps | null {
  return usableApi();
}

export type GoogleMapsStatus = 'missing-key' | 'loading' | 'ready' | 'error';
