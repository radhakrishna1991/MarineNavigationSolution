/**
 * Status vocabulary: the single place that maps a backend status onto how the
 * interface presents it.
 *
 * Every entry carries a `glyph` and a `label` as well as colour classes. The
 * specification requires that colour is not the only indicator, so no component
 * is allowed to render a status as a bare coloured dot - the glyph and label
 * travel with it.
 */

import type { AlarmSeverity, IntegrityStatus, NavigationMode, RequirementStatus, GnssTrustStatus } from '../types';

export interface StatusPresentation {
  label: string;
  short: string;
  glyph: string;
  text: string;
  bg: string;
  border: string;
  ring: string;
  /** Plain-language meaning, used in tooltips and the legend. */
  meaning: string;
}

export const REQUIREMENT_PRESENTATION: Record<RequirementStatus, StatusPresentation> = {
  REQUIREMENT_MET: {
    label: 'Requirement met',
    short: 'MET',
    glyph: '✓',
    text: 'text-assured',
    bg: 'bg-assured/15',
    border: 'border-assured/50',
    ring: 'ring-assured/40',
    meaning: 'The horizontal error is bounded below the limit at the stated confidence, with an independent absolute source valid.'
  },
  REQUIREMENT_AT_RISK: {
    label: 'Requirement at risk',
    short: 'AT RISK',
    glyph: '▲',
    text: 'text-caution',
    bg: 'bg-caution/15',
    border: 'border-caution/50',
    ring: 'ring-caution/40',
    meaning: 'Still met, but the margin is thin, redundancy is absent, or the uncertainty is growing quickly.'
  },
  REQUIREMENT_NOT_MET: {
    label: 'Requirement NOT met',
    short: 'NOT MET',
    glyph: '✕',
    text: 'text-critical',
    bg: 'bg-critical/15',
    border: 'border-critical/50',
    ring: 'ring-critical/40',
    meaning: 'The error cannot be bounded below the limit. Verify position by independent means.'
  },
  INSUFFICIENT_INFORMATION: {
    label: 'Insufficient information',
    short: 'UNKNOWN',
    glyph: '?',
    text: 'text-unknown',
    bg: 'bg-unknown/15',
    border: 'border-unknown/50',
    ring: 'ring-unknown/40',
    meaning: 'The measurements needed to answer the question are missing. No claim is being made either way.'
  }
};

export const INTEGRITY_PRESENTATION: Record<IntegrityStatus, StatusPresentation> = {
  ASSURED: {
    label: 'Integrity assured',
    short: 'ASSURED',
    glyph: '✓',
    text: 'text-assured',
    bg: 'bg-assured/15',
    border: 'border-assured/50',
    ring: 'ring-assured/40',
    meaning: 'The error is bounded and the bound is being monitored.'
  },
  DEGRADED: {
    label: 'Integrity degraded',
    short: 'DEGRADED',
    glyph: '▲',
    text: 'text-caution',
    bg: 'bg-caution/15',
    border: 'border-caution/50',
    ring: 'ring-caution/40',
    meaning: 'The error is still bounded, but with reduced redundancy or an unresolved fault.'
  },
  NOT_ASSURED: {
    label: 'INTEGRITY NOT ASSURED',
    short: 'NOT ASSURED',
    glyph: '✕',
    text: 'text-critical',
    bg: 'bg-critical/15',
    border: 'border-critical/50',
    ring: 'ring-critical/40',
    meaning: 'The error cannot be bounded. The displayed position may be wrong by an unknown amount.'
  },
  UNKNOWN: {
    label: 'Integrity unknown',
    short: 'UNKNOWN',
    glyph: '?',
    text: 'text-unknown',
    bg: 'bg-unknown/15',
    border: 'border-unknown/50',
    ring: 'ring-unknown/40',
    meaning: 'Integrity could not be evaluated, usually because the solution is too old or time sync is invalid.'
  }
};

export const TRUST_PRESENTATION: Record<GnssTrustStatus, StatusPresentation> = {
  TRUSTED: {
    label: 'Trusted',
    short: 'TRUSTED',
    glyph: '✓',
    text: 'text-assured',
    bg: 'bg-assured/15',
    border: 'border-assured/50',
    ring: 'ring-assured/40',
    meaning: 'GNSS is consistent with every independent measurement.'
  },
  ACCEPTABLE: {
    label: 'Acceptable',
    short: 'ACCEPTABLE',
    glyph: '✓',
    text: 'text-assured',
    bg: 'bg-assured/10',
    border: 'border-assured/35',
    ring: 'ring-assured/30',
    meaning: 'GNSS is usable with minor quality reductions.'
  },
  DEGRADED: {
    label: 'Degraded',
    short: 'DEGRADED',
    glyph: '▲',
    text: 'text-caution',
    bg: 'bg-caution/15',
    border: 'border-caution/50',
    ring: 'ring-caution/40',
    meaning: 'GNSS is used but de-weighted; its quality or cross-checks are marginal.'
  },
  HIGHLY_SUSPECT: {
    label: 'Highly suspect',
    short: 'SUSPECT',
    glyph: '⚠',
    text: 'text-alert',
    bg: 'bg-alert/15',
    border: 'border-alert/50',
    ring: 'ring-alert/40',
    meaning: 'GNSS shows behaviour that a healthy receiver should not produce. It is excluded.'
  },
  REJECTED: {
    label: 'Rejected',
    short: 'REJECTED',
    glyph: '✕',
    text: 'text-critical',
    bg: 'bg-critical/15',
    border: 'border-critical/50',
    ring: 'ring-critical/40',
    meaning: 'GNSS is excluded from the navigation solution entirely.'
  }
};

export const SEVERITY_PRESENTATION: Record<AlarmSeverity, StatusPresentation> = {
  CRITICAL: {
    label: 'Critical',
    short: 'CRIT',
    glyph: '✕',
    text: 'text-critical',
    bg: 'bg-critical/15',
    border: 'border-critical/50',
    ring: 'ring-critical/40',
    meaning: 'Immediate operator action is required.'
  },
  WARNING: {
    label: 'Warning',
    short: 'WARN',
    glyph: '⚠',
    text: 'text-alert',
    bg: 'bg-alert/15',
    border: 'border-alert/50',
    ring: 'ring-alert/40',
    meaning: 'A condition that will require action if it continues.'
  },
  ADVISORY: {
    label: 'Advisory',
    short: 'ADV',
    glyph: '▲',
    text: 'text-caution',
    bg: 'bg-caution/15',
    border: 'border-caution/50',
    ring: 'ring-caution/40',
    meaning: 'Awareness only; no immediate action.'
  },
  INFO: {
    label: 'Information',
    short: 'INFO',
    glyph: 'i',
    text: 'text-info',
    bg: 'bg-info/15',
    border: 'border-info/50',
    ring: 'ring-info/40',
    meaning: 'A recorded event with no operational consequence.'
  }
};

/** Mode presentation: which are healthy, which are degraded, which are alarms. */
const MODE_TONE: Record<NavigationMode, 'assured' | 'aided' | 'caution' | 'critical'> = {
  NORMAL_GNSS: 'assured',
  GNSS_DEGRADED: 'caution',
  SPOOFING_SUSPECTED: 'critical',
  JAMMING_SUSPECTED: 'caution',
  GNSS_REJECTED: 'caution',
  RADAR_AIDED_NAVIGATION: 'aided',
  BATHYMETRIC_AIDED_NAVIGATION: 'aided',
  LIDAR_AIDED_NAVIGATION: 'aided',
  DEAD_RECKONING: 'caution',
  INS_AIDED_NAVIGATION: 'caution',
  LOCAL_POSITIONING_MODE: 'aided',
  MANUAL_FALLBACK: 'critical',
  GNSS_RECOVERY_VALIDATION: 'aided',
  INTEGRITY_NOT_ASSURED: 'critical'
};

const TONE_CLASSES = {
  assured: { text: 'text-assured', bg: 'bg-assured/15', border: 'border-assured/50', ring: 'ring-assured/40', glyph: '✓' },
  aided: { text: 'text-info', bg: 'bg-info/15', border: 'border-info/50', ring: 'ring-info/40', glyph: '◈' },
  caution: { text: 'text-caution', bg: 'bg-caution/15', border: 'border-caution/50', ring: 'ring-caution/40', glyph: '▲' },
  critical: { text: 'text-critical', bg: 'bg-critical/15', border: 'border-critical/50', ring: 'ring-critical/40', glyph: '✕' }
} as const;

export const MODE_LABELS: Record<NavigationMode, string> = {
  NORMAL_GNSS: 'Normal GNSS',
  GNSS_DEGRADED: 'GNSS Degraded',
  SPOOFING_SUSPECTED: 'Spoofing Suspected',
  JAMMING_SUSPECTED: 'Jamming Suspected',
  GNSS_REJECTED: 'GNSS Rejected',
  RADAR_AIDED_NAVIGATION: 'Radar-Aided Navigation',
  BATHYMETRIC_AIDED_NAVIGATION: 'Bathymetric-Aided Navigation',
  LIDAR_AIDED_NAVIGATION: 'LiDAR-Aided Navigation',
  DEAD_RECKONING: 'Dead Reckoning',
  INS_AIDED_NAVIGATION: 'INS-Aided Navigation',
  LOCAL_POSITIONING_MODE: 'Local Positioning',
  MANUAL_FALLBACK: 'Manual Fallback',
  GNSS_RECOVERY_VALIDATION: 'GNSS Recovery Validation',
  INTEGRITY_NOT_ASSURED: 'Integrity Not Assured'
};

export function modePresentation(mode: NavigationMode): StatusPresentation {
  const tone = TONE_CLASSES[MODE_TONE[mode] ?? 'caution'];
  return {
    label: MODE_LABELS[mode] ?? mode,
    short: (MODE_LABELS[mode] ?? mode).toUpperCase(),
    glyph: tone.glyph,
    text: tone.text,
    bg: tone.bg,
    border: tone.border,
    ring: tone.ring,
    meaning: ''
  };
}

/** Colour for a GNSS trust score, matching the configured bands. */
export function trustBand(score: number | null | undefined): GnssTrustStatus {
  if (score === null || score === undefined) return 'REJECTED';
  if (score <= 20) return 'REJECTED';
  if (score <= 50) return 'HIGHLY_SUSPECT';
  if (score <= 75) return 'DEGRADED';
  if (score <= 90) return 'ACCEPTABLE';
  return 'TRUSTED';
}

/** Sensor decision presentation for the health table. */
export function sensorTone(excluded: boolean, online: boolean, faults: string[]): StatusPresentation {
  if (excluded) {
    return { ...SEVERITY_PRESENTATION.WARNING, label: 'Excluded', short: 'EXCLUDED', glyph: '✕' };
  }
  if (!online) {
    return { ...INTEGRITY_PRESENTATION.UNKNOWN, label: 'Offline', short: 'OFFLINE', glyph: '○' };
  }
  if (faults.length > 0) {
    return { ...SEVERITY_PRESENTATION.ADVISORY, label: 'Degraded', short: 'DEGRADED', glyph: '▲' };
  }
  return { ...INTEGRITY_PRESENTATION.ASSURED, label: 'Healthy', short: 'HEALTHY', glyph: '✓' };
}

/** Map colours used for the different position sources. */
/**
 * Source identity colours now come from the theme, because they differ between
 * the dark and light palettes: the same amber that reads well on a dark ground
 * is illegible on white. `sourceColours()` returns the set for whichever theme
 * is in force; the identity - which colour means which source - does not change.
 */
export { sourceColours, type SourceKey } from '../theme/theme';

export const SOURCE_LABELS = {
  fused: 'Trusted fused position',
  truth: 'Ground truth (simulation only)',
  gnss: 'Raw GNSS position',
  radar: 'Radar map match',
  lidar: 'LiDAR map match',
  bathymetric: 'Bathymetric match',
  deadReckoning: 'Dead reckoning',
  localRanging: 'Local ranging'
} as const;
