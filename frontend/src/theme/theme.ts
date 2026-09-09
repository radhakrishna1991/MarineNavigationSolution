/**
 * Theme resolution and token access.
 *
 * The interface has two palettes, both defined once in `index.css` as custom
 * properties. Anything rendered with CSS classes picks them up automatically.
 * The map and the charts do not: MapLibre paint properties and ECharts options
 * take colour literals, so this module reads the same custom properties back
 * out of the document and hands them over as strings.
 *
 * Reading the live values rather than duplicating a palette here means the two
 * canvases can never drift out of step with the rest of the interface - there
 * is still exactly one definition of each colour.
 */

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** Every token the map and charts are allowed to ask for. */
export type ThemeToken =
  | `bridge-${950 | 900 | 850 | 800 | 750 | 700 | 600 | 500 | 400 | 300 | 200 | 100}`
  | 'assured'
  | 'assured-light'
  | 'assured-dark'
  | 'caution'
  | 'caution-light'
  | 'caution-dark'
  | 'alert'
  | 'alert-light'
  | 'alert-dark'
  | 'critical'
  | 'critical-light'
  | 'critical-dark'
  | 'info'
  | 'info-light'
  | 'info-dark'
  | 'unknown'
  | 'unknown-light'
  | 'unknown-dark'
  | 'map-ground'
  | 'map-backdrop'
  | 'map-land'
  | 'map-land-edge'
  | 'map-graticule'
  | 'map-halo'
  | `map-depth-${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | 'chart-axis'
  | 'chart-text'
  | 'chart-grid'
  | 'chart-tooltip-bg'
  | 'chart-tooltip-border'
  | 'chart-tooltip-text'
  | 'chart-pointer'
  | `chart-series-${'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'}`
  | `source-${SourceToken}`;

/** The positioning sources that own an identity colour. */
export type SourceKey =
  | 'fused'
  | 'truth'
  | 'gnss'
  | 'radar'
  | 'lidar'
  | 'bathymetric'
  | 'deadReckoning'
  | 'localRanging';

type SourceToken =
  | 'fused'
  | 'truth'
  | 'gnss'
  | 'radar'
  | 'lidar'
  | 'bathymetric'
  | 'dead-reckoning'
  | 'local-ranging';

const SOURCE_TOKEN: Record<SourceKey, SourceToken> = {
  fused: 'fused',
  truth: 'truth',
  gnss: 'gnss',
  radar: 'radar',
  lidar: 'lidar',
  bathymetric: 'bathymetric',
  deadReckoning: 'dead-reckoning',
  localRanging: 'local-ranging'
};

/**
 * Dark values, duplicated only as a fallback.
 *
 * `getComputedStyle` returns nothing for a custom property when the stylesheet
 * has not loaded - during the first paint, in a unit test with CSS disabled, or
 * if the stylesheet failed to fetch. A chart with no colours at all is worse
 * than a chart in the wrong theme, so these stand in. They are the dark values
 * because dark is the default theme.
 */
const FALLBACK: Record<string, string> = {
  'bridge-950': '5 8 15',
  'bridge-900': '10 15 26',
  'bridge-850': '14 22 38',
  'bridge-800': '19 29 49',
  'bridge-750': '24 36 60',
  'bridge-700': '30 44 72',
  'bridge-600': '42 60 94',
  'bridge-500': '59 81 120',
  'bridge-400': '106 130 170',
  'bridge-300': '139 161 196',
  'bridge-200': '185 201 224',
  'bridge-100': '221 230 242',
  assured: '18 185 129',
  'assured-light': '94 234 212',
  'assured-dark': '11 127 90',
  caution: '240 180 41',
  'caution-light': '253 230 138',
  'caution-dark': '161 98 7',
  alert: '242 104 60',
  'alert-light': '253 186 154',
  'alert-dark': '180 68 31',
  critical: '239 63 91',
  'critical-light': '253 164 180',
  'critical-dark': '164 18 58',
  info: '56 189 248',
  'info-light': '186 230 253',
  'info-dark': '3 105 161',
  unknown: '139 161 196',
  'unknown-light': '203 213 225',
  'unknown-dark': '71 85 105',
  'map-ground': '5 8 15',
  'map-backdrop': '9 26 45',
  'map-land': '42 60 94',
  'map-land-edge': '90 115 156',
  'map-graticule': '59 81 120',
  'map-halo': '5 8 15',
  'map-depth-0': '30 58 95',
  'map-depth-1': '26 77 122',
  'map-depth-2': '21 97 143',
  'map-depth-3': '15 111 158',
  'map-depth-4': '10 127 174',
  'map-depth-5': '8 145 178',
  'map-depth-6': '14 116 144',
  'chart-axis': '59 81 120',
  'chart-text': '139 161 196',
  'chart-grid': '24 36 60',
  'chart-tooltip-bg': '14 22 38',
  'chart-tooltip-border': '42 60 94',
  'chart-tooltip-text': '221 230 242',
  'chart-pointer': '90 115 156',
  'chart-series-a': '56 189 248',
  'chart-series-b': '18 185 129',
  'chart-series-c': '240 180 41',
  'chart-series-d': '167 139 250',
  'chart-series-e': '34 211 238',
  'chart-series-f': '249 115 22',
  'chart-series-g': '132 204 22',
  'source-fused': '18 185 129',
  'source-truth': '240 180 41',
  'source-gnss': '239 63 91',
  'source-radar': '56 189 248',
  'source-lidar': '167 139 250',
  'source-bathymetric': '34 211 238',
  'source-dead-reckoning': '249 115 22',
  'source-local-ranging': '132 204 22'
};

/** What the operating system is asking for, when the preference is `system`. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/**
 * Put the resolved theme on the document.
 *
 * `data-theme` drives the custom properties, the `dark` class keeps Tailwind's
 * `dark:` variant available for anything that needs it, and `color-scheme`
 * makes native scrollbars, form controls and the browser's own chrome match.
 */
export function applyTheme(resolved: ResolvedTheme, options: { animate?: boolean } = {}) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;

  if (options.animate) {
    root.setAttribute('data-theme-switching', '');
    window.setTimeout(() => root.removeAttribute('data-theme-switching'), 220);
  }

  root.dataset.theme = resolved;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;

  // Keep the browser UI (address bar on mobile, window chrome) in step.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#05080f' : '#eef2f7');
}

/** The raw `R G B` channel triplet for a token. */
function channels(token: ThemeToken): string {
  if (typeof window !== 'undefined' && typeof getComputedStyle === 'function') {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
    if (value) return value;
  }
  return FALLBACK[token] ?? FALLBACK['unknown'];
}

/** A CSS colour string for a token, optionally at partial opacity. */
export function themeColor(token: ThemeToken, alpha = 1): string {
  const rgb = channels(token);
  return alpha >= 1 ? `rgb(${rgb})` : `rgb(${rgb} / ${alpha})`;
}

/**
 * A hex colour for a token.
 *
 * MapLibre accepts `rgb()` strings, but a few of its paint expressions and the
 * offscreen canvas the vessel marker is drawn on are happier with hex.
 */
export function themeHex(token: ThemeToken): string {
  const [r, g, b] = channels(token)
    .split(/[\s,]+/)
    .map((n) => Number.parseInt(n, 10) || 0);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The whole palette as one object.
 *
 * Charts rebuild their options from this on every theme change; taking a
 * snapshot means each option object is internally consistent even if a switch
 * happens mid-render.
 */
/**
 * Identity colour per positioning source, as hex.
 *
 * A colour means the same source everywhere it appears - map track, legend
 * swatch and chart series - so this is the one place the mapping is defined.
 * Hex rather than `rgb()` because several call sites append an alpha suffix
 * (`${colour}55`) for a translucent fill.
 */
export function sourceColours(): Record<SourceKey, string> {
  const out = {} as Record<SourceKey, string>;
  for (const key of Object.keys(SOURCE_TOKEN) as SourceKey[]) {
    out[key] = themeHex(`source-${SOURCE_TOKEN[key]}`);
  }
  return out;
}

export function themeTokens(): Record<ThemeToken, string> {
  const tokens = {} as Record<ThemeToken, string>;
  for (const key of Object.keys(FALLBACK) as ThemeToken[]) {
    tokens[key] = themeColor(key);
  }
  return tokens;
}
