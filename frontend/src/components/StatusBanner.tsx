/**
 * The main status banner (Section 27).
 *
 * This is the single most important element in the interface. It answers, at a
 * glance and from across the bridge: can I trust the position, what is keeping
 * it, how large is the bound, and is the 2 m requirement met?
 *
 * Every field carries a word as well as a colour, and the critical state is
 * visually unmistakable rather than merely red.
 */

import { useAppSelector } from '../store';
import type { NavigationOutput } from '../types';
import { INTEGRITY_PRESENTATION, REQUIREMENT_PRESENTATION, TRUST_PRESENTATION, modePresentation } from '../utils/status';
import { metres, simClock, EM_DASH } from '../utils/format';

function StaleIndicator() {
  const { lastFrameAt, connection } = useAppSelector((s) => s.live);
  const ageS = lastFrameAt ? (Date.now() - lastFrameAt) / 1000 : null;
  const stale = connection !== 'open' || (ageS !== null && ageS > 3);
  if (!stale) return null;
  return (
    <div className="flex items-center gap-2 rounded border border-caution/50 bg-caution/15 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-caution">
      <span aria-hidden>▲</span>
      <span>
        {connection === 'open'
          ? `Data ${ageS === null ? '' : `${ageS.toFixed(0)} s `}stale`
          : 'Live link down — displayed data is not current'}
      </span>
    </div>
  );
}

export function StatusBanner({ navigation }: { navigation: NavigationOutput | null }) {
  const scenario = useAppSelector((s) => s.live.scenario);

  if (!navigation) {
    return (
      <div className="panel border-bridge-700 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="readout-label">Trusted navigation</p>
            <p className="mt-1 text-xl font-semibold text-bridge-300">NOT AVAILABLE</p>
          </div>
          <p className="max-w-lg text-xs leading-relaxed text-bridge-400">
            No navigation solution is being produced. Start a scenario or a replay from the Replay &amp; Scenario
            screen to begin.
          </p>
        </div>
      </div>
    );
  }

  const requirement = REQUIREMENT_PRESENTATION[navigation.integrity.requirement_status];
  const integrity = INTEGRITY_PRESENTATION[navigation.integrity.integrity_status];
  const mode = modePresentation(navigation.navigation_mode);
  const trust = TRUST_PRESENTATION[navigation.gnss.status];
  const hpl = navigation.integrity.horizontal_protection_level_m;
  const limit = navigation.integrity.requirement_limit_m;

  const critical =
    navigation.integrity.integrity_status === 'NOT_ASSURED' ||
    navigation.integrity.requirement_status === 'REQUIREMENT_NOT_MET';

  const available = navigation.solution_available;

  return (
    <div
      className={`panel px-4 py-3 ${critical ? 'border-critical/60 shadow-glow-critical' : available ? 'border-bridge-700' : 'border-caution/50'}`}
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        {/* Trusted navigation availability */}
        <div className="min-w-[11rem]">
          <p className="readout-label">Trusted navigation</p>
          <p
            className={`mt-1 text-2xl font-bold leading-none tracking-tight ${
              available ? (critical ? 'text-caution' : 'text-assured') : 'text-critical'
            }`}
          >
            {available ? 'AVAILABLE' : 'UNAVAILABLE'}
          </p>
          <p className="mt-1.5 text-2xs text-bridge-400">
            Confidence {(navigation.solution_confidence * 100).toFixed(0)}%
          </p>
        </div>

        {/* Mode */}
        <div className="min-w-[13rem]">
          <p className="readout-label">Mode</p>
          <p className={`mt-1 text-lg font-bold uppercase leading-tight ${mode.text}`}>
            <span aria-hidden className="mr-1.5">
              {mode.glyph}
            </span>
            {mode.label}
          </p>
          <p className="mt-1 text-2xs text-bridge-400">
            {navigation.navigation_mode_detail?.expected_accuracy ?? EM_DASH}
          </p>
        </div>

        {/* GNSS */}
        <div className="min-w-[14rem]">
          <p className="readout-label">GNSS</p>
          <p className={`mt-1 text-lg font-bold uppercase leading-tight ${trust.text}`}>
            <span aria-hidden className="mr-1.5">
              {trust.glyph}
            </span>
            {trust.label}
            <span className="ml-2 font-mono text-sm font-normal text-bridge-300">
              {navigation.gnss.trust_score.toFixed(0)}/100
            </span>
          </p>
          <p className="mt-1 max-w-sm truncate text-2xs text-bridge-400" title={navigation.gnss.explanation}>
            {navigation.gnss.detected_conditions.length > 0
              ? navigation.gnss.detected_conditions.slice(0, 2).join(', ').replace(/_/g, ' ')
              : navigation.gnss.used_in_fusion
                ? 'Contributing to the solution'
                : 'Not contributing'}
          </p>
        </div>

        {/* Protection level */}
        <div className="min-w-[11rem]">
          <p className="readout-label">Horizontal protection level</p>
          <p
            className={`mt-1 font-mono text-2xl font-bold tabular-nums leading-none ${
              hpl === null ? 'text-unknown' : hpl > limit ? 'text-critical' : hpl > limit * 0.75 ? 'text-caution' : 'text-assured'
            }`}
          >
            {hpl === null ? EM_DASH : hpl.toFixed(2)}
            <span className="ml-1 text-sm font-normal text-bridge-400">m</span>
          </p>
          <p className="mt-1 text-2xs text-bridge-400">
            at {(navigation.integrity.requirement_confidence * 100).toFixed(0)}% confidence · limit {limit} m
          </p>
        </div>

        {/* Requirement */}
        <div className="min-w-[13rem]">
          <p className="readout-label">Safeen &lt;{limit} m requirement</p>
          <p className={`mt-1 text-2xl font-bold uppercase leading-none ${requirement.text}`}>
            <span aria-hidden className="mr-1.5">
              {requirement.glyph}
            </span>
            {requirement.short}
          </p>
          <p className="mt-1 text-2xs text-bridge-400">
            Integrity: <span className={integrity.text}>{integrity.short}</span>
          </p>
        </div>

        {/* Clock and link health */}
        <div className="ml-auto flex flex-col items-end gap-2">
          <StaleIndicator />
          <div className="text-right">
            <p className="readout-label">Scenario time</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-bridge-100">
              {simClock(navigation.time_s)}
            </p>
            <p className="mt-0.5 text-2xs text-bridge-500">
              {scenario?.scenario_name ?? scenario?.scenario_id ?? 'No scenario'}
              {scenario?.speed_multiplier && scenario.speed_multiplier !== 1 ? ` · ${scenario.speed_multiplier}×` : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Operator guidance: shown whenever the situation is anything but normal. */}
      {(critical || navigation.integrity.requirement_status === 'REQUIREMENT_AT_RISK') && (
        <div
          className={`mt-3 flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 ${
            critical ? 'border-critical/50 bg-critical/10' : 'border-caution/50 bg-caution/10'
          }`}
        >
          <span aria-hidden className={critical ? 'text-critical' : 'text-caution'}>
            {critical ? '✕' : '▲'}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-semibold uppercase tracking-wide ${critical ? 'text-critical' : 'text-caution'}`}>
              Operator action
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-bridge-100">
              {navigation.navigation_mode_detail?.operator_guidance ??
                'Verify position using independent means.'}
            </p>
            {navigation.integrity.requirement_reasons.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {navigation.integrity.requirement_reasons.map((reason, i) => (
                  <li key={i} className="text-xs leading-relaxed text-bridge-300">
                    · {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact single-line variant used in the header on narrow screens. */
/**
 * Header status.
 *
 * Falls back to fleet health when no single vessel is under detailed
 * examination. On a fleet product the header should never be dead space: an
 * operator glancing up wants to know whether anything needs them, and "No
 * solution" answers a question nobody asked.
 */
/** Fleet-wide counts, shown in the header when no vessel is focused. */
function FleetHealth() {
  const fleet = useAppSelector((s) => s.live.fleet);
  if (!fleet || fleet.counts.total === 0) {
    return <span className="text-xs text-bridge-400">No vessels monitored</span>;
  }
  const { counts } = fleet;
  const needsAttention = counts.requirement_not_met + counts.integrity_not_assured;
  return (
    <div className="flex items-center gap-2" title="Fleet requirement status">
      <span className="chip border-bridge-600 bg-bridge-800 text-bridge-300">
        <span aria-hidden>⛴</span>
        {counts.total} VESSELS
      </span>
      <span className="chip border-assured/50 bg-assured/15 text-assured">
        <span aria-hidden>✓</span>
        {counts.requirement_met} MET
      </span>
      {counts.requirement_at_risk > 0 && (
        <span className="chip border-caution/50 bg-caution/15 text-caution">
          <span aria-hidden>▲</span>
          {counts.requirement_at_risk} AT RISK
        </span>
      )}
      {needsAttention > 0 && (
        <span className="chip border-critical/50 bg-critical/15 text-critical">
          <span aria-hidden>✕</span>
          {needsAttention} NEEDS ATTENTION
        </span>
      )}
    </div>
  );
}

export function CompactStatus({ navigation }: { navigation: NavigationOutput | null }) {
  if (!navigation) return <FleetHealth />;
  const requirement = REQUIREMENT_PRESENTATION[navigation.integrity.requirement_status];
  const mode = modePresentation(navigation.navigation_mode);
  return (
    <div className="flex items-center gap-2">
      <span className={`chip ${mode.bg} ${mode.border} ${mode.text}`}>
        <span aria-hidden>{mode.glyph}</span>
        {mode.label}
      </span>
      <span className={`chip ${requirement.bg} ${requirement.border} ${requirement.text}`}>
        <span aria-hidden>{requirement.glyph}</span>
        {requirement.short}
      </span>
      <span className="font-mono text-xs tabular-nums text-bridge-200">
        HPL {metres(navigation.integrity.horizontal_protection_level_m)}
      </span>
    </div>
  );
}
