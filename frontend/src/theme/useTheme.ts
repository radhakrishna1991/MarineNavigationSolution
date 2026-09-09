/**
 * React bindings for the theme.
 *
 * The stored preference lives in the UI slice; this turns it into the theme
 * actually in force, keeps the document attribute in step, and follows the
 * operating system while the preference is `system`.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useAppSelector } from '../store';
import { applyTheme, systemTheme, type ResolvedTheme } from './theme';

/** Subscribe to the operating system's colour-scheme preference. */
function subscribeToSystem(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  // Safari below 14 only has the deprecated listener API.
  if (query.addEventListener) {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

/**
 * The theme currently in force.
 *
 * Components that render to a canvas - the map, the charts - depend on this so
 * that a theme change re-runs their colour setup. Everything styled with CSS
 * classes updates on its own and does not need the hook.
 */
export function useResolvedTheme(): ResolvedTheme {
  const preference = useAppSelector((s) => s.ui.theme);
  const osTheme = useSyncExternalStore(subscribeToSystem, systemTheme, () => 'dark' as const);
  return preference === 'system' ? osTheme : preference;
}

/**
 * Keep the document in step with the resolved theme.
 *
 * Mounted once, at the root. The preference is also applied synchronously by
 * the reducer when the operator changes it; this covers the initial mount and
 * the case where the operating system changes underneath a `system` preference.
 */
export function useApplyTheme(): ResolvedTheme {
  const resolved = useResolvedTheme();
  useEffect(() => applyTheme(resolved), [resolved]);
  return resolved;
}
