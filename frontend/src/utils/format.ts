/**
 * Display formatting.
 *
 * The rule throughout: a value that does not exist is shown as an em dash, not
 * as zero. On a navigation display "0.00 m" and "not available" mean very
 * different things, and confusing them is how an operator ends up trusting a
 * number that was never computed.
 */

export const EM_DASH = '—';

export function metres(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(decimals)} m`;
}

export function number(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(decimals);
}

export function percent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(decimals)} %`;
}

export function degrees(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(decimals)}°`;
}

/** Heading as a three-digit bearing, the way a bridge display shows it. */
export function bearing(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const normalised = ((value % 360) + 360) % 360;
  return `${normalised.toFixed(1).padStart(5, '0')}°`;
}

export function speed(value: number | null | undefined, units: 'metric' | 'nautical' = 'metric'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return units === 'nautical' ? `${(value * 1.943844).toFixed(2)} kn` : `${value.toFixed(2)} m/s`;
}

export function distance(value: number | null | undefined, units: 'metric' | 'nautical' = 'metric'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  if (units === 'nautical' && Math.abs(value) >= 185.2) return `${(value / 1852).toFixed(3)} NM`;
  return `${value.toFixed(1)} m`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Scenario clock as mm:ss.d */
export function simClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH;
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Latitude/longitude in degrees and decimal minutes, as used at sea. */
export function latitudeDm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const hemisphere = value >= 0 ? 'N' : 'S';
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(2, '0')}° ${min.toFixed(4).padStart(7, '0')}′ ${hemisphere}`;
}

export function longitudeDm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const hemisphere = value >= 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(3, '0')}° ${min.toFixed(4).padStart(7, '0')}′ ${hemisphere}`;
}

export function timestamp(value: string | null | undefined, withDate = false): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const time = date.toISOString().slice(11, 19);
  return withDate ? `${date.toISOString().slice(0, 10)} ${time}Z` : `${time}Z`;
}

export function relativeTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (Number.isNaN(ms)) return EM_DASH;
  const delta = (Date.now() - ms) / 1000;
  if (delta < 1) return 'now';
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Convert an UPPER_SNAKE code into readable Title Case. */
export function humanise(code: string | null | undefined): string {
  if (!code) return EM_DASH;
  return code
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact number for tiles (1.2k, 3.4M). */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
