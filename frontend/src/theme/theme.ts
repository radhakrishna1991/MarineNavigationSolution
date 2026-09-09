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
 * Light values, duplicated only as a fallback.
 *
 * `getComputedStyle` returns nothing for a custom property when the stylesheet
 * has not loaded - during the first paint, in a unit test with CSS disabled, or
 * if the stylesheet failed to fetch. A chart with no colours at all is worse
 * than a chart in the wrong theme, so these stand in. They are the light values
 * because light is the default theme; they must be kept in step with the
 * `:root` block of `index.css`, which is the definition.
 */
const FALLBACK: Record<string, string> = {
  'bridge-950': '244 246 250',
  'bridge-900': '255 255 255',
  'bridge-850': '248 250 252',
  'bridge-800': '240 244 249',
  'bridge-750': '232 237 244',
  'bridge-700': '224 230 238',
  'bridge-600': '176 190 209',
  'bridge-500': '100 120 143',
  'bridge-400': '84 104 129',
  'bridge-300': '61 80 104',
  'bridge-200': '37 52 74',
  'bridge-100': '13 27 44',
  assured: '4 120 87',
  'assured-light': '6 95 70',
  'assured-dark': '16 185 129',
  caution: '146 89 12',
  'caution-light': '124 72 15',
  'caution-dark': '240 180 41',
  alert: '194 65 12',
  'alert-light': '154 52 18',
  'alert-dark': '242 104 60',
  critical: '190 18 60',
  'critical-light': '159 18 57',
  'critical-dark': '239 63 91',
  info: '3 105 161',
  'info-light': '7 89 133',
  'info-dark': '56 189 248',
  unknown: '71 85 105',
  'unknown-light': '51 65 85',
  'unknown-dark': '148 163 184',
  'map-ground': '233 240 248',
  'map-backdrop': '205 224 240',
  'map-land': '234 224 199',
  'map-land-edge': '150 133 96',
  'map-graticule': '150 175 200',
  'map-halo': '255 255 255',
  'map-depth-0': '198 228 246',
  'map-depth-1': '166 210 240',
  'map-depth-2': '133 190 232',
  'map-depth-3': '100 168 222',
  'map-depth-4': '68 143 206',
  'map-depth-5': '40 115 183',
  'map-depth-6': '20 88 156',
  'chart-axis': '176 190 209',
  'chart-text': '84 104 129',
  'chart-grid': '232 237 244',
  'chart-tooltip-bg': '255 255 255',
  'chart-tooltip-border': '224 230 238',
  'chart-tooltip-text': '13 27 44',
  'chart-pointer': '100 120 143',
  'chart-series-a': '2 132 199',
  'chart-series-b': '4 120 87',
  'chart-series-c': '180 83 9',
  'chart-series-d': '109 40 217',
  'chart-series-e': '14 116 144',
  'chart-series-f': '194 65 12',
  'chart-series-g': '77 124 15',
  'source-fused': '4 120 87',
  'source-truth': '180 83 9',
  'source-gnss': '190 18 60',
  'source-radar': '2 132 199',
  'source-lidar': '109 40 217',
  'source-bathymetric': '14 116 144',
  'source-dead-reckoning': '194 65 12',
  'source-local-ranging': '77 124 15'
};

/**
 * What the operating system is asking for, when the preference is `system`.
 *
 * The query asks about light specifically, so a browser that reports neither
 * gets dark - the historical behaviour of `prefers-color-scheme`. Only the case
 * where the question cannot be asked at all falls back to the app default.
 */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
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
  // Kept in step with the same two values in `index.html`, which applies the
  // theme before this module has loaded.
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#05080f' : '#f4f6fa');
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
